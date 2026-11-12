import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { adminOnly, requireAdmin } from '../auth/admin.js';
import { ApiError, parse } from '../http/errors.js';
import { payoutPayPal } from '../payouts/deps.js';
import { payoutRun } from '../payouts/payoutRun.js';
import { reconcileBatch } from '../payouts/poll.js';
import { notifyBatchPublishers } from '../payouts/reconcile.js';
import { isUuid } from '../tenancy.js';
import { DEMO_THRESHOLD_CENTS, runSummary } from './publisher-payouts.js';

/**
 * Admin payout ops (api.md §Ops; SP-021), admin only (non-admin publisher 403, else 401):
 * - `POST /admin/payouts/run` `{ trigger: "MANUAL_DEMO", thresholdCentsOverride: 100 }` → the
 *   run's outcome and every item (W14 "Run payout now"). Both fields optional; the override is a
 *   labelled demo control, min $1.
 * - `POST /admin/payouts/:batchId/reconcile` `{ paypalBatchId }` → resolve SP-020's
 *   `needs_reconcile` batch: PayPal must confirm the batch's `sender_batch_id` is ours, then the
 *   batch goes PENDING and its item statuses are applied.
 */
const runBody = z
  .object({
    trigger: z.literal('MANUAL_DEMO').default('MANUAL_DEMO'),
    thresholdCentsOverride: z.number().int().min(DEMO_THRESHOLD_CENTS).max(10_000_000).optional(),
  })
  .strict();

const reconcileBody = z.object({ paypalBatchId: z.string().trim().min(1).max(64) }).strict();

const adminPayoutRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', adminOnly);
  const deps = () => ({ pool: app.db.pool, pp: payoutPayPal(app.config) });

  app.post('/admin/payouts/run', async (req) => {
    const body = parse(runBody, req.body ?? {}, 'payout run');
    const result = await payoutRun(
      body.trigger,
      { thresholdCentsOverride: body.thresholdCentsOverride ?? DEMO_THRESHOLD_CENTS },
      deps(),
    );
    if (result.batchId) await notifyBatchPublishers(app.db.pool, result.batchId);
    return { demoControl: true, ...runSummary(result) };
  });

  app.post('/admin/payouts/:batchId/reconcile', async (req) => {
    const admin = await requireAdmin(req);
    const { batchId } = req.params as { batchId?: string };
    if (!isUuid(batchId)) throw new ApiError('NOT_FOUND', 'No such payout batch.');
    const { paypalBatchId } = parse(reconcileBody, req.body, 'reconcile');
    const polled = await reconcileBatch(deps(), batchId, paypalBatchId, admin.id);
    return {
      batchId: polled.batchId,
      paypalBatchId: polled.paypalBatchId,
      paypalStatus: polled.paypalStatus,
      status: polled.batchStatus,
      items: polled.applied.map((a) => ({ id: a.itemId, status: a.status, changed: a.changed })),
    };
  });
};

export default adminPayoutRoutes;
