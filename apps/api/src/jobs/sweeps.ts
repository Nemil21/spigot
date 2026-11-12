import { CHANGES_RETENTION_DAYS } from '../records/changes.js';
import { TOPUP_COLUMNS, type TopupRow } from '../topups/index.js';
import { nowOf, type JobDeps } from './deps.js';
import { POLL_BATCH, POLL_WINDOW_MS, settleAll, type PollResult } from './topupPoller.js';

/**
 * SP-019 sweeps.
 *
 * **ABANDONED sweep (every 5 min)** (features/08 §Edge cases, data-model §Top-up state machine):
 * AWAITING_APPROVAL top-ups 30 min or older move to ABANDONED, and it never strands money:
 * - rows with a `paypal_capture_id`, a `pending_reason` or `needs_reconcile` are never abandoned;
 * - each candidate gets one `pp.getOrder` first: APPROVED → capture and credit, COMPLETED → credit,
 *   PENDING → `pending_reason` recorded; only an order the buyer never approved is abandoned;
 * - PayPal not answering → the row is left for the next sweep (404 = no order → abandoned).
 * A capture after the sweep still credits once (`creditTopup` takes ABANDONED → COMPLETED).
 *
 * The same tick re-checks PENDING captures past the poller's 30-minute window (once per sweep),
 * so an eCheck that clears later is credited even without the webhook.
 *
 * **Retention (hourly):** `api_calls.response_body` is nulled 24 h after the call (a replay then
 * gets `409 IDEMPOTENCY_KEY_EXPIRED`, SP-016); `served_record_keys` is kept (claims need ≥ 7 days,
 * SP-048a). `record_versions` older than 30 days are deleted (a cursor into them gets
 * `410 CURSOR_EXPIRED`, SP-015).
 */

export const ABANDON_EVERY_MS = 5 * 60_000;
export const RETENTION_EVERY_MS = 60 * 60_000;
export const RESPONSE_BODY_TTL_MS = 24 * 60 * 60_000;
export const RECORD_VERSIONS_TTL_MS = CHANGES_RETENTION_DAYS * 24 * 60 * 60_000;
/** Rows per statement, so a big backlog never holds long locks. */
export const PURGE_BATCH = 5_000;

export interface AbandonSweepResult {
  stale: PollResult;
  pending: PollResult;
}

export async function abandonStaleTopups(deps: JobDeps): Promise<AbandonSweepResult> {
  const cutoff = new Date(nowOf(deps) - POLL_WINDOW_MS);
  const stale = await deps.db.pool.query<TopupRow>(
    `SELECT ${TOPUP_COLUMNS} FROM topups
      WHERE status = 'AWAITING_APPROVAL' AND created_at <= $1
        AND paypal_capture_id IS NULL AND pending_reason IS NULL AND NOT needs_reconcile
      ORDER BY created_at LIMIT $2`,
    [cutoff, POLL_BATCH],
  );
  const pending = await deps.db.pool.query<TopupRow>(
    `SELECT ${TOPUP_COLUMNS} FROM topups
      WHERE status = 'AWAITING_APPROVAL' AND created_at <= $1
        AND paypal_order_id IS NOT NULL AND pending_reason IS NOT NULL
      ORDER BY created_at LIMIT $2`,
    [cutoff, POLL_BATCH],
  );
  const actor = { actorType: 'SYSTEM' as const, actorId: 'job:topup-abandon-sweep' };
  return {
    stale: await settleAll(deps, stale.rows, { abandonIfUnapproved: true, actor }),
    pending: await settleAll(deps, pending.rows, { actor }),
  };
}

/** Null `response_body` on calls older than 24 h. Returns the number of rows purged. */
export async function purgeResponseBodies(deps: Pick<JobDeps, 'db' | 'now'>): Promise<number> {
  const cutoff = new Date(nowOf(deps) - RESPONSE_BODY_TTL_MS);
  let total = 0;
  for (;;) {
    const { rowCount } = await deps.db.pool.query(
      `UPDATE api_calls SET response_body = NULL
        WHERE id IN (SELECT id FROM api_calls
                      WHERE response_body IS NOT NULL AND created_at < $1
                      LIMIT $2 FOR UPDATE SKIP LOCKED)`,
      [cutoff, PURGE_BATCH],
    );
    total += rowCount ?? 0;
    if ((rowCount ?? 0) < PURGE_BATCH) return total;
  }
}

/** Delete `record_versions` older than 30 days. Returns the number of rows deleted. */
export async function pruneRecordVersions(deps: Pick<JobDeps, 'db' | 'now'>): Promise<number> {
  const cutoff = new Date(nowOf(deps) - RECORD_VERSIONS_TTL_MS);
  let total = 0;
  for (;;) {
    const { rowCount } = await deps.db.pool.query(
      `DELETE FROM record_versions
        WHERE seq IN (SELECT seq FROM record_versions WHERE changed_at < $1
                       ORDER BY seq LIMIT $2 FOR UPDATE SKIP LOCKED)`,
      [cutoff, PURGE_BATCH],
    );
    total += rowCount ?? 0;
    if ((rowCount ?? 0) < PURGE_BATCH) return total;
  }
}

export async function retentionSweep(
  deps: Pick<JobDeps, 'db' | 'now'>,
): Promise<{ responseBodies: number; recordVersions: number }> {
  return {
    responseBodies: await purgeResponseBodies(deps),
    recordVersions: await pruneRecordVersions(deps),
  };
}
