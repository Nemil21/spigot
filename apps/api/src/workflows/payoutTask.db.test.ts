import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { twoPools, testDatabaseUrl, type TwoPools } from '../db/test-db.js';
import { createDb, type Db } from '../db/tx.js';
import { getOrCreateAccount, platformAccounts } from '../ledger/accounts.js';
import { ledgerCheck } from '../ledger/check.js';
import { post } from '../ledger/ledger.js';
import { chargeEntries, topupEntries } from '../ledger/postings.js';
import { FakePayPalExtras } from '../paypal/fake/extras.js';
import { moneyOut } from '../paypal/moneyOut.js';
import type { PayoutsPayPal } from '../payouts/deps.js';
import { payoutRun } from '../payouts/payoutRun.js';
import { dispatch, type WorkflowsStartClient } from './dispatch.js';
import { workflowTaskBodies, type PayoutTaskArgs, type PayoutTaskResult } from './runtime.js';

/**
 * SP-041b acceptance: a `payoutRun` through Render Workflows on FakePayPal creates one batch.
 *
 * "Render" is a fake start client that runs the real task body (`workflowTaskBodies().payoutRun`)
 * the way the service would: arguments and result cross a JSON boundary, and the run starts after
 * the start call has returned. Races and a killed run are covered too (Render retries are off for
 * this task, so the "retry" of a killed run is the next `payoutRun`).
 */

const MERCHANT = 'merchant@spigot.example';
const WORKFLOWS = { WORKFLOWS_MODE: 'workflows' } as const;
const silentLog = { info() {}, warn() {}, error() {} } as never;

