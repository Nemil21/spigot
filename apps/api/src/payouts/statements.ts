import type { Queryable } from '../db/pool.js';

/**
 * W09 statements (SP-031; screens.md §W09 statement drawer, features/15 SIM labelling):
 * `GET /api/publishers/me/payouts/statements` → per payout item the statement figures the
 * payouts view doesn't carry (records sold, SIM share, rounding carried forward), plus a preview
 * of the next payout's statement for the "Run payout now" confirm modal.
 *
 * The period matches SP-020's `statementFor` (payouts/buildBatch.ts): it starts where the
 * publisher's last paid or in-flight item's batch ended and ends at the item's batch `period_end`
 * (the preview ends now). Gross = the payable line + the platform revenue line of each CHARGE /
 * CREDIT txn on the payable; commission = the revenue line; records = `records_returned` of the
 * charged calls. SIM figures are the same sums over `ledger_txns.is_simulated` txns.
 *
 * Rounding carried forward = the payable balance right after the item's PAYOUT_SENT: the
 * sub-cent remainder (`payable − net`) left for the next payout. `buildBatch` holds the payable
 * row lock while posting, so no other entry lands in between, and entry ids order the account.
 */

export interface StatementDto {
  periodStart: string | null;
  periodEnd: string;
  recordsSold: number;
  grossMicros: number;
  commissionMicros: number;
  simGrossMicros: number;
  simRecords: number;
  /** Null for the next-payout preview (nothing sent yet). */
  roundingCarriedMicros: number | null;
}

export interface PayoutStatementsDto {
  next: StatementDto;
  /** Keyed by payout item id. */
  items: Record<string, StatementDto>;
}

interface Row {
  key: string;
  since: Date | null;
  firstAt: Date | null;
  periodEnd: Date;
  grossMicros: string | number | null;
  commissionMicros: string | number | null;
  simGrossMicros: string | number | null;
  recordsSold: string | number | null;
  simRecords: string | number | null;
  roundingCarriedMicros: string | number | null;
}

const NEXT_KEY = '__next__';

/** The period's CHARGE / CREDIT txns on the payable (alias `t`, period row `p`, since `s`). */
const IN_PERIOD = `t.kind IN ('CHARGE', 'CREDIT')
  AND EXISTS (SELECT 1 FROM ledger_entries pe
              WHERE pe.txn_id = t.id AND pe.account_id = (SELECT id FROM acct))
  AND (s.since IS NULL OR t.created_at > s.since)
  AND t.created_at <= p.period_end`;

const num = (v: string | number | null) => Number(v ?? 0);

export async function payoutStatements(
  q: Queryable,
  publisherId: string,
  now: Date = new Date(),
): Promise<PayoutStatementsDto> {
  const { rows } = await q.query<Row>(
    `WITH acct AS (
       SELECT id FROM ledger_accounts WHERE kind = 'PUBLISHER_PAYABLE' AND owner_id = $1
     ), rev AS (
       SELECT id FROM ledger_accounts WHERE kind = 'PLATFORM_REVENUE'
     ), periods AS (
       (SELECT i.id::text AS key, i.batch_id, b.period_end, i.ledger_txn_id
        FROM payout_items i JOIN payout_batches b ON b.id = i.batch_id
        WHERE i.publisher_id = $1
        ORDER BY b.created_at DESC, i.id
        LIMIT 500)
       UNION ALL
       SELECT $3, NULL::uuid, $2::timestamptz, NULL::uuid
     )
     SELECT p.key, s.since, m."firstAt", p.period_end AS "periodEnd",
            m."grossMicros", m."commissionMicros", m."simGrossMicros",
            r."recordsSold", r."simRecords",
            (SELECT sum(e.amount_micros) FROM ledger_entries e
             WHERE e.account_id = (SELECT id FROM acct)
               AND e.id <= (SELECT max(se.id) FROM ledger_entries se
                            WHERE se.txn_id = p.ledger_txn_id
                              AND se.account_id = (SELECT id FROM acct)))::bigint
              AS "roundingCarriedMicros"
     FROM periods p
     CROSS JOIN LATERAL (
       SELECT max(b2.period_end) AS since
       FROM payout_items i2 JOIN payout_batches b2 ON b2.id = i2.batch_id
       WHERE i2.publisher_id = $1 AND i2.batch_id IS DISTINCT FROM p.batch_id
         AND b2.period_end < p.period_end
         AND i2.status IN ('PENDING', 'UNCLAIMED', 'SUCCESS')
     ) s
     CROSS JOIN LATERAL (
       SELECT min(t.created_at) AS "firstAt",
              sum(e.amount_micros)::bigint AS "grossMicros",
              (sum(e.amount_micros) FILTER (WHERE e.account_id IN (SELECT id FROM rev)))::bigint
                AS "commissionMicros",
              (sum(e.amount_micros) FILTER (WHERE t.is_simulated))::bigint AS "simGrossMicros"
       FROM ledger_txns t JOIN ledger_entries e ON e.txn_id = t.id
       WHERE ${IN_PERIOD}
         AND (e.account_id = (SELECT id FROM acct) OR e.account_id IN (SELECT id FROM rev))
     ) m
     CROSS JOIN LATERAL (
       SELECT sum(c.records_returned)::bigint AS "recordsSold",
              (sum(c.records_returned) FILTER (WHERE t.is_simulated))::bigint AS "simRecords"
       FROM ledger_txns t JOIN api_calls c ON c.charge_txn_id = t.id
       WHERE t.kind = 'CHARGE' AND ${IN_PERIOD}
     ) r`,
    [publisherId, now, NEXT_KEY],
  );

  const items: Record<string, StatementDto> = {};
  let next: StatementDto | null = null;
  for (const row of rows) {
    const start = row.since ?? row.firstAt;
    const dto: StatementDto = {
      periodStart: start ? start.toISOString() : null,
      periodEnd: row.periodEnd.toISOString(),
      recordsSold: num(row.recordsSold),
      grossMicros: num(row.grossMicros),
      commissionMicros: num(row.commissionMicros),
      simGrossMicros: num(row.simGrossMicros),
      simRecords: num(row.simRecords),
      roundingCarriedMicros:
        row.roundingCarriedMicros === null ? null : Number(row.roundingCarriedMicros),
    };
    if (row.key === NEXT_KEY) next = dto;
    else items[row.key] = dto;
  }
  return { next: next!, items };
}
