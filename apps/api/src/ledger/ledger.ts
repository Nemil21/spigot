import type { Tx } from '../db/tx.js';
import { InsufficientBalance } from './errors.js';
import type { Entry } from './postings.js';

/**
 * `ledger.post` (features/07 §`ledger.post(txn)`, data-model rule 2): the only writer of
 * `ledger_accounts.balance_micros`. Every money move is one balanced, idempotent transaction, and a
 * buyer balance can never go negative. Nothing else may `UPDATE ledger_accounts`.
 */

/** `ledger_txns.kind`. */
export const LEDGER_TXN_KINDS = [
  'TOPUP',
  'CHARGE',
  'CREDIT',
  'REFUND',
  'REFUND_REVERSAL',
  'PAYOUT_SENT',
  'PAYOUT_SETTLED',
  'PAYOUT_RETURNED',
  'DEMO_RESET',
] as const;
export type LedgerTxnKind = (typeof LEDGER_TXN_KINDS)[number];

export interface PostInput {
  kind: LedgerTxnKind;
  /** Unique per money move, e.g. `topup:<topupId>`, `charge:<apiCallId>`, `payout_item:<itemId>`. */
  idempotencyKey: string;
  refType?: string | null;
  refId?: string | null;
  memo?: string | null;
  /** From the `postings.ts` builders. Must sum to 0. */
  entries: Entry[];
  isSimulated?: boolean;
  /**
   * Sets `created_at` on the txn and all its entries at insert time (SP-036's simulated week).
   * Only accepted with `isSimulated: true`.
   */
  simulatedAt?: Date;
}

export interface LedgerTxn {
  id: string;
  kind: LedgerTxnKind;
  idempotencyKey: string;
  refType: string | null;
  refId: string | null;
  memo: string | null;
  isSimulated: boolean;
  createdAt: Date;
}

export type PostResult =
  /** Posted now. `balances` holds each touched account's balance after the post. */
  | { replay: false; txn: LedgerTxn; balances: Record<string, number> }
  /** The key was already posted: nothing was written; `txn` is the original. */
  | { replay: true; txn: LedgerTxn };

const SAVEPOINT = 'ledger_post';
const BUYER_BALANCE_CHECK = 'ledger_accounts_buyer_balance_nonnegative';

const TXN_COLUMNS = `id, kind, idempotency_key AS "idempotencyKey", ref_type AS "refType", ref_id AS "refId",
  memo, is_simulated AS "isSimulated", created_at AS "createdAt"`;

function validate(input: PostInput): void {
  if (!(LEDGER_TXN_KINDS as readonly string[]).includes(input.kind)) {
    throw new TypeError(`unknown ledger txn kind ${input.kind}`);
  }
  if (!input.idempotencyKey) throw new TypeError('idempotencyKey is required');
  if (input.simulatedAt !== undefined) {
    if (input.isSimulated !== true)
      throw new TypeError('simulatedAt is only allowed with isSimulated: true');
    if (!(input.simulatedAt instanceof Date) || Number.isNaN(input.simulatedAt.getTime())) {
      throw new TypeError('simulatedAt must be a valid Date');
    }
  }
  if (input.entries.length === 0) throw new RangeError('a ledger txn needs at least one entry');
  let sum = 0;
  for (const e of input.entries) {
    if (!Number.isSafeInteger(e.amountMicros) || e.amountMicros === 0) {
      throw new RangeError(`entry amounts must be non-zero integer micros, got ${e.amountMicros}`);
    }
    sum += e.amountMicros;
  }
  // The deferred trigger enforces this at COMMIT; failing here gives the caller a clear error.
  if (!Number.isSafeInteger(sum) || sum !== 0) {
    throw new RangeError(`ledger txn ${input.idempotencyKey} is unbalanced: entries sum to ${sum}`);
  }
}

function isBuyerBalanceViolation(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  return e?.code === '23514' && e.constraint === BUYER_BALANCE_CHECK;
}

