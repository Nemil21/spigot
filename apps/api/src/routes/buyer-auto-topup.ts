import type { FastifyPluginAsync } from 'fastify';
import { requireBuyerSession } from '../auth/buyerAuth.js';
import { parse } from '../http/errors.js';
import {
  autoTopupBody,
  getAutoTopupSettings,
  updateAutoTopupSettings,
} from '../topups/autoTopupSettings.js';

/**
 * W11's auto top-up card (api.md §Buyer portal endpoints; screens.md §W11, §W15; SP-047b):
 * - `GET /api/buyer/auto-topup` → the settings, saved method, this month's used / remaining cap,
 *   `capReached` and `declinedAt` (the two W15 banners).
 * - `PUT /api/buyer/auto-topup { enabled, amountCents, thresholdMicros, monthlyCapCents }` → the
 *   same view. Amount $5–$500, cap ≥ amount (400 `VALIDATION_ERROR`); `enabled: true` without a
 *   saved method → 422 `NO_SAVED_METHOD`.
 * Always the signed-in buyer's own row. Tenancy: `security/tenancy/buyer-auto-topup.cases.ts`.
 */
const buyerAutoTopupRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/buyer/auto-topup', async (req, reply) => {
    const buyer = requireBuyerSession(req);
    reply.header('Cache-Control', 'no-store');
    return getAutoTopupSettings(app.db.pool, buyer.id);
  });

  app.put('/api/buyer/auto-topup', async (req) => {
    const buyer = requireBuyerSession(req);
    const body = parse(autoTopupBody, req.body ?? {}, 'auto top-up');
    return updateAutoTopupSettings(app.db, buyer.id, body);
  });
};

export default buyerAutoTopupRoutes;
