import type { Queryable } from './pool.js';

/**
 * Conditional status updates (data-model.md, locking rule 1).
 *
 * `transition(tx, table, id, from, to, extra?)` runs
 *   UPDATE <table> SET status = $to, ... WHERE id = $id AND status = ANY($from) RETURNING *
 * and returns the updated row, or `null` when nobody matched: someone else won the race, so
 * stop. Table names come from the `StatusTable` union, never free strings, and every
 * `from -> to` edge must be in that table's state machine below (a bad edge is a programming
 * error and throws before touching the database).
 */
const MACHINES = {
  sites: {
    PENDING_VERIFY: ['VERIFIED'],
    VERIFIED: ['PROPOSING'],
    PROPOSING: ['READY'],
    READY: ['PAUSED'],
    PAUSED: ['READY'],
  },
  // LIVE | LIVE_STALE | UNPUBLISHED -> PROPOSED is the DEMO_RESET transition: SP-038's code
  // path takes it only for an is_demo publisher.
  datasets: {
    PROPOSED: ['LIVE', 'REJECTED'],
    LIVE: ['LIVE_STALE', 'UNPUBLISHED', 'PROPOSED'],
    LIVE_STALE: ['LIVE', 'UNPUBLISHED', 'PROPOSED'],
    UNPUBLISHED: ['PROPOSED'],
    REJECTED: [],
  },
  schema_versions: {
    PROPOSED: ['APPROVED', 'REJECTED', 'SUPERSEDED'],
    APPROVED: ['SUPERSEDED'],
    SUPERSEDED: [],
    REJECTED: [],
  },
  crawl_runs: {
    QUEUED: ['RUNNING', 'FAILED'],
    RUNNING: ['SUCCEEDED', 'PARTIAL', 'FAILED', 'PAUSED'],
    SUCCEEDED: [],
    PARTIAL: [],
    FAILED: [],
    PAUSED: [],
  },
  // ABANDONED -> COMPLETED: a late capture or webhook after the 30-min sweep still credits.
  topups: {
    CREATED: ['AWAITING_APPROVAL', 'COMPLETED', 'FAILED'],
    AWAITING_APPROVAL: ['COMPLETED', 'FAILED', 'ABANDONED'],
    ABANDONED: ['COMPLETED'],
    COMPLETED: ['PARTIALLY_REFUNDED', 'REFUNDED'],
    PARTIALLY_REFUNDED: ['REFUNDED'],
    REFUNDED: [],
    FAILED: [],
  },
  api_calls: {
    RECEIVED: ['REJECTED', 'PAYMENT_REQUIRED', 'CHARGED', 'NOT_CHARGED'],
    CHARGED: ['PARTIALLY_CREDITED', 'CREDITED'],
    PARTIALLY_CREDITED: ['CREDITED'],
    CREDITED: [],
    REJECTED: [],
    PAYMENT_REQUIRED: [],
    NOT_CHARGED: [],
  },
  claims: {
    OPEN: ['AUTO_CREDITED', 'CREDITED', 'REJECTED'],
    AUTO_CREDITED: [],
    CREDITED: [],
    REJECTED: [],
  },
  balance_refunds: {
    REQUESTED: ['PENDING', 'COMPLETED', 'FAILED'],
    PENDING: ['COMPLETED', 'FAILED'],
    COMPLETED: [],
    FAILED: [],
  },
  payout_batches: {
    BUILDING: ['SUBMITTED', 'FAILED'],
    SUBMITTED: ['PENDING', 'PROCESSING', 'SUCCESS', 'PARTIAL', 'DENIED', 'FAILED'],
    PENDING: ['PROCESSING', 'SUCCESS', 'PARTIAL', 'DENIED', 'FAILED'],
    PROCESSING: ['SUCCESS', 'PARTIAL', 'DENIED', 'FAILED'],
    SUCCESS: [],
    PARTIAL: [],
    DENIED: [],
    FAILED: [],
  },
  // UNCLAIMED -> SUCCESS: the receiver opens a PayPal account within 30 days.
  payout_items: {
    PENDING: ['SUCCESS', 'UNCLAIMED', 'FAILED'],
    UNCLAIMED: ['SUCCESS', 'RETURNED'],
    SUCCESS: [],
    RETURNED: [],
    FAILED: [],
  },
} as const satisfies Record<string, Record<string, readonly string[]>>;

type Machines = typeof MACHINES;
export type StatusTable = keyof Machines;
export type StatusOf<T extends StatusTable> = keyof Machines[T] & string;

export const STATUS_TABLES = Object.keys(MACHINES) as StatusTable[];

export function statusesOf<T extends StatusTable>(table: T): StatusOf<T>[] {
  return Object.keys(MACHINES[table]) as StatusOf<T>[];
}

export function canTransition<T extends StatusTable>(table: T, from: StatusOf<T>, to: StatusOf<T>): boolean {
  const edges = (MACHINES[table] as Record<string, readonly string[]>)[from];
  return edges?.includes(to) ?? false;
}

export class InvalidTransitionError extends Error {
  constructor(table: StatusTable, from: string, to: string) {
    super(`${table}: ${from} -> ${to} is not in the state machine`);
    this.name = 'InvalidTransitionError';
  }
}

const COLUMN_RE = /^[a-z_][a-z0-9_]*$/;
const RESERVED = new Set(['id', 'status', 'created_at']);

export async function transition<T extends StatusTable, R = Record<string, unknown>>(
  tx: Queryable,
  table: T,
  id: string,
  from: StatusOf<T> | readonly StatusOf<T>[],
  to: StatusOf<T>,
  extra: Record<string, unknown> = {},
): Promise<R | null> {
  if (!(table in MACHINES)) throw new Error(`transition: unknown table ${String(table)}`);
  const froms = (Array.isArray(from) ? from : [from]) as StatusOf<T>[];
  if (froms.length === 0) throw new Error('transition: `from` is empty');
  for (const f of froms) {
    if (!canTransition(table, f, to)) throw new InvalidTransitionError(table, f, to);
  }

  const params: unknown[] = [id, froms, to];
  const sets = ['status = $3'];
  for (const [col, value] of Object.entries(extra)) {
    if (!COLUMN_RE.test(col) || RESERVED.has(col)) throw new Error(`transition: bad extra column ${col}`);
    params.push(value);
    sets.push(`"${col}" = $${params.length}`);
  }

  const { rows } = await tx.query(
    `UPDATE "${table}" SET ${sets.join(', ')} WHERE id = $1 AND status = ANY($2::text[]) RETURNING *`,
    params,
  );
  return (rows[0] as R | undefined) ?? null;
}
