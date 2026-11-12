import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireBuyerSession } from '../auth/buyerAuth.js';
import { parse } from '../http/errors.js';
import { checkRange, rangeQuery } from '../reports/query.js';
import { buyerCall, buyerUsage } from '../reports/usage.js';

/**
 * Buyer usage (api.md §Buyer portal endpoints; SP-030a; W12):
 * - `GET /api/buyer/usage?from&to&cursor` → `{ rows, nextCursor }`, newest first, 100 per page
 * - `GET /api/buyer/calls/:id` → one call with the record keys it served
 * Session only; another buyer's call is a 404 (`security/tenancy/usage.cases.ts`).
 */

const usageQuery = rangeQuery.extend({ cursor: z.string().optional() });

const buyerUsageRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/buyer/usage', async (req) => {
    const buyer = requireBuyerSession(req);
    const q = parse(usageQuery, req.query, 'usage query');
    checkRange(q);
    return buyerUsage(app.db.pool, { ...q, buyerId: buyer.id });
  });

  app.get<{ Params: { id: string } }>('/api/buyer/calls/:id', async (req) => {
    const buyer = requireBuyerSession(req);
    return buyerCall(app.db.pool, buyer.id, req.params.id);
  });
};

export default buyerUsageRoutes;
