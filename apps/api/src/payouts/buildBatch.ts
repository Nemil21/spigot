import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { centsToMicros, formatCount, microsToCentsFloor } from '@spigot/shared';
import { platformAccounts } from '../ledger/accounts.js';
import { post } from '../ledger/ledger.js';
import { payoutSentEntries } from '../ledger/postings.js';

/**
 * SP-020 step 3 (features/09 §Logic 2–4): build one payout batch in **one transaction** on the
 * run's client (the one holding `pg_advisory_lock('payout')`):
 * - insert `payout_batches` BUILDING (`id` = `sender_batch_id`);
 * - for each publisher with `microsToCentsFloor(payable) ≥ threshold` and no PENDING / UNCLAIMED
 *   item: insert `payout_items` (`id` = `sender_item_id`, `receiver_email` snapshot, `net_cents`,
 *   statement figures) and post `PAYOUT_SENT` (key `payout_item:<id>`);
 * - no items → the batch row is deleted and nothing is left behind.
 * The sub-cent remainder of each payable stays in payable for the next batch.
 */

export type PayoutTrigger = 'SCHEDULE' | 'MANUAL_DEMO';

/** Commission and threshold defaults (also the `publishers` column defaults). */
export const DEFAULT_COMMISSION_BPS = 2000;
export const DEFAULT_THRESHOLD_CENTS = 1000;
/** A demo override never goes below $1. */
export const MIN_DEMO_THRESHOLD_CENTS = 100;

export interface BuildBatchInput {
  trigger: PayoutTrigger;
  /** MANUAL_DEMO only: replaces every publisher's threshold, clamped to ≥ $1. */
  thresholdCentsOverride?: number | undefined;
  /** SCHEDULE runs are unique per `period_end`. Default: now. */
  periodEnd?: Date | undefined;
}

export interface BuiltItem {
  itemId: string;
  publisherId: string;
  receiverEmail: string;
  netCents: number;
  grossMicros: number;
  commissionMicros: number;
  recordsSold: number;
  note: string;
  ledgerTxnId: string;
}

export type BuildBatchResult =
  | { kind: 'BUILT'; batchId: string; items: BuiltItem[] }
  | { kind: 'NO_ITEMS' }
  /** A SCHEDULE batch for this `period_end` already exists. */
  | { kind: 'PERIOD_TAKEN' };

