import type { FastifyPluginAsync } from 'fastify';
import { requireBuyerSession } from '../auth/buyerAuth.js';
import { balanceOf } from '../topups/index.js';

/**
 * W11 buyer portal reads (SP-032; screens.md §W11). Session cookie only:
 * - `GET /api/buyer/balance` → `{ balanceMicros }`, the signed-in buyer's prepaid balance.
 * - `GET /api/buyer/paypal-config` → `{ clientId, environment }` for the JS SDK v6 button.
 *   The **client id only**: it is public by design (PayPal's browser SDK needs it). The client
 *   secret never leaves the server. `clientId` is null under `PAYPAL_MODE=stub` (FakePayPal has
 *   no browser approval), so the page shows that the button needs the sandbox.
 * Tenancy: `security/tenancy/buyer-portal.cases.ts`.
 */
const buyerPortalRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/buyer/balance', async (req, reply) => {
    const buyer = requireBuyerSession(req);
    reply.header('Cache-Control', 'no-store');
    return { balanceMicros: await balanceOf(app.db.pool, buyer.id) };
  });

  app.get('/api/buyer/paypal-config', async (req) => {
    requireBuyerSession(req);
    const { config } = app;
    return {
      clientId: config.PAYPAL_MODE === 'stub' ? null : config.PAYPAL_CLIENT_ID,
      environment: config.PAYPAL_ENV === 'live' ? 'production' : 'sandbox',
    };
  });
};

export default buyerPortalRoutes;
