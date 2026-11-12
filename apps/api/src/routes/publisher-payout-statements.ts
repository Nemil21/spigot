import type { FastifyPluginAsync } from 'fastify';
import { requirePublisher } from '../auth/publisherAuth.js';
import { payoutStatements } from '../payouts/statements.js';

/**
 * `GET /api/publishers/me/payouts/statements` (SP-031; W09 statement drawer and run-now confirm):
 * the caller's statement per payout item (records sold, gross, commission, SIM share, rounding
 * carried forward) and a preview of the next payout's statement. Only the caller's own items and
 * ledger lines are read. Tenancy: `security/tenancy/payout-statements.cases.ts`.
 */
const publisherPayoutStatementRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/publishers/me/payouts/statements', async (req) => {
    const me = requirePublisher(req);
    return payoutStatements(app.db.pool, me.id);
  });
};

export default publisherPayoutStatementRoutes;