/** Run `fn` in a transaction on an already checked-out client. */
export async function inTx<T>(client: pg.ClientBase, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/** The threshold this run applies to a publisher whose own threshold is `publisherCents`. */
export function effectiveThresholdCents(
  input: Pick<BuildBatchInput, 'trigger' | 'thresholdCentsOverride'>,
  publisherCents: number,
): number {
  if (input.thresholdCentsOverride === undefined) return publisherCents;
  if (input.trigger !== 'MANUAL_DEMO') {
    throw new RangeError('thresholdCentsOverride is a demo control: only for MANUAL_DEMO runs');
  }
  if (!Number.isSafeInteger(input.thresholdCentsOverride)) {
    throw new RangeError(
      `thresholdCentsOverride must be integer cents, got ${input.thresholdCentsOverride}`,
    );
  }
  return Math.max(MIN_DEMO_THRESHOLD_CENTS, input.thresholdCentsOverride);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Nov 4–11", "Oct 28–Nov 3", "Nov 11" (UTC). */
export function formatPeriod(start: Date | null, end: Date): string {
  const endLabel = `${MONTHS[end.getUTCMonth()]} ${end.getUTCDate()}`;
  if (!start) return endLabel;
  const sameDay =
    start.getUTCFullYear() === end.getUTCFullYear() &&
    start.getUTCMonth() === end.getUTCMonth() &&
    start.getUTCDate() === end.getUTCDate();
  if (sameDay) return endLabel;
  const startLabel = `${MONTHS[start.getUTCMonth()]} ${start.getUTCDate()}`;
  const endPart =
    start.getUTCMonth() === end.getUTCMonth() && start.getUTCFullYear() === end.getUTCFullYear()
      ? String(end.getUTCDate())
      : endLabel;
  return `${startLabel}–${endPart}`;
}

/** "Spigot: 8,112 records sold, Nov 4–11". */
export function payoutNote(recordsSold: number, period: string): string {
  return `Spigot: ${formatCount(recordsSold)} records sold, ${period}`;
}

interface Candidate {
  publisherId: string;
  accountId: string;
  payoutEmail: string;
  thresholdCents: number;
  payableMicros: number;
}

export interface Statement {
  grossMicros: number;
  commissionMicros: number;
  recordsSold: number;
  /** Start of the period: the end of the publisher's last statement, else its first charge. */
  periodStart: Date | null;
  /** "Spigot: 8,112 records sold, Nov 4–11" (the PayPal item note). */
  note: string;
}

/**
 * Lock every publisher payable `FOR UPDATE` in id order (the same order `ledger.post` uses), so a
 * charge or claim can't move a payable between reading it and posting PAYOUT_SENT. Publishers with
 * a PENDING or UNCLAIMED item are skipped (data-model rule 10).
 */
async function candidates(client: pg.ClientBase): Promise<Candidate[]> {
  const { rows } = await client.query<Candidate>(
    `SELECT p.id AS "publisherId", a.id AS "accountId", p.payout_email AS "payoutEmail",
            p.payout_threshold_cents AS "thresholdCents", a.balance_micros AS "payableMicros"
     FROM ledger_accounts a
     JOIN publishers p ON p.id = a.owner_id
     WHERE a.kind = 'PUBLISHER_PAYABLE'
       AND a.balance_micros > 0
       AND NOT EXISTS (SELECT 1 FROM payout_items i
                       WHERE i.publisher_id = p.id AND i.status IN ('PENDING', 'UNCLAIMED'))
     ORDER BY a.id
     FOR UPDATE OF a`,
  );
  return rows;
}

/**
 * Statement figures for one publisher's item in batch `batchId` (features/09 §Money math), from
 * the period's CHARGE / CREDIT txns on its payable: gross = the payable line + the platform
 * revenue line of each txn (CREDITs are negative), commission = the revenue line, records =
 * `api_calls.records_returned` of the charged calls. The period starts where the publisher's last
 * paid or in-flight item's batch ended (a FAILED / RETURNED item's charges roll into the next
 * statement) and ends at this batch's `period_end`. Also used to rebuild the note on resume.
 */
export async function statementFor(
  client: pg.ClientBase,
  publisherId: string,
  batchId: string,
  periodEnd: Date,
): Promise<Statement> {
  const { rows } = await client.query<
    Omit<Statement, 'note'> & { firstAt: Date | null; sinceAt: Date | null }
  >(
    `WITH acct AS (
       SELECT id FROM ledger_accounts WHERE kind = 'PUBLISHER_PAYABLE' AND owner_id = $1
     ), since AS (
       SELECT max(b.period_end) AS at FROM payout_items i JOIN payout_batches b ON b.id = i.batch_id
       WHERE i.publisher_id = $1 AND i.batch_id <> $2 AND b.period_end < $3
         AND i.status IN ('PENDING', 'UNCLAIMED', 'SUCCESS')
     ), txns AS (
       SELECT DISTINCT t.id, t.kind, t.created_at
       FROM ledger_entries pe JOIN ledger_txns t ON t.id = pe.txn_id
       WHERE pe.account_id = (SELECT id FROM acct) AND t.kind IN ('CHARGE', 'CREDIT')
         AND ((SELECT at FROM since) IS NULL OR t.created_at > (SELECT at FROM since))
         AND t.created_at <= $3
     )
     SELECT
       coalesce((SELECT sum(e.amount_micros) FROM txns x JOIN ledger_entries e ON e.txn_id = x.id
                 JOIN ledger_accounts a ON a.id = e.account_id
                 WHERE e.account_id = (SELECT id FROM acct) OR a.kind = 'PLATFORM_REVENUE'), 0)::bigint
         AS "grossMicros",
       coalesce((SELECT sum(e.amount_micros) FROM txns x JOIN ledger_entries e ON e.txn_id = x.id
                 JOIN ledger_accounts a ON a.id = e.account_id
                 WHERE a.kind = 'PLATFORM_REVENUE'), 0)::bigint AS "commissionMicros",
       coalesce((SELECT sum(c.records_returned) FROM txns x JOIN api_calls c ON c.charge_txn_id = x.id
                 WHERE x.kind = 'CHARGE'), 0)::bigint AS "recordsSold",
       (SELECT min(created_at) FROM txns) AS "firstAt",
       (SELECT at FROM since) AS "sinceAt"`,
    [publisherId, batchId, periodEnd],
  );
  const r = rows[0]!;
  const periodStart = r.sinceAt ?? r.firstAt;
  return {
    grossMicros: r.grossMicros,
    commissionMicros: r.commissionMicros,
    recordsSold: r.recordsSold,
    periodStart,
    note: payoutNote(r.recordsSold, formatPeriod(periodStart, periodEnd)),
  };
}

/** Build the batch on `client`, which must not be inside a transaction. */
export async function buildBatch(
  client: pg.ClientBase,
  input: BuildBatchInput,
): Promise<BuildBatchResult> {
  // Validate the override before touching the database.
  effectiveThresholdCents(input, DEFAULT_THRESHOLD_CENTS);

  return inTx(client, async () => {
    const batchId = randomUUID();
    const inserted = await client.query<{ periodEnd: Date }>(
      `INSERT INTO payout_batches (id, trigger, status, period_end)
       VALUES ($1, $2, 'BUILDING', coalesce($3::timestamptz, now()))
       ON CONFLICT (period_end) WHERE trigger = 'SCHEDULE' DO NOTHING
       RETURNING period_end AS "periodEnd"`,
      [batchId, input.trigger, input.periodEnd ?? null],
    );
    const periodEnd = inserted.rows[0]?.periodEnd;
    if (!periodEnd) return { kind: 'PERIOD_TAKEN' } as const;

    const platform = await platformAccounts(client);
    const items: BuiltItem[] = [];
    let periodStart: Date | null = null;

    for (const c of await candidates(client)) {
      const netCents = microsToCentsFloor(c.payableMicros);
      if (netCents <= 0 || netCents < effectiveThresholdCents(input, c.thresholdCents)) continue;

      const s = await statementFor(client, c.publisherId, batchId, periodEnd);
      if (s.periodStart && (!periodStart || s.periodStart < periodStart))
        periodStart = s.periodStart;
      const itemId = randomUUID();

      // PAYOUT_SENT before the item row: the item references its txn.
      const sent = await post(client as pg.PoolClient, {
        kind: 'PAYOUT_SENT',
        idempotencyKey: `payout_item:${itemId}`,
        refType: 'payout_item',
        refId: itemId,
        memo: `Payout batch ${batchId}`,
        entries: payoutSentEntries(
          { publisher: c.accountId, payoutsInFlight: platform.payoutsInFlight },
          centsToMicros(netCents),
        ),
      });
      await client.query(
        `INSERT INTO payout_items (id, batch_id, publisher_id, receiver_email, gross_micros,
                                   commission_micros, net_cents, status, ledger_txn_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8)`,
        [
          itemId,
          batchId,
          c.publisherId,
          c.payoutEmail,
          s.grossMicros,
          s.commissionMicros,
          netCents,
          sent.txn.id,
        ],
      );
      items.push({
        itemId,
        publisherId: c.publisherId,
        receiverEmail: c.payoutEmail,
        netCents,
        grossMicros: s.grossMicros,
        commissionMicros: s.commissionMicros,
        recordsSold: s.recordsSold,
        note: s.note,
        ledgerTxnId: sent.txn.id,
      });
    }

    if (items.length === 0) {
      await client.query(`DELETE FROM payout_batches WHERE id = $1`, [batchId]);
      return { kind: 'NO_ITEMS' } as const;
    }

    await client.query(
      `UPDATE payout_batches SET period_start = $2, total_cents = $3, item_count = $4, updated_at = now()
       WHERE id = $1`,
      [batchId, periodStart, items.reduce((s, i) => s + i.netCents, 0), items.length],
    );
    return { kind: 'BUILT', batchId, items } as const;
  });
}
