import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { loadConfig } from '../config.js';
import { twoPools, testDatabaseUrl, type TwoPools } from '../db/test-db.js';
import { createDb, type Db } from '../db/tx.js';
import { getOrCreateAccount, platformAccounts } from '../ledger/accounts.js';
import { ledgerCheck } from '../ledger/check.js';
import { post } from '../ledger/ledger.js';
import { chargeEntries, topupEntries } from '../ledger/postings.js';
import type { PayoutDeps } from '../payouts/deps.js';
import { payoutRun } from '../payouts/payoutRun.js';
import { pollBatch } from '../payouts/poll.js';
import { FAKE_WEBHOOK_ID, FakePayPal, centsToDecimal } from '../paypal/index.js';
import { moneyOut } from '../paypal/moneyOut.js';
import { REQUIRED_ENV } from '../test/env.js';
import {
  loadWebhookHandlers,
  parsePayPalEvent,
  processPendingWebhooks,
  recordWebhookEvent,
  type WebhookContext,
  type WebhookHandler,
} from './paypal.js';

/**
 * SP-059 payout webhooks on Postgres + FakePayPal: `PAYMENT.PAYOUTS-ITEM.SUCCEEDED` settles an
 * item once even racing the poller, and resolves SP-020's `needs_reconcile` batch from the
 * event's `sender_batch_id` / `payout_batch_id`.
 */

const MERCHANT = 'merchant@spigot.example';

