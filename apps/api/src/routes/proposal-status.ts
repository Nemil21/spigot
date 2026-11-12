import type { FastifyPluginAsync } from 'fastify';
import { requirePublisher } from '../auth/publisherAuth.js';
import { forPublisher } from '../tenancy.js';

/**
 * W05 progress (SP-028; screens.md §W05 states): what the schema agent is doing on a site, next
 * to SP-014b's `GET /api/sites/:id/proposals` (which lists only finished PROPOSED datasets).
 *
 * `GET /api/sites/:id/proposal-status` →
 *   `{ siteStatus, crawling, running, templates: [{ pattern, pageCount, state }], message }`
 *
 * - `crawling`: a non-APPROVE crawl run is QUEUED / RUNNING (the discovery crawl).
 * - `running`: a proposal run started and hasn't finished (SP-012a's `SCHEMA_PROPOSAL_STARTED`
 *   newer than its `SCHEMA_PROPOSAL_DONE`, started in the last 10 minutes), or the site is
 *   PROPOSING with no finished run yet.
 * - `templates` while running: every template without a dataset yet, `state: 'reading'` (the
 *   "reading 5 sample pages…" line). Otherwise: the last finished run's templates that produced
 *   nothing, `state: 'skipped'` (rejected / no consistent fields) or `'failed'` (model
 *   unavailable; the resume job retries). `pattern` is the template's URL regex while reading and
 *   the display pattern (`/blog/:slug`) from the run's audit row afterwards.
 * - `message`: the run's empty-state note (`no repeated structure found`, …) or null.
 *
 * The model's failure reasons stay in the audit log; the screen uses fixed copy. Another
 * publisher's site → 404 (`security/tenancy/proposal-status.cases.ts`).
 */

export type TemplateState = 'reading' | 'skipped' | 'failed';

/** A STARTED row older than this with no DONE after it is a crashed run, not a running one. */
const RUN_STALE_MS = 10 * 60_000;

interface AuditRow {
  id: string;
  at: Date;
  data: {
    message?: unknown;
    templates?: { pathPattern?: unknown; pageCount?: unknown; status?: unknown }[];
  } | null;
}

const proposalStatusRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string } }>('/api/sites/:id/proposal-status', async (req) => {
    const publisher = requirePublisher(req);
    const scope = forPublisher(publisher.id);
    const q = app.db.pool;
    const site = await scope.get<{ id: string; status: string }>(q, 'sites', req.params.id, {
      columns: 't.id, t.status',
    });

    const crawl = await q.query(
      `SELECT 1 FROM crawl_runs
        WHERE site_id = $1 AND status IN ('QUEUED', 'RUNNING') AND trigger <> 'APPROVE' LIMIT 1`,
      [site.id],
    );

    const lastAudit = async (action: string) =>
      (
        await q.query<AuditRow>(
          `SELECT id, at, data FROM audit_events
            WHERE publisher_id = $1 AND entity = 'sites' AND entity_id = $2 AND action = $3
            ORDER BY id DESC LIMIT 1`,
          [publisher.id, site.id, action],
        )
      ).rows[0] ?? null;
    const started = await lastAudit('SCHEMA_PROPOSAL_STARTED');
    const done = await lastAudit('SCHEMA_PROPOSAL_DONE');

    const startedAfterDone = !!started && (!done || BigInt(started.id) > BigInt(done.id));
    const running =
      (startedAfterDone &&
        started !== null &&
        Date.now() - new Date(started.at).getTime() < RUN_STALE_MS) ||
      (site.status === 'PROPOSING' && (!done || startedAfterDone));

    let templates: { pattern: string; pageCount: number; state: TemplateState }[] = [];
    if (running) {
      const { rows } = await q.query<{ url_pattern: string; page_count: number | null }>(
        `SELECT t.url_pattern, t.page_count FROM templates t
          WHERE t.site_id = $1
            AND NOT EXISTS (SELECT 1 FROM datasets d WHERE d.template_id = t.id)
          ORDER BY t.page_count DESC NULLS LAST, t.url_pattern`,
        [site.id],
      );
      templates = rows.map((r) => ({
        pattern: r.url_pattern,
        pageCount: r.page_count ?? 0,
        state: 'reading',
      }));
    } else if (done) {
      for (const t of done.data?.templates ?? []) {
        const state: TemplateState | null =
          t.status === 'failed'
            ? 'failed'
            : t.status === 'rejected' || t.status === 'skipped'
              ? 'skipped'
              : null;
        if (!state || typeof t.pathPattern !== 'string') continue;
        templates.push({
          pattern: t.pathPattern,
          pageCount: typeof t.pageCount === 'number' ? t.pageCount : 0,
          state,
        });
      }
    }

    const message = !running && typeof done?.data?.message === 'string' ? done.data.message : null;
    return {
      siteStatus: site.status,
      crawling: (crawl.rowCount ?? 0) > 0,
      running,
      templates,
      message,
    };
  });
};

export default proposalStatusRoutes;
