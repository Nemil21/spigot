import type { FastifyPluginAsync } from 'fastify';
import { requirePublisher } from '../auth/publisherAuth.js';
import {
  DATASET_SAMPLE_ROWS,
  extractSampleRows,
  fieldView,
  PROPOSAL_SAMPLE_ROWS,
  RECORD_BACKED_STATUSES,
  recentRecordRows,
  sourceOf,
} from '../datasets/samples.js';
import { lastGoodExtractAt, reinferenceView } from '../datasets/reinferView.js';
import type { Queryable } from '../db/index.js';
import { links402 } from '../services/payment402.js';
import { forPublisher } from '../tenancy.js';

/**
 * W05 / W06 reads (SP-014b; api.md §`GET /api/sites/:id/proposals`, §`GET /api/datasets/:id`).
 * Publisher session only; another publisher's site or dataset is a 404
 * (`security/tenancy/datasets-read.cases.ts`).
 *
 * - `GET /api/sites/:id/proposals` → `{ proposals: [{ datasetId, schemaVersionId, typeName, slug,
 *   records, templatePattern, source, sourceBadge, fields, sampleRows[5],
 *   suggestedPerRecordMicros, aiRationale }] }` for the site's PROPOSED datasets.
 * - `GET /api/datasets/:id` → `{ id, siteSlug, slug, typeName, status, staleSince,
 *   lastGoodExtractAt, reinference (SP-052b, LIVE_STALE only), activeSchemaVersion, latestSchemaVersion, fields, prices, recordCount, endpoint,
 *   sampleRows[20] }`. PROPOSED (and REJECTED): extractor dry run on 20 template snapshots.
 *   LIVE / LIVE_STALE / UNPUBLISHED: the 20 most recent records. Hidden fields are in the rows
 *   and flagged `visible: false` in `fields`.
 */

interface VersionRow {
  id: string;
  version: number;
  status: string;
  fields: unknown;
  extractor: unknown;
  sample_stats: unknown;
  ai_model: string | null;
  ai_rationale: string | null;
  proposed_by: string | null;
}

/** Newest schema version that is still in play (not superseded or rejected), else the newest. */
async function latestVersion(q: Queryable, datasetId: string): Promise<VersionRow | null> {
  const { rows } = await q.query<VersionRow>(
    `SELECT id, version, status, fields, extractor, sample_stats, ai_model, ai_rationale, proposed_by
       FROM schema_versions WHERE dataset_id = $1
      ORDER BY (status IN ('PROPOSED', 'APPROVED')) DESC, version DESC
      LIMIT 1`,
    [datasetId],
  );
  return rows[0] ?? null;
}

