import type { FastifyPluginAsync } from 'fastify';
import { adminOnly } from '../auth/admin.js';
import { requirePublisher } from '../auth/publisherAuth.js';
import { parse } from '../http/errors.js';
import { auditSearchQuery, searchAudit } from '../ops/auditSearch.js';
import { adminHealth } from '../ops/health.js';
import { recordLedgerCheck } from '../ops/ledgerStatus.js';
import { createPayPalClient } from '../paypal/index.js';

/**
 * Ops endpoints, admin only (api.md §Ops; features/14 §Audit and ops; SP-043). Every route in
 * this file runs `adminOnly` first: no session → 401, a non-admin (or buyer) → 403.
 * - `GET /admin/audit?publisherId&entity&paypalId&actorId&action&from&to&limit&cursor` → `{ events, next }`.
 * - `POST /admin/ledger/check` → `{ sumMicros, accountsChecked, mismatches }` (features/07).
 *   Recorded like the nightly check (SP-061), so a clean re-run clears health's ledger flag.
 * - `GET /admin/health` → PayPal token, DB, Workflows, last gate hit per site, open top-ups,
 *   pending payout items; `status: 'degraded'` when a dependency check fails.
 * `POST /admin/payouts/run` belongs to SP-021 and lives in its own file.
 */
const adminRoutes: FastifyPluginAsync = async (app) => {
  // Encapsulated by autoload: this hook covers this file's routes only.
  app.addHook('preHandler', adminOnly);

  app.get('/admin/audit', async (req) => {
    const query = parse(auditSearchQuery, req.query, 'audit search');
    return searchAudit(app.db.pool, query);
  });

  app.post('/admin/ledger/check', async (req) =>
    recordLedgerCheck(app.db, {
      trigger: 'MANUAL',
      actorType: 'PUBLISHER',
      actorId: requirePublisher(req).id,
    }),
  );

  app.get('/admin/health', async () =>
    adminHealth({
      pool: app.db.pool,
      config: app.config,
      // A fresh client per call, so the check mints a real token instead of reading a cache.
      paypalToken: () => createPayPalClient(app.config).http.token(),
    }),
  );
};

export default adminRoutes;
