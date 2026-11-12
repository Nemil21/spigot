import type pg from 'pg';

/**
 * Ledger check (features/07 §Ledger check). SP-043 serves it at `POST /admin/ledger/check`; it
 * also runs nightly. Three invariants:
 * 1. the sum of every `balance_micros` is 0;
 * 2. each account's `balance_micros` equals the sum of its entries;
 * 3. per publisher, charges (net) − credits − payouts sent + payouts returned = payable.
 *    Each term is the absolute total of that kind's entries on the payable account, so an entry
 *    posted with the wrong sign shows up here. Other kinds touching a payable (`DEMO_RESET`) count
 *    with their own sign.
 *
 * Runs in one REPEATABLE READ snapshot, so concurrent posts never produce a false mismatch.
 */

export type LedgerMismatch =
  | { check: 'GLOBAL_SUM'; expectedMicros: 0; actualMicros: number }
  | {
      check: 'ACCOUNT_BALANCE';
      accountId: string;
      kind: string;
      ownerId: string | null;
      /** Sum of the account's entries. */
      expectedMicros: number;
      /** `balance_micros`. */
      actualMicros: number;
    }
  | {
      check: 'PUBLISHER_PAYABLE';
      accountId: string;
      publisherId: string;
      expectedMicros: number;
      actualMicros: number;
      chargesMicros: number;
      creditsMicros: number;
      payoutsSentMicros: number;
      payoutsReturnedMicros: number;
      otherMicros: number;
    };

export interface LedgerCheckResult {
  sumMicros: number;
  accountsChecked: number;
  mismatches: LedgerMismatch[];
}

export async function ledgerCheck(pool: pg.Pool): Promise<LedgerCheckResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await runChecks(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function runChecks(client: pg.PoolClient): Promise<LedgerCheckResult> {
  const mismatches: LedgerMismatch[] = [];

  const totals = await client.query<{ sum: number; n: number }>(
    `SELECT coalesce(sum(balance_micros), 0)::bigint AS sum, count(*)::int AS n FROM ledger_accounts`,
  );
  const { sum: sumMicros, n: accountsChecked } = totals.rows[0]!;
  if (sumMicros !== 0)
    mismatches.push({ check: 'GLOBAL_SUM', expectedMicros: 0, actualMicros: sumMicros });

  const accounts = await client.query<{
    id: string;
    kind: string;
    ownerId: string | null;
    expected: number;
    actual: number;
  }>(
    `SELECT a.id, a.kind, a.owner_id AS "ownerId",
            coalesce(e.total, 0)::bigint AS expected, a.balance_micros AS actual
     FROM ledger_accounts a
     LEFT JOIN (SELECT account_id, sum(amount_micros) AS total FROM ledger_entries GROUP BY account_id) e
       ON e.account_id = a.id
     WHERE a.balance_micros <> coalesce(e.total, 0)
     ORDER BY a.id`,
  );
  for (const r of accounts.rows) {
    mismatches.push({
      check: 'ACCOUNT_BALANCE',
      accountId: r.id,
      kind: r.kind,
      ownerId: r.ownerId,
      expectedMicros: r.expected,
      actualMicros: r.actual,
    });
  }

  const publishers = await client.query<{
    id: string;
    publisherId: string;
    payable: number;
    charges: number;
    credits: number;
    sent: number;
    returned: number;
    other: number;
  }>(
    `SELECT a.id, a.owner_id AS "publisherId", a.balance_micros AS payable,
            coalesce(sum(abs(e.amount_micros)) FILTER (WHERE t.kind = 'CHARGE'), 0)::bigint AS charges,
            coalesce(sum(abs(e.amount_micros)) FILTER (WHERE t.kind = 'CREDIT'), 0)::bigint AS credits,
            coalesce(sum(abs(e.amount_micros)) FILTER (WHERE t.kind = 'PAYOUT_SENT'), 0)::bigint AS sent,
            coalesce(sum(abs(e.amount_micros)) FILTER (WHERE t.kind = 'PAYOUT_RETURNED'), 0)::bigint AS returned,
            coalesce(sum(e.amount_micros)
              FILTER (WHERE t.kind NOT IN ('CHARGE', 'CREDIT', 'PAYOUT_SENT', 'PAYOUT_RETURNED')), 0)::bigint AS other
     FROM ledger_accounts a
     LEFT JOIN ledger_entries e ON e.account_id = a.id
     LEFT JOIN ledger_txns t ON t.id = e.txn_id
     WHERE a.kind = 'PUBLISHER_PAYABLE'
     GROUP BY a.id
     ORDER BY a.id`,
  );
  for (const r of publishers.rows) {
    const expected = r.charges - r.credits - r.sent + r.returned + r.other;
    if (expected === r.payable) continue;
    mismatches.push({
      check: 'PUBLISHER_PAYABLE',
      accountId: r.id,
      publisherId: r.publisherId,
      expectedMicros: expected,
      actualMicros: r.payable,
      chargesMicros: r.charges,
      creditsMicros: r.credits,
      payoutsSentMicros: r.sent,
      payoutsReturnedMicros: r.returned,
      otherMicros: r.other,
    });
  }

  return { sumMicros, accountsChecked, mismatches };
}
