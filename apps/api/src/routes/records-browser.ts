import type { FastifyPluginAsync } from 'fastify';
import { requirePublisher } from '../auth/publisherAuth.js';
import { RECORD_BACKED_STATUSES } from '../datasets/samples.js';
import {
  browseRecords,
  loadOwnerFields,
  MAX_VERSIONS,
  ownerFields,
  parseBrowseQuery,
} from '../records/browse.js';
import { forPublisher } from '../tenancy.js';

/**
 * W07 Records browser (SP-053; screens.md §W07). Publisher session only; another publisher's
 * site, dataset or record is a 404 (`security/tenancy/records-browser.cases.ts`). The owner sees
 * every field, hidden ones included, flagged `visible: false`; none of this is a buyer path.
 *
 * - `GET /api/sites/:id/datasets` → `{ datasets: [{ id, slug, typeName, status, recordCount,
 *   staleSince, fields: [{ name, type, visible, pii }] }] }`: the site's record-backed datasets
 *   (LIVE, LIVE_STALE, UNPUBLISHED), for the dataset picker and the grid's columns.
 * - `GET /api/datasets/:id/records?startRow&endRow&sortModel&filterModel` → `{ rows, rowCount,
 *   staleSince }`: one AG Grid server-side block (≤ 100 rows) of live records. Column ids are
 *   `key`, `version`, `updatedAt`, `crawledAt`, `sourceLastmod` and `data.<field>`.
 * - `GET /api/records/:id/versions` → `{ record, hiddenFields, versions: [{ seq, version, op,
 *   patch, changedAt, crawlRunId }], truncated }`: newest first, the stored JSON Patch as is.
 */
const recordsBrowserRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string } }>('/api/sites/:id/datasets', async (req) => {
    const scope = forPublisher(requirePublisher(req).id);
    const q = app.db.pool;
    const site = await scope.get<{ id: string }>(q, 'sites', req.params.id, { columns: 't.id' });
    const { rows } = await q.query<{
      id: string;
      slug: string;
      type_name: string;
      status: string;
      record_count: number | null;
      stale_since: Date | null;
      fields: unknown;
    }>(
      `SELECT d.id, d.slug, d.type_name, d.status, d.record_count, d.stale_since,
              (SELECT sv.fields FROM schema_versions sv WHERE sv.dataset_id = d.id
                ORDER BY (sv.id = d.active_schema_id) DESC NULLS LAST, sv.version DESC LIMIT 1) AS fields
         FROM datasets d
        WHERE d.site_id = $1 AND d.status = ANY($2::text[])
        ORDER BY d.record_count DESC NULLS LAST, d.slug`,
      [site.id, RECORD_BACKED_STATUSES],
    );
    return {
      datasets: rows.map((d) => ({
        id: d.id,
        slug: d.slug,
        typeName: d.type_name,
        status: d.status,
        recordCount: d.record_count ?? 0,
        staleSince: d.stale_since,
        fields: ownerFields(d.fields),
      })),
    };
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>(
    '/api/datasets/:id/records',
    async (req) => {
      const scope = forPublisher(requirePublisher(req).id);
      const q = app.db.pool;
      const d = await scope.get<{ id: string; stale_since: Date | null }>(
        q,
        'datasets',
        req.params.id,
        { columns: 't.id, t.stale_since' },
      );
      const input = parseBrowseQuery(req.query);
      const fields = await loadOwnerFields(q, d.id);
      const { rows, rowCount } = await browseRecords(q, d.id, fields, input);
      return { rows, rowCount, staleSince: d.stale_since };
    },
  );

  app.get<{ Params: { id: string } }>('/api/records/:id/versions', async (req) => {
    const scope = forPublisher(requirePublisher(req).id);
    const q = app.db.pool;
    const r = await scope.get<{
      id: string;
      dataset_id: string;
      record_key: string;
      version: number;
      updated_at: Date;
      removed_at: Date | null;
    }>(q, 'records', req.params.id, {
      columns: 't.id, t.dataset_id, t.record_key, t.version, t.updated_at, t.removed_at',
    });
    const fields = await loadOwnerFields(q, r.dataset_id);
    const { rows } = await q.query<{
      seq: string;
      version: number;
      op: string;
      patch: unknown;
      changed_at: Date;
      crawl_run_id: string | null;
    }>(
      `SELECT seq, version, op, patch, changed_at, crawl_run_id
         FROM record_versions WHERE record_id = $1 AND dataset_id = $2
        ORDER BY seq DESC LIMIT $3`,
      [r.id, r.dataset_id, MAX_VERSIONS + 1],
    );
    return {
      record: {
        id: r.id,
        datasetId: r.dataset_id,
        key: r.record_key,
        version: r.version,
        updatedAt: r.updated_at,
        removedAt: r.removed_at,
      },
      hiddenFields: fields.filter((f) => !f.visible).map((f) => f.name),
      versions: rows.slice(0, MAX_VERSIONS).map((v) => ({
        seq: Number(v.seq),
        version: v.version,
        op: v.op,
        patch: v.patch,
        changedAt: v.changed_at,
        crawlRunId: v.crawl_run_id,
      })),
      truncated: rows.length > MAX_VERSIONS,
    };
  });
};

export default recordsBrowserRoutes;