/**
 * Post one balanced txn inside the caller's transaction `tx`:
 * 1. insert `ledger_txns` (`ON CONFLICT (idempotency_key) DO NOTHING`); a conflict returns
 *    `{ replay: true, txn }` and writes nothing;
 * 2. lock the touched accounts `FOR UPDATE` in id order (no deadlocks between posts);
 * 3. insert the entries and apply the balance deltas; the check constraint rejects a negative
 *    buyer balance, which rolls back to the `ledger_post` savepoint and throws
 *    `InsufficientBalance`, leaving the caller's transaction usable and no txn row behind;
 * 4. the deferred `ledger_entries_balanced` trigger re-checks the zero sum at COMMIT.
 *
 * Accounts must already exist (`getOrCreateAccount`).
 */
export async function post(tx: Tx, input: PostInput): Promise<PostResult> {
  validate(input);
  const simulatedAt = input.simulatedAt ?? null;

  // Net delta per account; an account may appear on more than one line.
  const deltas = new Map<string, number>();
  for (const e of input.entries)
    deltas.set(e.accountId, (deltas.get(e.accountId) ?? 0) + e.amountMicros);
  const accountIds = [...deltas.keys()].sort();

  await tx.query(`SAVEPOINT ${SAVEPOINT}`);
  try {
    const inserted = await tx.query<LedgerTxn>(
      `INSERT INTO ledger_txns (kind, idempotency_key, ref_type, ref_id, memo, is_simulated, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, coalesce($7::timestamptz, now()))
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ${TXN_COLUMNS}`,
      [
        input.kind,
        input.idempotencyKey,
        input.refType ?? null,
        input.refId ?? null,
        input.memo ?? null,
        input.isSimulated ?? false,
        simulatedAt,
      ],
    );
    const txn = inserted.rows[0];
    if (!txn) {
      const existing = await tx.query<LedgerTxn>(
        `SELECT ${TXN_COLUMNS} FROM ledger_txns WHERE idempotency_key = $1`,
        [input.idempotencyKey],
      );
      await tx.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
      const original = existing.rows[0];
      if (!original)
        throw new Error(`ledger txn ${input.idempotencyKey} conflicted but is not visible`);
      return { replay: true, txn: original };
    }

    const locked = await tx.query<{ id: string; balance: number }>(
      `SELECT id, balance_micros AS balance FROM ledger_accounts
       WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [accountIds],
    );
    if (locked.rows.length !== accountIds.length) {
      const found = new Set(locked.rows.map((r) => r.id));
      throw new Error(
        `unknown ledger account(s): ${accountIds.filter((id) => !found.has(id)).join(', ')}`,
      );
    }

    await tx.query(
      `INSERT INTO ledger_entries (txn_id, account_id, amount_micros, created_at)
       SELECT $1, e.account_id, e.amount_micros, coalesce($4::timestamptz, now())
       FROM unnest($2::uuid[], $3::bigint[]) WITH ORDINALITY AS e(account_id, amount_micros, n)
       ORDER BY e.n`,
      [
        txn.id,
        input.entries.map((e) => e.accountId),
        input.entries.map((e) => e.amountMicros),
        simulatedAt,
      ],
    );

    const changed = accountIds.filter((id) => deltas.get(id) !== 0);
    await tx.query(
      `UPDATE ledger_accounts a SET balance_micros = a.balance_micros + d.delta
       FROM unnest($1::uuid[], $2::bigint[]) AS d(id, delta)
       WHERE a.id = d.id`,
      [changed, changed.map((id) => deltas.get(id))],
    );
    await tx.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);

    // The rows are locked, so the balance read under the lock plus the delta is the new balance.
    const balances: Record<string, number> = {};
    for (const r of locked.rows) balances[r.id] = r.balance + deltas.get(r.id)!;
    return { replay: false, txn, balances };
  } catch (err) {
    if (isBuyerBalanceViolation(err)) {
      await tx.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
      await tx.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
      throw new InsufficientBalance(input.idempotencyKey);
    }
    throw err;
  }
}
