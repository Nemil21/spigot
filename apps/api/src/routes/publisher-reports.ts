import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requirePublisher } from '../auth/publisherAuth.js';
import { parse } from '../http/errors.js';
import { earnings, GROUP_DIMS, type GroupDim } from '../reports/earnings.js';
import { ledgerRows } from '../reports/ledgerRows.js';
import { checkRange, includeSimQuery, rangeQuery } from '../reports/query.js';

/**
 * Publisher earnings and ledger (api.md §Publisher dashboard endpoints; SP-030a; W08):
 * - `GET /api/publishers/me/earnings?from&to&groupBy=buyer|dataset|day&includeSim=true`
 *   → `{ kpis, rows }` (`reports/earnings.ts`). `groupBy` may also list several of
 *   `buyer,dataset,day,channel` (SP-030b: W08 reads `buyer,dataset,channel,day`).
 * - `GET /api/publishers/me/ledger?cursor&includeSim=true` → `{ rows, nextCursor }`, 100 per block
 * Both read only the session publisher's data; ids in the query are ignored
 * (`security/tenancy/earnings.cases.ts`).
 */

const groupByQuery = z
  .string()
  .max(64)
  .transform((s) => s.split(','))
  .pipe(
    z
      .array(z.enum(GROUP_DIMS))
      .min(1)
      .max(GROUP_DIMS.length)
      .refine((d) => new Set(d).size === d.length, 'Each groupBy dimension at most once.'),
  )
  .default(['buyer'] as GroupDim[]);

const earningsQuery = rangeQuery.extend(includeSimQuery.shape).extend({
  groupBy: groupByQuery,
});

const ledgerQuery = includeSimQuery.extend({ cursor: z.string().optional() });

const publisherReportRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/publishers/me/earnings', async (req) => {
    const publisher = requirePublisher(req);
    const q = parse(earningsQuery, req.query, 'earnings query');
    checkRange(q);
    return earnings(app.db.pool, { ...q, publisherId: publisher.id });
  });

  app.get('/api/publishers/me/ledger', async (req) => {
    const publisher = requirePublisher(req);
    const q = parse(ledgerQuery, req.query, 'ledger query');
    return ledgerRows(app.db.pool, { ...q, publisherId: publisher.id });
  });
};

export default publisherReportRoutes;
