import type pg from 'pg';
import { buildBatch, type BuiltItem, type PayoutTrigger } from './buildBatch.js';
import { submitBatch, type PayoutsClient, type SubmitOutcome } from './submit.js';

/**
 * `payoutRun` (SP-020; features/09 §Logic 1–6, data-model rules 5 and 10): the Render Workflows
 * task (`@spigot/api/tasks`) and the in-process "Run payout now".
 *
 * 1. Check out **one** pooled client for the whole run and take the session lock
 *    `pg_advisory_lock('payout')` on it; `pg_advisory_unlock` in `finally` before the client goes
 *    back to the pool, so the lock never leaks into another checkout.
 * 2. Resume first: a BUILDING or SUBMITTED batch with items (a crashed run) is resubmitted with
 *    the same `sender_batch_id`, and the run ends there.
 * 3. Otherwise build a new batch (`buildBatch`) and submit it (`submitBatch`).
 *
 * Two runs at once: the second waits for the lock, then finds every publisher with a PENDING item
 * and builds nothing.
 */

export type { PayoutTrigger } from './buildBatch.js';

export interface PayoutRunArgs {
  trigger: PayoutTrigger;
  /** MANUAL_DEMO only (labelled demo control): threshold for this run, min $1. */
  thresholdCentsOverride?: number;
  /** SCHEDULE runs are unique per `period_end`. Default now. */
  periodEnd?: Date;
}

export interface PayoutRunDeps {
  pool: pg.Pool;
  /** SP-001b's PayPal client (or `moneyOut(...)` over FakePayPal). */
  pp: PayoutsClient;
  /** Tries for a call PayPal didn't answer. Default 3. */
  attempts?: number;
  /** Backoff unit between tries. Default 1000 ms. */
  retryDelayMs?: number;
}

export type PayoutRunResult =
  | { outcome: 'NO_ITEMS'; resumed: false; batchId: null }
  /** A SCHEDULE batch for this period already exists. */
  | { outcome: 'PERIOD_TAKEN'; resumed: false; batchId: null }
  | ({
      batchId: string;
      resumed: boolean;
      /** Items of a new batch; on resume, the ids are in the database. */
      items: BuiltItem[];
    } & (
      | { outcome: 'PENDING'; paypalBatchId: string }
      | {
          outcome: 'NEEDS_RECONCILE' | 'FAILED' | 'RETRY_LATER';
          errorCode: string;
        }
    ));

let defaultDeps: PayoutRunDeps | undefined;

/**
 * Wire the deps once at boot (API process, Workflows entry) so callers can write
 * `payoutRun('MANUAL_DEMO', { thresholdCentsOverride: 100 })` without passing them.
 */
export function setPayoutRunDeps(deps: PayoutRunDeps | undefined): void {
  defaultDeps = deps;
}

export const PAYOUT_LOCK = 'payout';

export function payoutRun(args: PayoutRunArgs, deps?: PayoutRunDeps): Promise<PayoutRunResult>;
export function payoutRun(
  trigger: PayoutTrigger,
  opts?: Omit<PayoutRunArgs, 'trigger'>,
  deps?: PayoutRunDeps,
): Promise<PayoutRunResult>;
export async function payoutRun(
  a: PayoutRunArgs | PayoutTrigger,
  b?: Omit<PayoutRunArgs, 'trigger'> | PayoutRunDeps,
  c?: PayoutRunDeps,
): Promise<PayoutRunResult> {
  const args: PayoutRunArgs =
    typeof a === 'string'
      ? { trigger: a, ...(b as Omit<PayoutRunArgs, 'trigger'> | undefined) }
      : a;
  const deps = (typeof a === 'string' ? c : (b as PayoutRunDeps | undefined)) ?? defaultDeps;
  if (!deps) throw new Error('payoutRun needs { pool, pp }: pass them or call setPayoutRunDeps()');
  if (args.trigger !== 'SCHEDULE' && args.trigger !== 'MANUAL_DEMO') {
    throw new TypeError(`unknown payout trigger ${String(args.trigger)}`);
  }

  const client = await deps.pool.connect();
  let locked = false;
  let broken: Error | undefined;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [PAYOUT_LOCK]);
    locked = true;
    return await runLocked(client, args, deps);
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [PAYOUT_LOCK]);
      } catch (err) {
        // Destroy the connection instead: Postgres drops the lock with it.
        broken = err instanceof Error ? err : new Error(String(err));
      }
    }
    client.release(broken);
  }
}

async function runLocked(
  client: pg.PoolClient,
  args: PayoutRunArgs,
  deps: PayoutRunDeps,
): Promise<PayoutRunResult> {
  const submitOpts = {
    pp: deps.pp,
    ...(deps.attempts !== undefined ? { attempts: deps.attempts } : {}),
    ...(deps.retryDelayMs !== undefined ? { retryDelayMs: deps.retryDelayMs } : {}),
  };

  // 2. Resume a crashed run. A needs_reconcile batch is not resubmitted: PayPal has it already.
  const { rows: resumable } = await client.query<{ id: string }>(
    `SELECT b.id FROM payout_batches b
     WHERE b.status IN ('BUILDING', 'SUBMITTED') AND NOT b.needs_reconcile
       AND EXISTS (SELECT 1 FROM payout_items i WHERE i.batch_id = b.id AND i.status = 'PENDING')
     ORDER BY b.created_at, b.id`,
  );
  if (resumable.length > 0) {
    let last: PayoutRunResult | undefined;
    for (const { id } of resumable) {
      last = withOutcome(id, true, [], await submitBatch(client, id, submitOpts));
    }
    return last!;
  }

  // 3. Build, then 4b–7 submit.
  const built = await buildBatch(client, args);
  if (built.kind === 'NO_ITEMS') return { outcome: 'NO_ITEMS', resumed: false, batchId: null };
  if (built.kind === 'PERIOD_TAKEN')
    return { outcome: 'PERIOD_TAKEN', resumed: false, batchId: null };
  return withOutcome(
    built.batchId,
    false,
    built.items,
    await submitBatch(client, built.batchId, submitOpts),
  );
}

function withOutcome(
  batchId: string,
  resumed: boolean,
  items: BuiltItem[],
  o: SubmitOutcome,
): PayoutRunResult {
  if (o.status === 'PENDING') {
    return { outcome: 'PENDING', paypalBatchId: o.paypalBatchId, batchId, resumed, items };
  }
  return { outcome: o.status, errorCode: o.errorCode, batchId, resumed, items };
}