const datasetsReadRoutes: FastifyPluginAsync = async (app) => {
  const apiBase = (siteSlug: string | null) =>
    siteSlug ? links402(app.config.APP_BASE_URL, siteSlug).apiBase : null;

  app.get<{ Params: { id: string } }>('/api/sites/:id/proposals', async (req) => {
    const scope = forPublisher(requirePublisher(req).id);
    const q = app.db.pool;
    const site = await scope.get<{ id: string }>(q, 'sites', req.params.id, { columns: 't.id' });

    const { rows } = await q.query<{
      id: string;
      slug: string;
      type_name: string;
      record_count: number;
      price_per_record_micros: string;
      template_id: string | null;
      url_pattern: string | null;
      jsonld_types: string[] | null;
      sample_page_ids: string[] | null;
    }>(
      `SELECT d.id, d.slug, d.type_name, d.record_count, d.price_per_record_micros, d.template_id,
              t.url_pattern, t.jsonld_types, t.sample_page_ids
         FROM datasets d LEFT JOIN templates t ON t.id = d.template_id
        WHERE d.site_id = $1 AND d.status = 'PROPOSED'
        ORDER BY d.record_count DESC, d.created_at, d.id`,
      [site.id],
    );

    const proposals = [];
    for (const d of rows) {
      const v = await latestVersion(q, d.id);
      if (!v) continue;
      const sampleRows = await extractSampleRows(
        q,
        {
          templateId: d.template_id,
          samplePageIds: d.sample_page_ids ?? [],
          extractor: v.extractor,
        },
        PROPOSAL_SAMPLE_ROWS,
      );
      const { badge, source } = sourceOf(v.extractor, d.jsonld_types, v);
      proposals.push({
        datasetId: d.id,
        schemaVersionId: v.id,
        typeName: d.type_name,
        slug: d.slug,
        records: d.record_count,
        templatePattern: d.url_pattern,
        source,
        sourceBadge: badge,
        fields: fieldView(v.fields, v.sample_stats, sampleRows),
        sampleRows,
        suggestedPerRecordMicros: Number(d.price_per_record_micros),
        aiRationale: v.ai_rationale,
      });
    }
    return { proposals };
  });

  app.get<{ Params: { id: string } }>('/api/datasets/:id', async (req) => {
    const scope = forPublisher(requirePublisher(req).id);
    const q = app.db.pool;
    const d = await scope.get<{ id: string }>(q, 'datasets', req.params.id, { columns: 't.id' });

    const { rows } = await q.query<{
      id: string;
      slug: string;
      type_name: string;
      status: string;
      stale_since: Date | null;
      active_schema_id: string | null;
      price_per_record_micros: string;
      price_per_change_micros: string;
      record_count: number;
      template_id: string | null;
      site_slug: string | null;
      sample_page_ids: string[] | null;
    }>(
      `SELECT d.id, d.slug, d.type_name, d.status, d.stale_since, d.active_schema_id,
              d.price_per_record_micros, d.price_per_change_micros, d.record_count, d.template_id,
              s.slug AS site_slug, t.sample_page_ids
         FROM datasets d JOIN sites s ON s.id = d.site_id
         LEFT JOIN templates t ON t.id = d.template_id
        WHERE d.id = $1`,
      [d.id],
    );
    const ds = rows[0]!;

    const latest = await latestVersion(q, ds.id);
    const active = ds.active_schema_id
      ? ((
          await q.query<VersionRow>(
            `SELECT id, version, status, fields, extractor, sample_stats, ai_model, ai_rationale, proposed_by
               FROM schema_versions WHERE id = $1`,
            [ds.active_schema_id],
          )
        ).rows[0] ?? null)
      : null;

    const recordBacked = RECORD_BACKED_STATUSES.includes(ds.status);
    // The rows a LIVE dataset sells were extracted with the active schema; a proposal's come
    // from the version under review.
    const rowsVersion = recordBacked ? (active ?? latest) : latest;
    const sampleRows = recordBacked
      ? await recentRecordRows(q, ds.id, DATASET_SAMPLE_ROWS)
      : rowsVersion
        ? await extractSampleRows(
            q,
            {
              templateId: ds.template_id,
              samplePageIds: ds.sample_page_ids ?? [],
              extractor: rowsVersion.extractor,
            },
            DATASET_SAMPLE_ROWS,
          )
        : [];

    // The editor edits the newest version in play (an OWNER draft on top of a LIVE schema).
    const shown = latest ?? active;
    // SP-052b: the W06 stale banner and the diff of sources (null unless LIVE_STALE).
    const stale = ds.status === 'LIVE_STALE';
    const reinference = await reinferenceView(q, {
      id: ds.id,
      status: ds.status,
      staleSince: ds.stale_since,
      activeExtractor: active?.extractor ?? null,
    });
    const base = apiBase(ds.site_slug);
    return {
      id: ds.id,
      siteSlug: ds.site_slug,
      slug: ds.slug,
      typeName: ds.type_name,
      status: ds.status,
      staleSince: ds.stale_since,
      lastGoodExtractAt: stale ? await lastGoodExtractAt(q, ds.id) : null,
      reinference,
      activeSchemaVersion: active ? { id: active.id, version: active.version } : null,
      latestSchemaVersion: latest
        ? {
            id: latest.id,
            version: latest.version,
            status: latest.status,
            proposedBy: latest.proposed_by,
          }
        : null,
      fields: shown ? fieldView(shown.fields, shown.sample_stats, sampleRows) : [],
      prices: {
        perRecordMicros: Number(ds.price_per_record_micros),
        perChangeMicros: Number(ds.price_per_change_micros),
      },
      recordCount: ds.record_count,
      endpoint: base ? `${base}/datasets/${ds.slug}/records` : null,
      sampleRows,
    };
  });
};

export default datasetsReadRoutes;
