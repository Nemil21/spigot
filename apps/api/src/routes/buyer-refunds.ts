import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireBuyerSession } from '../auth/buyerAuth.js';
import { ApiError, parse } from '../http/errors.js';
import { checkClientKey } from '../meter/idempotency.js';
import { refundPayPal, type RefundDeps } from '../refunds/deps.js';
import {
  listRefunds,
  MAX_REFUND_CENTS,
  refundAvailability,
  refundView,
  requestRefund,
} from '../refunds/refund.js';

/**
 * Refund of unused balance (api.md §Buyer portal endpoints; features/10; SP-049):
 * - `POST /api/buyer/refunds { amountCents }` (Idempotency-Key required) → `201 { refunds[],
 *   totalCents, balanceMicros, autoTopupDisabled }`; a replay of the key → `200` with the same
 *   refunds. Above `min(balance, unrefunded captures ≤ 180 days)` → `422 REFUND_EXCEEDS_UNUSED`.
 * - `GET /api/buyer/refunds` → the buyer's refunds (newest first) and what is refundable now.
 * Always the signed-in buyer's own balance (tenancy: `security/tenancy/refunds.cases.ts`).
 */
const refundBody = z.object({
  amountCents: z.number().int().positive().max(MAX_REFUND_CENTS),
});

const buyerRefundRoutes: FastifyPluginAsync = async (app) => {
  const deps = (): RefundDeps => ({ db: app.db, pp: refundPayPal(app.config) });

  app.post('/api/buyer/refunds', async (req, reply) => {
    const buyer = requireBuyerSession(req);
    const header = req.headers['idempotency-key'];
    if (typeof header !== 'string' || header === '') {
      throw new ApiError('VALIDATION_ERROR', 'The Idempotency-Key header is required.');
    }
    const idempotencyKey = checkClientKey(header);
    const { amountCents } = parse(refundBody, req.body, 'refund');
    const result = await requestRefund(deps(), {
      buyerId: buyer.id,
      amountCents,
      idempotencyKey,
      actor: { actorType: 'BUYER', actorId: buyer.id },
    });
    return reply.code(result.replay ? 200 : 201).send({
      refunds: result.refunds.map(refundView),
      totalCents: result.refunds.reduce((s, r) => s + r.amountCents, 0),
      balanceMicros: result.balanceMicros,
      autoTopupDisabled: result.autoTopupDisabled,
      ...(result.replay ? { replay: true } : {}),
    });
  });

  app.get('/api/buyer/refunds', async (req) => {
    const buyer = requireBuyerSession(req);
    const [refunds, avail] = await Promise.all([
      listRefunds(app.db.pool, buyer.id),
      refundAvailability(app.db.pool, buyer.id, Date.now()),
    ]);
    return {
      refunds: refunds.map(refundView),
      available: {
        balanceCents: avail.balanceCents,
        refundableCents: avail.refundableCents,
        allowedCents: avail.allowedCents,
      },
    };
  });
};

export default buyerRefundRoutes;
