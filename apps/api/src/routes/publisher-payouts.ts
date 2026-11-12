import type { FastifyPluginAsync } from 'fastify';
import { requirePublisher } from '../auth/publisherAuth.js';
import { ApiError } from '../http/errors.js';
import { payoutPayPal } from '../payouts/deps.js';
import { payoutRun, type PayoutRunResult } from '../payouts/payoutRun.js';
import { notifyBatchPublishers } from '../payouts/reconcile.js';
import { publisherPayouts } from '../payouts/view.js';

/**
 * Publisher payouts (api.md §Publisher endpoints; features/09; SP-021):
 * - `GET /api/publishers/me/payouts` → `{ isDemo, next, batches }`: the caller's batches with
 *   only the caller's items (status, PayPal batch / item ids, statement figures, fee), and the
 *   next-payout card (payable, threshold, next Monday).
 * - `POST /api/publishers/me/payouts/run` → **demo control** for the seeded `is_demo` publisher
 *   only (anyone else 403): `payoutRun('MANUAL_DEMO', { thresholdCentsOverride: 100 })`, the
 *   same run as `POST /admin/payouts/run`. Answers with the outcome and the caller's own item.
 * Tenancy: `security/tenancy/payouts.cases.ts`.
 */
export const DEMO_THRESHOLD_CENTS = 100;

/** A run's outcome without other publishers' items. */
export function runSummary(r: PayoutRunResult, publisherId?: string) {
  const items =
    'items' in r
      ? r.items.filter((i) => publisherId === undefined || i.publisherId === publisherId)
      : [];
  return {
    outcome: r.outcome,
    batchId: r.batchId,
    resumed: r.resumed,
    ...('paypalBatchId' in r ? { paypalBatchId: r.paypalBatchId } : {}),
    ...('errorCode' in r ? { errorCode: r.errorCode } : {}),
    items: items.map((i) => ({
      id: i.itemId,
      publisherId: i.publisherId,
      netCents: i.netCents,
      grossMicros: i.grossMicros,
      commissionMicros: i.commissionMicros,
      recordsSold: i.recordsSold,
    })),
  };
}

const publisherPayoutRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/publishers/me/payouts', async (req) => {
    const me = requirePublisher(req);
    const view = await publisherPayouts(app.db.pool, me.id);
    if (!view) throw new ApiError('UNAUTHENTICATED', 'Sign in to continue.');
    return view;
  });

  app.post('/api/publishers/me/payouts/run', async (req) => {
    const me = requirePublisher(req);
    const { rows } = await app.db.pool.query<{ isDemo: boolean }>(
      `SELECT is_demo AS "isDemo" FROM publishers WHERE id = $1`,
      [me.id],
    );
    if (!rows[0]?.isDemo) {
      throw new ApiError(
        'FORBIDDEN',
        'Run payout now is a demo control for the demo publisher only.',
      );
    }
    const result = await payoutRun(
      'MANUAL_DEMO',
      { thresholdCentsOverride: DEMO_THRESHOLD_CENTS },
      { pool: app.db.pool, pp: payoutPayPal(app.config) },
    );
    if (result.batchId) await notifyBatchPublishers(app.db.pool, result.batchId);
    return { demoControl: true, ...runSummary(result, me.id) };
  });
};

export default publisherPayoutRoutes;
