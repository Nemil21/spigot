import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { twoPools, testDatabaseUrl } from '../db/test-db.js';
import { createDb } from '../db/tx.js';
import { getOrCreateAccount, platformAccounts } from '../ledger/accounts.js';
import { ledgerCheck } from '../ledger/check.js';
import { post } from '../ledger/ledger.js';
import { chargeEntries, topupEntries } from '../ledger/postings.js';
import { fetchTransport } from '../paypal/fake/extras.js';
import { moneyOut } from '../paypal/moneyOut.js';
import { payoutRun } from './payoutRun.js';
import { pollBatch } from './poll.js';

/**
 * SP-021's one sandbox run, by hand, never in CI:
 *   PAYPAL_MODE=sandbox TEST_DATABASE_URL=… npx vitest run --project db apps/api/src/payouts/poll.sandbox.db.test.ts
 * Run now ($1 demo threshold) → one batch with two $1.60 items: the separate publisher account
 * (DEMO_PUBLISHER_PAYOUT_EMAIL) and an unregistered email (S10) → poll (every 10 s here; the job
 * polls every 60 s) until PayPal settles: publisher item SUCCESS with fee_cents, unregistered item
 * UNCLAIMED and still in flight, ledger check passes, in-flight = the unclaimed $1.60 only.
 */
const enabled = process.env.PAYPAL_MODE === 'sandbox' && !!testDatabaseUrl;

if (!enabled) {
  describe.skip('payout poll: PayPal sandbox (set PAYPAL_MODE=sandbox and TEST_DATABASE_URL)', () => {
    it('skipped', () => {});
  });
} else {
  const envFile = fileURLToPath(new URL('../../../../.env', import.meta.url));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const base = (process.env.PAYPAL_API_BASE ?? '').replace(/\/+$/, '');
  if (!/^https:\/\/api(-m)?\.sandbox\.paypal\.com$/.test(base)) {
    throw new Error('PAYPAL_API_BASE must be the PayPal sandbox for this test');
  }
  const payoutEmail = process.env.DEMO_PUBLISHER_PAYOUT_EMAIL ?? process.env.PAYPAL_BRAND_EMAIL;
  if (!payoutEmail) throw new Error('set DEMO_PUBLISHER_PAYOUT_EMAIL (or PAYPAL_BRAND_EMAIL)');

  let token: Promise<string> | undefined;
  const getToken = () =>
    (token ??= (async () => {
      const basic = Buffer.from(
        `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`,
      ).toString('base64');
      const res = await fetch(`${base}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      });
      const json = (await res.json()) as { access_token?: string };
      if (!res.ok || !json.access_token) throw new Error(`token: HTTP ${res.status}`);
      return json.access_token;
    })());
  const authedFetch: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${await getToken()}`);
    return fetch(input, { ...init, headers });
  };

  describe('payout poll: PayPal sandbox', () => {
    it(
      'run now → PENDING → SUCCESS within the poll window; UNCLAIMED stays in flight',
      async () => {
        const pools = await twoPools();
        try {
          const db = createDb(pools.a);
          const unregistered = `spigot-unclaimed-${randomUUID().slice(0, 8)}@example.com`;
          const publisherIds: string[] = [];
          for (const email of [payoutEmail, unregistered]) {
            publisherIds.push(
              await db.tx(async (tx) => {
                const [p] = (
                  await tx.query(
                    `INSERT INTO publishers (name, email, payout_email) VALUES ('Sandbox pub', $1, $2) RETURNING id`,
                    [`${randomUUID()}@pub.example`, email],
                  )
                ).rows;
                const platform = await platformAccounts(tx);
                const buyer = await getOrCreateAccount(tx, 'BUYER_BALANCE', randomUUID());
                const publisher = await getOrCreateAccount(tx, 'PUBLISHER_PAYABLE', p.id);
                await post(tx, {
                  kind: 'TOPUP',
                  idempotencyKey: `topup:${randomUUID()}`,
                  entries: topupEntries({ buyer, paypalCash: platform.paypalCash }, 2_000_000),
                });
                await post(tx, {
                  kind: 'CHARGE',
                  idempotencyKey: `charge:${randomUUID()}`,
                  entries: chargeEntries(
                    { buyer, publisher, platformRevenue: platform.platformRevenue },
                    2_000_000,
                    2000,
                  ),
                });
                return p.id as string;
              }),
            );
          }

          const pp = moneyOut(fetchTransport(authedFetch, base, { timeoutMs: 30_000 }), undefined);
          const res = await payoutRun(
            'MANUAL_DEMO',
            { thresholdCentsOverride: 100 },
            { pool: pools.a, pp },
          );
          expect(res.outcome).toBe('PENDING');
          const batchId = res.batchId!;

          const started = Date.now();
          let status = 'PENDING';
          const seen: string[] = [];
          while (Date.now() - started < 30 * 60_000) {
            const r = await pollBatch({ pool: pools.a, pp }, batchId);
            seen.push(r!.paypalStatus);
            status = r!.batchStatus;
            const { rows } = await pools.a.query(
              `SELECT count(*)::int AS n FROM payout_items WHERE batch_id = $1 AND status = 'PENDING'`,
              [batchId],
            );
            if (rows[0].n === 0) break;
            await new Promise((r) => setTimeout(r, 10_000));
          }

          const { rows: items } = await pools.a.query(
            `SELECT publisher_id, status, fee_cents, paypal_item_id, error_code FROM payout_items
           WHERE batch_id = $1`,
            [batchId],
          );
          const byPub = Object.fromEntries(items.map((i) => [i.publisher_id, i]));
          expect(byPub[publisherIds[0]!]).toMatchObject({ status: 'SUCCESS', fee_cents: 25 });
          expect(byPub[publisherIds[1]!]).toMatchObject({
            status: 'UNCLAIMED',
            error_code: 'RECEIVER_UNREGISTERED',
          });
          expect(status).toBe('PROCESSING'); // in flight until the unclaimed item resolves
          const { rows: flight } = await pools.a.query(
            `SELECT coalesce(sum(balance_micros), 0)::bigint AS b FROM ledger_accounts WHERE kind = 'PAYOUTS_IN_FLIGHT'`,
          );
          expect(Number(flight[0].b)).toBe(1_600_000);
          expect((await ledgerCheck(pools.a)).mismatches).toEqual([]);
          // Evidence for the PR (ids and statuses only, no emails or secrets).
          console.info(
            `sandbox poll: sender_batch_id=${batchId} payout_batch_id=${res.outcome === 'PENDING' ? res.paypalBatchId : '?'} ` +
              `paypal statuses=${seen.join('→')} settled in ${Math.round((Date.now() - started) / 1000)} s ` +
              `items=${items.map((i) => `${i.paypal_item_id}:${i.status}`).join(',')}`,
          );
        } finally {
          await pools.close();
        }
      },
      35 * 60_000,
    );
  });
}