describe.skipIf(!testDatabaseUrl)('SP-059 payout webhooks', { timeout: 60_000 }, () => {
  let pools: TwoPools;
  let db: Db;
  let fake: FakePayPal;
  let deps: PayoutDeps;
  let handlers: WebhookHandler[];

  beforeEach(async () => {
    pools = await twoPools();
    db = createDb(pools.a);
    fake = new FakePayPal({ extras: { payouts: { merchantEmail: MERCHANT } } });
    deps = { pool: pools.a, pp: moneyOut(fake.extras.transport({ timeoutMs: 1_000 }), undefined) };
    handlers = await loadWebhookHandlers();
  }, 30_000);
  afterEach(async () => {
    await pools?.close();
  }, 30_000);

  const ctx = (pool = pools.a): WebhookContext => ({
    db: createDb(pool),
    pp: fake.client(),
    config: loadConfig({ ...REQUIRED_ENV }),
    log: () => {},
  });
  const drain = (pool = pools.a) => processPendingWebhooks(ctx(pool), { handlers });

  /** Verify a fake delivery with the real `verifyWebhook` (raw body) and store it, as the route does. */
  async function receive(type: string, resource: Record<string, unknown>, id?: string) {
    const d = fake.emitWebhook(type, resource, id ? { id } : {});
    const verifier = moneyOut(fake.extras.transport(), FAKE_WEBHOOK_ID);
    expect(await verifier.verifyWebhook(d.headers, d.rawBody)).toBe(true);
    return {
      id: d.event.id,
      recorded: await recordWebhookEvent(pools.a, parsePayPalEvent(JSON.parse(d.rawBody))!),
    };
  }

  async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await pools.a.query(sql, params)).rows as T[];
  }

  async function newPublisher(): Promise<string> {
    const [row] = await q<{ id: string }>(
      `INSERT INTO publishers (name, email, payout_email) VALUES ('Pub', $1, $2) RETURNING id`,
      [`${randomUUID()}@pub.example`, `${randomUUID()}@payee.example`],
    );
    return row!.id;
  }

  async function charge(publisherId: string, priceMicros: number): Promise<void> {
    await db.tx(async (tx) => {
      const platform = await platformAccounts(tx);
      const [b] = (await tx.query(`INSERT INTO buyers (name) VALUES ('B') RETURNING id`)).rows;
      const buyer = await getOrCreateAccount(tx, 'BUYER_BALANCE', b.id);
      const publisher = await getOrCreateAccount(tx, 'PUBLISHER_PAYABLE', publisherId);
      await post(tx, {
        kind: 'TOPUP',
        idempotencyKey: `topup:${randomUUID()}`,
        entries: topupEntries({ buyer, paypalCash: platform.paypalCash }, priceMicros),
      });
      await post(tx, {
        kind: 'CHARGE',
        idempotencyKey: `charge:${randomUUID()}`,
        entries: chargeEntries(
          { buyer, publisher, platformRevenue: platform.platformRevenue },
          priceMicros,
          2000,
        ),
      });
    });
  }

  /** Charge, run a payout, and return the PENDING batch and its one item. */
  async function runFor(publisherId: string) {
    await charge(publisherId, 15_000_000); // $12.00 payable
    const res = await payoutRun({ trigger: 'MANUAL_DEMO' }, { ...deps, retryDelayMs: 0 });
    expect(res.outcome).toBe('PENDING');
    const batchId = res.batchId!;
    const [item] = await q<{ id: string; net_cents: number }>(
      `SELECT id, net_cents FROM payout_items WHERE batch_id = $1`,
      [batchId],
    );
    const paypalBatchId = fake.extras.payouts.batchBySenderId(batchId)!.id;
    return { batchId, itemId: item!.id, netCents: item!.net_cents, paypalBatchId };
  }

  /** PayPal's `PAYMENT.PAYOUTS-ITEM.*` resource for our item (fake item + `sender_batch_id`). */
  function itemResource(b: { batchId: string; itemId: string; paypalBatchId: string }) {
    const it = fake.extras.payouts
      .itemsOf(b.paypalBatchId)
      .find((i) => i.senderItemId === b.itemId)!;
    return {
      payout_item_id: it.id,
      transaction_id: `T${it.id}`,
      transaction_status: it.status,
      payout_item_fee: { currency: 'USD', value: '0.25' },
      payout_batch_id: b.paypalBatchId,
      sender_batch_id: b.batchId,
      payout_item: {
        recipient_type: 'EMAIL',
        amount: { currency: 'USD', value: centsToDecimal(it.amountCents) },
        receiver: it.receiver,
        sender_item_id: b.itemId,
      },
    };
  }

  const txnCount = async (key: string) =>
    Number(
      (
        await q<{ n: string }>(`SELECT count(*) AS n FROM ledger_txns WHERE idempotency_key = $1`, [
          key,
        ])
      )[0]!.n,
    );
  const batch = async (id: string) =>
    (
      await q<{ status: string; paypal_batch_id: string | null; needs_reconcile: boolean }>(
        `SELECT status, paypal_batch_id, needs_reconcile FROM payout_batches WHERE id = $1`,
        [id],
      )
    )[0]!;
  const itemRow = async (id: string) =>
    (
      await q<{ status: string; fee_cents: number | null; paypal_item_id: string | null }>(
        `SELECT status, fee_cents, paypal_item_id FROM payout_items WHERE id = $1`,
        [id],
      )
    )[0]!;
  const expectLedgerOk = async () => expect((await ledgerCheck(pools.a)).mismatches).toEqual([]);

  /** SP-020's duplicate-without-id outcome: SUBMITTED, no paypal_batch_id, needs_reconcile. */
  const makeNeedsReconcile = (batchId: string) =>
    pools.a.query(
      `UPDATE payout_batches SET status = 'SUBMITTED', paypal_batch_id = NULL, needs_reconcile = true
       WHERE id = $1`,
      [batchId],
    );

  test('PAYOUTS-ITEM.SUCCEEDED → item SUCCESS, one PAYOUT_SETTLED; the same event again → processed once', async () => {
    const b = await runFor(await newPublisher());
    fake.extras.payouts.settleBatch(b.paypalBatchId);
    const first = await receive('PAYMENT.PAYOUTS-ITEM.SUCCEEDED', itemResource(b));
    expect(first.recorded).toBe('INSERTED');
    expect(
      (await receive('PAYMENT.PAYOUTS-ITEM.SUCCEEDED', itemResource(b), first.id)).recorded,
    ).toBe('DUPLICATE');
    const r = await drain();
    expect(r.processed).toHaveLength(1);
    expect(r.processed[0]!.results).toEqual({
      payouts: {
        result: 'APPLIED',
        batchId: b.batchId,
        reconciled: false,
        changed: true,
        itemStatus: 'SUCCESS',
        batchStatus: 'SUCCESS',
      },
    });
    expect(await itemRow(b.itemId)).toMatchObject({ status: 'SUCCESS', fee_cents: 25 });
    expect(await txnCount(`payout_settled:${b.itemId}`)).toBe(1);
    const [audit] = await q<{ actor_type: string; actor_id: string }>(
      `SELECT actor_type, actor_id FROM audit_events WHERE entity_id = $1 AND action = 'PAYOUT_SETTLED'`,
      [b.itemId],
    );
    expect(audit).toEqual({ actor_type: 'PAYPAL_WEBHOOK', actor_id: first.id });
    await expectLedgerOk();
  });

  test('race: webhook + poller for one payout item (two processes) → one PAYOUT_SETTLED', async () => {
    for (let round = 0; round < 3; round++) {
      const b = await runFor(await newPublisher());
      fake.extras.payouts.settleBatch(b.paypalBatchId);
      await receive('PAYMENT.PAYOUTS-ITEM.SUCCEEDED', itemResource(b));
      await receive('PAYMENT.PAYOUTS-ITEM.SUCCEEDED', itemResource(b)); // a second event id
      await Promise.all([
        pollBatch(deps, b.batchId),
        drain(pools.b),
        pollBatch({ ...deps, pool: pools.b }, b.batchId),
        drain(pools.a),
      ]);
      expect(await txnCount(`payout_settled:${b.itemId}`)).toBe(1);
      expect((await itemRow(b.itemId)).status).toBe('SUCCESS');
      expect((await batch(b.batchId)).status).toBe('SUCCESS');
      expect(await q(`SELECT 1 FROM webhook_events WHERE processed_at IS NULL`)).toEqual([]);
    }
    await expectLedgerOk();
  });

  test('PAYOUTS-ITEM.SUCCEEDED for a needs_reconcile batch fills paypal_batch_id and settles the item', async () => {
    const b = await runFor(await newPublisher());
    await makeNeedsReconcile(b.batchId);
    fake.extras.payouts.settleBatch(b.paypalBatchId);

    await receive('PAYMENT.PAYOUTS-ITEM.SUCCEEDED', itemResource(b));
    const r = await drain();
    expect(r.processed[0]!.results).toMatchObject({
      payouts: {
        result: 'APPLIED',
        reconciled: true,
        itemStatus: 'SUCCESS',
        batchStatus: 'SUCCESS',
      },
    });
    expect(await batch(b.batchId)).toEqual({
      status: 'SUCCESS',
      paypal_batch_id: b.paypalBatchId,
      needs_reconcile: false,
    });
    expect(await itemRow(b.itemId)).toMatchObject({ status: 'SUCCESS' });
    expect(await txnCount(`payout_settled:${b.itemId}`)).toBe(1);
    const sent = await q<{ actor_type: string; paypal_id: string }>(
      `SELECT actor_type, paypal_id FROM audit_events
        WHERE entity_id = $1 AND action = 'PAYOUT_SENT' AND actor_type = 'PAYPAL_WEBHOOK'`,
      [b.itemId],
    );
    expect(sent).toEqual([{ actor_type: 'PAYPAL_WEBHOOK', paypal_id: b.paypalBatchId }]);
    await expectLedgerOk();
  });

  test('a needs_reconcile event whose ids disagree is refused (nothing written); a batch event resolves it', async () => {
    const pub = await newPublisher();
    const b = await runFor(pub);
    const other = await runFor(await newPublisher());
    await makeNeedsReconcile(b.batchId);

    // Another batch's PayPal id with our sender_batch_id: that id is taken → refused.
    await receive('PAYMENT.PAYOUTS-ITEM.SUCCEEDED', {
      ...itemResource(b),
      payout_batch_id: other.paypalBatchId,
    });
    // Our item, but someone else's sender_batch_id → refused.
    await receive('PAYMENT.PAYOUTS-ITEM.SUCCEEDED', {
      ...itemResource(b),
      sender_batch_id: other.batchId,
    });
    let r = await drain();
    expect(r.processed.map((p) => (p.results.payouts as { result: string }).result)).toEqual([
      'BATCH_MISMATCH',
      'BATCH_MISMATCH',
    ]);
    expect(await batch(b.batchId)).toMatchObject({ status: 'SUBMITTED', needs_reconcile: true });

    await receive('PAYMENT.PAYOUTSBATCH.PROCESSING', {
      batch_header: {
        payout_batch_id: b.paypalBatchId,
        batch_status: 'PROCESSING',
        sender_batch_header: { sender_batch_id: b.batchId },
      },
    });
    r = await drain();
    expect(r.processed[0]!.results).toMatchObject({
      payouts: { result: 'APPLIED', reconciled: true, batchStatus: 'PROCESSING' },
    });
    expect(await batch(b.batchId)).toEqual({
      status: 'PROCESSING',
      paypal_batch_id: b.paypalBatchId,
      needs_reconcile: false,
    });
    // The poller can now finish it.
    fake.extras.payouts.settleBatch(b.paypalBatchId);
    await pollBatch(deps, b.batchId);
    expect((await batch(b.batchId)).status).toBe('SUCCESS');
    expect(await txnCount(`payout_settled:${b.itemId}`)).toBe(1);
    await expectLedgerOk();
  });

  test('an item event before our submit recorded the batch id is retried, then applied once', async () => {
    const b = await runFor(await newPublisher());
    // The 201 hasn't been handled yet: SUBMITTED, no PayPal id, not needs_reconcile.
    await pools.a.query(
      `UPDATE payout_batches SET status = 'SUBMITTED', paypal_batch_id = NULL WHERE id = $1`,
      [b.batchId],
    );
    fake.extras.payouts.settleBatch(b.paypalBatchId);
    const ev = await receive('PAYMENT.PAYOUTS-ITEM.SUCCEEDED', itemResource(b));
    const early = await drain();
    expect(early.failed.map((f) => f.id)).toEqual([ev.id]);
    expect((await itemRow(b.itemId)).status).toBe('PENDING');

    await pools.a.query(
      `UPDATE payout_batches SET status = 'PENDING', paypal_batch_id = $2 WHERE id = $1`,
      [b.batchId, b.paypalBatchId],
    );
    const late = await drain();
    expect(late.processed.map((p) => p.id)).toEqual([ev.id]);
    expect(await txnCount(`payout_settled:${b.itemId}`)).toBe(1);
    await expectLedgerOk();
  });

  test('PAYOUTS-ITEM.UNCLAIMED then RETURNED → back to payable once', async () => {
    const b = await runFor(await newPublisher());
    await receive('PAYMENT.PAYOUTS-ITEM.UNCLAIMED', {
      ...itemResource(b),
      transaction_status: 'UNCLAIMED',
      errors: { name: 'RECEIVER_UNREGISTERED' },
    });
    await drain();
    expect((await itemRow(b.itemId)).status).toBe('UNCLAIMED');
    const ret = { ...itemResource(b), transaction_status: 'RETURNED' };
    await receive('PAYMENT.PAYOUTS-ITEM.RETURNED', ret);
    await receive('PAYMENT.PAYOUTS-ITEM.RETURNED', ret);
    await drain();
    expect((await itemRow(b.itemId)).status).toBe('RETURNED');
    expect(await txnCount(`payout_returned:${b.itemId}`)).toBe(1);
    await expectLedgerOk();
  });
});
