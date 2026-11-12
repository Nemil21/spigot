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

/**
 * SP-020's one sandbox run, by hand, never in CI:
 *   PAYPAL_MODE=sandbox TEST_DATABASE_URL=… npx vitest run --project db apps/api/src/payouts/payoutRun.sandbox.db.test.ts
 * A $1.60 payout ($2.00 charged, 20% commission) to DEMO_PUBLISHER_PAYOUT_EMAIL (the separate
 * sandbox business account; paying the merchant itself fails SELF_PAY_NOT_ALLOWED) → 201 PENDING.
 * SP-001b's client replaces the token code below once it lands.
 */
const enabled = process.env.PAYPAL_MODE === 'sandbox' && !!testDatabaseUrl;

if (!enabled) {
  describe.skip('payoutRun: PayPal sandbox (set PAYPAL_MODE=sandbox and TEST_DATABASE_URL)', () => {
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

  describe('payoutRun: PayPal sandbox', () => {
    it('a $1.60 item to the separate publisher account → 201, batch PENDING', async () => {
      const pools = await twoPools();
      try {
        const db = createDb(pools.a);
        const publisherId = await db.tx(async (tx) => {
          const [p] = (
            await tx.query(
              `INSERT INTO publishers (name, email, payout_email) VALUES ('Sandbox pub', $1, $2) RETURNING id`,
              [`${randomUUID()}@pub.example`, payoutEmail],
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
        });

        const pp = moneyOut(fetchTransport(authedFetch, base, { timeoutMs: 30_000 }), undefined);
        const res = await payoutRun(
          'MANUAL_DEMO',
          { thresholdCentsOverride: 100 },
          { pool: pools.a, pp },
        );
        expect(res.outcome).toBe('PENDING');
        const { rows } = await pools.a.query(
          `SELECT b.status, b.paypal_batch_id, i.net_cents, i.status AS item_status
           FROM payout_batches b JOIN payout_items i ON i.batch_id = b.id WHERE i.publisher_id = $1`,
          [publisherId],
        );
        expect(rows).toEqual([
          expect.objectContaining({
            status: 'PENDING',
            net_cents: 160,
            item_status: 'PENDING',
            paypal_batch_id: expect.any(String),
          }),
        ]);
        expect((await ledgerCheck(pools.a)).mismatches).toEqual([]);
        // Evidence for the PR (ids only, no emails or secrets).
        console.info(
          `sandbox payout: sender_batch_id=${res.batchId} payout_batch_id=${rows[0].paypal_batch_id}`,
        );
      } finally {
        await pools.close();
      }
    }, 60_000);
  });
}
