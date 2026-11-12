// `npm run demo:payout` (SP-038; features/15 §Demo hooks): "Run payout now" with the $1 demo
// threshold, from a terminal. Same call as W09 / `POST /admin/payouts/run`:
// `payoutRun('MANUAL_DEMO', { thresholdCentsOverride: 100 })`. The payout advisory lock makes two
// runs at once build one batch; a crashed batch is resumed with its own `sender_batch_id`.
import type pg from 'pg';
import { payoutRun, type PayoutRunResult } from '../payouts/payoutRun.js';
import { notifyBatchPublishers } from '../payouts/reconcile.js';
import type { PayoutsClient } from '../payouts/submit.js';
import { DEMO_THRESHOLD_CENTS, runSummary } from '../routes/publisher-payouts.js';

export { DEMO_THRESHOLD_CENTS };

export type DemoPayoutSummary = ReturnType<typeof runSummary>;

export async function demoPayout(deps: {
  pool: pg.Pool;
  pp: PayoutsClient;
}): Promise<{ result: PayoutRunResult; summary: DemoPayoutSummary }> {
  const result = await payoutRun(
    'MANUAL_DEMO',
    { thresholdCentsOverride: DEMO_THRESHOLD_CENTS },
    { pool: deps.pool, pp: deps.pp },
  );
  if (result.batchId) await notifyBatchPublishers(deps.pool, result.batchId);
  return { result, summary: runSummary(result) };
}

/** The lines the CLI prints: outcome, batch ids, one line per item. */
export function formatPayout(s: DemoPayoutSummary): string[] {
  const lines = [
    `demo:payout (demo control, $${DEMO_THRESHOLD_CENTS / 100} threshold): ${s.outcome}`,
  ];
  if (s.outcome === 'NO_ITEMS') {
    lines.push(
      '  nothing to pay: no publisher has $1 or more payable (or one is already in flight)',
    );
    return lines;
  }
  if (s.batchId) lines.push(`  batch ${s.batchId}${s.resumed ? ' (resumed)' : ''}`);
  if (s.paypalBatchId) lines.push(`  PayPal payout_batch_id ${s.paypalBatchId}`);
  if (s.errorCode) lines.push(`  error ${s.errorCode}`);
  for (const i of s.items) {
    lines.push(
      `  item ${i.id}  publisher ${i.publisherId}  $${(i.netCents / 100).toFixed(2)} net  ${i.recordsSold} records`,
    );
  }
  return lines;
}