describe.skipIf(!testDatabaseUrl)(
  'payoutRun as a Render Workflows task (SP-041b)',
  { timeout: 30_000 },
  () => {
    let pools: TwoPools;
    let db: Db;
    let fake: FakePayPalExtras;
    let pp: PayoutsPayPal;

    beforeEach(async () => {
      pools = await twoPools();
      db = createDb(pools.a);
      fake = new FakePayPalExtras({ payouts: { merchantEmail: MERCHANT } });
      pp = moneyOut(fake.transport({ timeoutMs: 100 }), undefined);
    }, 30_000);
    afterEach(async () => {
      await pools?.close();
    }, 30_000);

    const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      (await pools.a.query(sql, params)).rows as T[];

    async function newPublisher(): Promise<string> {
      const [row] = await q<{ id: string }>(
        `INSERT INTO publishers (name, email, payout_email, payout_threshold_cents)
       VALUES ('Pub', $1, $2, 1000) RETURNING id`,
        [`${randomUUID()}@pub.example`, `${randomUUID()}@payee.example`],
      );
      return row!.id;
    }

    /** One charged API call of `priceMicros` (20% commission): the publisher's payable grows. */
    async function charge(publisherId: string, priceMicros: number): Promise<void> {
      await db.tx(async (tx) => {
        const platform = await platformAccounts(tx);
        const [b] = (await tx.query(`INSERT INTO buyers (name) VALUES ('B') RETURNING id`)).rows;
        const [k] = (
          await tx.query(
            `INSERT INTO api_keys (buyer_id, prefix, key_hash) VALUES ($1, 'sk_test', $2) RETURNING id`,
            [b.id, randomUUID()],
          )
        ).rows;
        const buyer = await getOrCreateAccount(tx, 'BUYER_BALANCE', b.id);
        const publisher = await getOrCreateAccount(tx, 'PUBLISHER_PAYABLE', publisherId);
        await post(tx, {
          kind: 'TOPUP',
          idempotencyKey: `topup:${randomUUID()}`,
          entries: topupEntries({ buyer, paypalCash: platform.paypalCash }, priceMicros),
        });
        const callId = randomUUID();
        const charged = await post(tx, {
          kind: 'CHARGE',
          idempotencyKey: `charge:${callId}`,
          refType: 'api_call',
          refId: callId,
          entries: chargeEntries(
            { buyer, publisher, platformRevenue: platform.platformRevenue },
            priceMicros,
            2000,
          ),
        });
        await tx.query(
          `INSERT INTO api_calls (id, buyer_id, api_key_id, channel, idempotency_key, status,
                                records_returned, price_micros, commission_bps, charge_txn_id)
         VALUES ($1, $2, $3, 'REST', $4, 'CHARGED', 100, $5, 2000, $6)`,
          [callId, b.id, k.id, callId, priceMicros, charged.txn.id],
        );
      });
    }

    const batches = () =>
      q<{ id: string; status: string; period_end: Date | null }>(
        'SELECT id, status, period_end FROM payout_batches ORDER BY created_at',
      );
    const itemCount = async () =>
      (await q<{ n: number }>('SELECT count(*)::int AS n FROM payout_items'))[0]!.n;
    const expectLedgerOk = async () => expect((await ledgerCheck(pools.a)).mismatches).toEqual([]);

    /**
     * Fake Render: each start runs the real `payoutRun` body as its own "task run" over `payouts`
     * (default the FakePayPal client). Input and result go through JSON like the real service.
     */
    function fakeRender(payouts: () => PayoutsPayPal = () => pp) {
      const runs: Promise<PayoutTaskResult>[] = [];
      const slugs: string[] = [];
      const client: WorkflowsStartClient = {
        startTask: async (slug, input) => {
          slugs.push(slug);
          const args = JSON.parse(JSON.stringify(input[0])) as PayoutTaskArgs;
          const bodies = workflowTaskBodies({
            db,
            crawlDeps: { db } as never,
            log: silentLog,
            payouts: payouts(),
          });
          runs.push(
            new Promise((r) => setTimeout(r, 5))
              .then(() => bodies.payoutRun(args))
              .then((res) => JSON.parse(JSON.stringify(res)) as PayoutTaskResult),
          );
          return { taskRunId: `trn-${runs.length}` };
        },
      };
      return { client, runs, slugs };
    }

    const start = (client: WorkflowsStartClient, args: PayoutTaskArgs) =>
      dispatch('payoutRun', { ...args }, { env: WORKFLOWS, client });

    it('a payoutRun through Workflows on FakePayPal creates one batch, one item per publisher', async () => {
      const a = await newPublisher();
      const b = await newPublisher();
      await charge(a, 20_000_000);
      await charge(b, 15_000_000);

      const render = fakeRender();
      const started = await start(render.client, { trigger: 'MANUAL_DEMO' });
      expect(started).toMatchObject({ mode: 'workflows', workflowRunId: 'trn-1', done: null });
      expect(render.slugs).toEqual(['spigot-workflows/payoutRun']);

      const result = await render.runs[0]!;
      const [batch] = await batches();
      expect(result).toEqual({
        outcome: 'PENDING',
        batchId: batch!.id,
        resumed: false,
        itemCount: 2,
        paypalBatchId: fake.payouts.batchBySenderId(batch!.id)!.id,
      });
      expect(await batches()).toHaveLength(1);
      expect(batch!.status).toBe('PENDING');
      expect(fake.payouts.batchesCreated).toBe(1);
      // Render keeps task results: ids and counts only, never a receiver email.
      expect(JSON.stringify(result)).not.toMatch(/@/);
      await expectLedgerOk();

      // The same task again: nothing new to pay.
      await start(render.client, { trigger: 'MANUAL_DEMO' });
      expect(await render.runs[1]!).toMatchObject({
        outcome: 'NO_ITEMS',
        batchId: null,
        itemCount: 0,
      });
      expect(fake.payouts.batchesCreated).toBe(1);
    });

    it('race: two Workflows runs + "Run payout now" in process at once → one batch, one payout', async () => {
      const a = await newPublisher();
      await charge(a, 20_000_000);

      const render = fakeRender();
      await Promise.all([
        start(render.client, { trigger: 'MANUAL_DEMO' }),
        start(render.client, { trigger: 'MANUAL_DEMO' }),
      ]);
      const inproc = payoutRun({ trigger: 'MANUAL_DEMO' }, { pool: pools.b, pp, retryDelayMs: 0 });
      const outcomes = [
        ...(await Promise.all(render.runs)).map((r) => r.outcome),
        (await inproc).outcome,
      ];

      expect(outcomes.filter((o) => o === 'PENDING')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'NO_ITEMS')).toHaveLength(2);
      expect(await batches()).toHaveLength(1);
      expect(await itemCount()).toBe(1);
      expect(fake.payouts.batchesCreated).toBe(1);
      await expectLedgerOk();
    });

    it('a run killed before PayPal answered: the next task run resumes the same sender_batch_id; one payout', async () => {
      const a = await newPublisher();
      await charge(a, 20_000_000);

      // The killed run: PAYOUT_SENT is posted and the batch is built, then the process dies on the
      // PayPal call (before PayPal saw it). Render does not retry this task.
      const dying: PayoutsPayPal = {
        ...pp,
        payout: async () => {
          throw new Error('process killed');
        },
      };
      const killed = fakeRender(() => dying);
      await start(killed.client, { trigger: 'MANUAL_DEMO' });
      await expect(killed.runs[0]!).rejects.toThrow(/process killed/);
      const [built] = await batches();
      expect(built!.status).not.toBe('PENDING');
      expect(fake.payouts.batchesCreated).toBe(0);

      const render = fakeRender();
      await start(render.client, { trigger: 'MANUAL_DEMO' });
      expect(await render.runs[0]!).toMatchObject({
        outcome: 'PENDING',
        resumed: true,
        batchId: built!.id,
        itemCount: 1,
      });
      expect(fake.payouts.batchBySenderId(built!.id)).toBeDefined();
      expect(fake.payouts.batchesCreated).toBe(1);
      expect(await batches()).toHaveLength(1);
      await expectLedgerOk();
    });

    it('SCHEDULE: periodEnd crosses JSON as ISO 8601; a second start for the same period builds nothing', async () => {
      const a = await newPublisher();
      await charge(a, 20_000_000);
      const periodEnd = '2026-11-16T17:00:00.000Z';

      const render = fakeRender();
      await start(render.client, { trigger: 'SCHEDULE', periodEnd });
      expect(await render.runs[0]!).toMatchObject({ outcome: 'PENDING', itemCount: 1 });
      await start(render.client, { trigger: 'SCHEDULE', periodEnd });
      expect((await render.runs[1]!).outcome).toMatch(/^(PERIOD_TAKEN|NO_ITEMS)$/);

      const all = await batches();
      expect(all).toHaveLength(1);
      expect(new Date(all[0]!.period_end!).toISOString()).toBe(periodEnd);
      expect(fake.payouts.batchesCreated).toBe(1);
    });

    it('a bad periodEnd fails the run before anything is built', async () => {
      const a = await newPublisher();
      await charge(a, 20_000_000);
      const render = fakeRender();
      await start(render.client, { trigger: 'SCHEDULE', periodEnd: 'next monday' });
      await expect(render.runs[0]!).rejects.toThrow(TypeError);
      expect(await batches()).toHaveLength(0);
      expect(fake.payouts.batchesCreated).toBe(0);
    });

    it('bodies without a payouts client refuse payoutRun', () => {
      const bodies = workflowTaskBodies({ db, crawlDeps: { db } as never, log: silentLog });
      expect(() => bodies.payoutRun({ trigger: 'MANUAL_DEMO' })).toThrow(/rt.payouts/);
    });
  },
);
