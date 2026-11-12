import type pg from 'pg';
import { payoutRun, type PayoutRunDeps, type PayoutRunResult } from './payoutRun.js';

/**
 * SP-060: the weekly payout (features/09 §Logic 9): Monday 09:00 PT → `payoutRun('SCHEDULE')`.
 *
 * Runs in-process (`jobs/payout-weekly.job.ts`, every 5 min under the job's advisory lock), not as
 * a Render cron: Render cron schedules are UTC, so "09:00 PT" would drift an hour across DST.
 *
 * - **One batch per week.** `period_end` is the Monday 09:00 PT slot itself (not the firing time),
 *   so every firing for the same week asks for the same `period_end`, and `payout_batches`'
 *   unique(period_end) for SCHEDULE turns the second one into `PERIOD_TAKEN`.
 * - **Catch-up window.** A firing up to 24 h after the slot still runs it (a deploy or restart
 *   across 09:00 doesn't skip a week); later firings wait for the next Monday.
 * - **An empty week stays empty.** `buildBatch` deletes a batch with no items, so a NO_ITEMS run
 *   leaves no row behind; the slot is recorded in `job_ticks` instead, and later firings that week
 *   do nothing (a publisher who crosses the threshold on Monday afternoon is paid next Monday).
 * - **Retry of failed items** needs nothing here: SP-021 posts `PAYOUT_RETURNED` for a FAILED /
 *   RETURNED item, so its amount is back in payable and `buildBatch` picks it up next week. A
 *   publisher with an UNCLAIMED (or PENDING) item is skipped until it resolves (data-model rule 10).
 * - A crashed run (SUBMITTED, RETRY_LATER) is resumed by the next firing in the window, because
 *   `payoutRun` resumes before it builds.
 */

export const WEEKLY_EVERY_MS = 5 * 60_000;
export const WEEKLY_CATCH_UP_MS = 24 * 60 * 60_000;
/** `job_ticks` row holding the last slot that ran empty (minutes since the epoch). */
export const WEEKLY_EMPTY_SLOT = 'payouts.weekly.empty-slot';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function ptParts(at: Date) {
  const p = Object.fromEntries(PT.formatToParts(at).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    weekday: WEEKDAYS.indexOf(p.weekday!),
    hour: Number(p.hour),
    minute: Number(p.minute),
  };
}

/** The instant of 09:00 PT on the PT calendar date `y-m-d` (PDT is UTC−7, PST is UTC−8). */
function nineAmPt(y: number, m: number, d: number): Date {
  for (const offset of [7, 8]) {
    const at = new Date(Date.UTC(y, m - 1, d, 9 + offset));
    const p = ptParts(at);
    if (p.day === d && p.hour === 9 && p.minute === 0) return at;
  }
  throw new Error(`no 09:00 PT on ${y}-${m}-${d}`);
}

/** The latest Monday 09:00 PT at or before `now`: the `period_end` of this week's batch. */
export function weeklySlot(now: Date): Date {
  const p = ptParts(now);
  let days = (p.weekday - 1 + 7) % 7;
  if (days === 0 && p.hour < 9) days = 7;
  // Calendar arithmetic on the PT date at UTC noon: no DST edge can move it a day.
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day, 12));
  d.setUTCDate(d.getUTCDate() - days);
  return nineAmPt(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

export type WeeklyPayoutResult =
  | { outcome: 'OUTSIDE_WINDOW' | 'EMPTY_SLOT'; periodEnd: Date }
  | (PayoutRunResult & { periodEnd: Date });

const slotTick = (slot: Date) => Math.floor(slot.getTime() / 60_000);

async function slotRanEmpty(pool: pg.Pool, slot: Date): Promise<boolean> {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM job_ticks WHERE name = $1 AND last_tick >= $2`,
    [WEEKLY_EMPTY_SLOT, slotTick(slot)],
  );
  return (rowCount ?? 0) > 0;
}

async function markSlotEmpty(pool: pg.Pool, slot: Date): Promise<void> {
  await pool.query(
    `INSERT INTO job_ticks (name, last_tick) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET last_tick = EXCLUDED.last_tick, last_run_at = now(),
                                      updated_at = now()
       WHERE job_ticks.last_tick < EXCLUDED.last_tick`,
    [WEEKLY_EMPTY_SLOT, slotTick(slot)],
  );
}

/** One firing of the weekly payout at `now` (a job tick, or a test's fake clock). */
export async function runWeeklyPayout(
  deps: PayoutRunDeps,
  now: Date = new Date(),
): Promise<WeeklyPayoutResult> {
  const periodEnd = weeklySlot(now);
  if (now.getTime() - periodEnd.getTime() >= WEEKLY_CATCH_UP_MS) {
    return { outcome: 'OUTSIDE_WINDOW', periodEnd };
  }
  if (await slotRanEmpty(deps.pool, periodEnd)) return { outcome: 'EMPTY_SLOT', periodEnd };

  const res = await payoutRun({ trigger: 'SCHEDULE', periodEnd }, deps);
  if (res.outcome === 'NO_ITEMS') await markSlotEmpty(deps.pool, periodEnd);
  return { ...res, periodEnd };
}
