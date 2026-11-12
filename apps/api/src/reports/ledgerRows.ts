import type pg from 'pg';
import { z } from 'zod';
import { decodeCursor, encodeCursor } from './query.js';

/**
 * Publisher ledger rows (api.md §`GET /api/publishers/me/ledger?cursor`; W08 ledger tab).
 *
 * One row per entry on the publisher's own `PUBLISHER_PAYABLE` account, newest first, in blocks
 * of `LEDGER_BLOCK` (AG Grid server-side rows). The amount is signed from the publisher's side:
 * a charge is +net, a credit or payout is −. The account is found from the session publisher id
 * alone, so another publisher's entries can't be reached, cursor or not. PayPal ids come from the
 * payout item a payout txn references.
 *
 * Order is by entry (posting order), not by `createdAt`: SIM txns backdated by SP-036's simulated
 * week were posted recently, so they can sit above newer real entries with an older `createdAt`.
 */

export const LEDGER_BLOCK = 100;

export interface LedgerRow {
  /** Entry id (bigserial, as a string). */
  id: string;
  txnId: string;
  kind: string;
  memo: string;
  amountMicros: number;
  isSimulated: boolean;
  /** PayPal payout item id (payout txns only). */
  paypalId: string | null;
  paypalBatchId: string | null;
  ref: { type: string; id: string } | null;
  createdAt: string;
}

export interface LedgerPage {
  rows: LedgerRow[];
  nextCursor: string | null;
}

export interface LedgerQuery {
  publisherId: string;
  cursor?: string;
  includeSim: boolean;
}

const cursorSchema = z.strictObject({ e: z.string().regex(/^\d{1,19}$/) });

/** Fallback memo when the txn has none. */
function defaultMemo(r: {
  kind: string;
  records: number | null;
  changes: number | null;
  dataset: string | null;
}): string {
  switch (r.kind) {
    case 'CHARGE': {
      const n = r.changes ?? r.records ?? 0;
      const what = r.changes !== null ? 'changes' : 'records';
      return `${n.toLocaleString('en-US')} ${what} sold${r.dataset ? ` · ${r.dataset}` : ''}`;
    }
    case 'CREDIT':
      return 'Claim credit to buyer';
    case 'PAYOUT_SENT':
      return 'PayPal payout sent';
    case 'PAYOUT_RETURNED':
      return 'PayPal payout returned';
    case 'DEMO_RESET':
      return 'Demo reset';
    default:
      return r.kind;
  }
}

export async function ledgerRows(pool: pg.Pool, q: LedgerQuery): Promise<LedgerPage> {
  const params: unknown[] = [q.publisherId, q.includeSim, LEDGER_BLOCK + 1];
  let after = '';
  if (q.cursor !== undefined) {
    params.push(decodeCursor(cursorSchema, q.cursor).e);
    after = `AND e.id < $${params.length}::bigint`;
  }
  const { rows } = await pool.query<{
    id: string;
    txnId: string;
    kind: string;
    memo: string | null;
    amountMicros: number;
    isSimulated: boolean;
    refType: string | null;
    refId: string | null;
    paypalId: string | null;
    paypalBatchId: string | null;
    records: number | null;
    changes: number | null;
    dataset: string | null;
    createdAt: Date;
  }>(
    `SELECT e.id::text AS id, t.id AS "txnId", t.kind, t.memo, e.amount_micros AS "amountMicros",
            t.is_simulated AS "isSimulated", t.ref_type AS "refType", t.ref_id AS "refId",
            pi.paypal_item_id AS "paypalId", pb.paypal_batch_id AS "paypalBatchId",
            c.records_returned AS records, c.changes_returned AS changes,
            coalesce(s.slug, s.origin) || '/' || d.slug AS dataset,
            t.created_at AS "createdAt"
     FROM ledger_accounts a
     JOIN ledger_entries e ON e.account_id = a.id
     JOIN ledger_txns t ON t.id = e.txn_id
     LEFT JOIN payout_items pi
       ON t.ref_type = 'payout_item' AND pi.id = t.ref_id AND pi.publisher_id = a.owner_id
     LEFT JOIN payout_batches pb ON pb.id = pi.batch_id
     LEFT JOIN api_calls c ON t.ref_type = 'api_call' AND c.id = t.ref_id
     LEFT JOIN datasets d ON d.id = c.dataset_id
     LEFT JOIN sites s ON s.id = d.site_id AND s.publisher_id = a.owner_id
     WHERE a.kind = 'PUBLISHER_PAYABLE' AND a.owner_id = $1
       AND ($2::bool OR NOT t.is_simulated)
       ${after}
     ORDER BY e.id DESC
     LIMIT $3`,
    params,
  );

  const more = rows.length > LEDGER_BLOCK;
  const page = more ? rows.slice(0, LEDGER_BLOCK) : rows;
  return {
    rows: page.map((r) => ({
      id: r.id,
      txnId: r.txnId,
      kind: r.kind,
      memo: r.memo ?? defaultMemo(r),
      amountMicros: r.amountMicros,
      isSimulated: r.isSimulated,
      paypalId: r.paypalId,
      paypalBatchId: r.paypalBatchId,
      ref: r.refType && r.refId ? { type: r.refType, id: r.refId } : null,
      createdAt: r.createdAt.toISOString(),
    })),
    nextCursor: more ? encodeCursor({ e: page[page.length - 1]!.id }) : null,
  };
}
