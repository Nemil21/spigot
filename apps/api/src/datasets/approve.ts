import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit } from '../audit/audit.js';
import { transition, type Db } from '../db/index.js';
import { bumpPolicyVersion } from '../gate/policy.js';
import { ApiError } from '../http/errors.js';
import { servedFields } from '../records/fields.js';
import { forPublisher, isUuid } from '../tenancy.js';

/**
 * `POST /api/datasets/:id/approve` and `/reject` (SP-014a; api.md, features/04 §6, data-model
 * §Dataset state machine).
 *
 * Approve, in ONE transaction (dataset row locked):
 *   validation (`rightsAttested: true`, ≥ 1 visible field) → conditional `PROPOSED | LIVE_STALE →
 *   LIVE` → the schema version `PROPOSED → APPROVED` (every other PROPOSED / APPROVED version of
 *   the dataset → SUPERSEDED) → `active_schema_id` → `sites.rights_attested_at` →
 *   `bumpPolicyVersion` → audit `SCHEMA_APPROVED` + `DATASET_PUBLISHED` → a `crawl_runs` row with
 *   `trigger = APPROVE`, RUNNING.
 * After COMMIT the caller runs `runApproveExtract` (filter indexes, which can't be built inside a
 * transaction, then `extractTemplate`). A second approve finds the dataset LIVE (or the version
 * APPROVED) and gets 409 STATE_CONFLICT; the conditional updates make a racing pair do the same.
 *
 * Reject: `PROPOSED → REJECTED`, its PROPOSED schema versions → REJECTED.
 */

export const NO_VISIBLE_FIELDS_MESSAGE = 'Pick at least one field to sell';

export const approveBody = z.object({
  schemaVersionId: z.string().refine(isUuid, 'must be a schema version id'),
  rightsAttested: z.literal(true, {
    error: 'Confirm you own or may license these fields (rightsAttested: true).',
  }),
});

export type ApproveBody = z.infer<typeof approveBody>;

/** Dataset statuses an approve moves to LIVE (LIVE_STALE: the owner approves v(n+1) after drift). */
const APPROVABLE = ['PROPOSED', 'LIVE_STALE'] as const;

export interface Approved {
  status: 'LIVE';
  endpoint: string;
  datasetId: string;
  schemaVersionId: string;
  /** The APPROVE run's `crawl_runs.id`: extraction progress (W06 / SSE). */
  crawlRunId: string;
  publisherId: string;
  /** The approved schema's stored fields, for the filter indexes. */
  fields: unknown;
}

interface DatasetRow {
  id: string;
  site_id: string;
  slug: string;
  status: string;
}

export async function approveDataset(
  db: Db,
  deps: { appBaseUrl: string },
  publisherId: string,
  datasetId: string,
  body: ApproveBody,
): Promise<Approved> {
  const scope = forPublisher(publisherId);
  return db.tx(async (tx) => {
    const ds = await scope.get<DatasetRow>(tx, 'datasets', datasetId, {
      columns: 't.id, t.site_id, t.slug, t.status',
      forUpdate: true,
    });
    if (!(APPROVABLE as readonly string[]).includes(ds.status)) {
      throw new ApiError(
        'STATE_CONFLICT',
        `This dataset is ${ds.status}; only a proposal can be approved.`,
        {
          status: ds.status,
        },
      );
    }
    const sv = (
      await tx.query<{ id: string; status: string; fields: unknown; version: number }>(
        'SELECT id, status, fields, version FROM schema_versions WHERE id = $1 AND dataset_id = $2',
        [body.schemaVersionId, ds.id],
      )
    ).rows[0];
    if (!sv) throw new ApiError('NOT_FOUND', 'No such schema version for this dataset.');
    if (sv.status !== 'PROPOSED') {
      throw new ApiError('STATE_CONFLICT', `This schema version is ${sv.status}.`, {
        status: sv.status,
      });
    }
    if (servedFields(sv.fields).length === 0) {
      throw new ApiError('VALIDATION_ERROR', NO_VISIBLE_FIELDS_MESSAGE, { field: 'fields' });
    }

    const live = await transition(tx, 'datasets', ds.id, [...APPROVABLE], 'LIVE', {
      active_schema_id: sv.id,
      stale_since: null,
      updated_at: new Date(),
    });
    if (!live) throw new ApiError('STATE_CONFLICT', 'This dataset was changed by another request.');
    const now = new Date();
    const approved = await transition(tx, 'schema_versions', sv.id, 'PROPOSED', 'APPROVED', {
      approved_by: publisherId,
      approved_at: now,
      updated_at: now,
    });
    if (!approved)
      throw new ApiError('STATE_CONFLICT', 'This schema version was changed by another request.');
    await tx.query(
      `UPDATE schema_versions SET status = 'SUPERSEDED', updated_at = now()
        WHERE dataset_id = $1 AND id <> $2 AND status IN ('PROPOSED', 'APPROVED')`,
      [ds.id, sv.id],
    );

    const site = (
      await tx.query<{ slug: string | null }>(
        'UPDATE sites SET rights_attested_at = now(), updated_at = now() WHERE id = $1 RETURNING slug',
        [ds.site_id],
      )
    ).rows[0]!;
    const policyVersion = await bumpPolicyVersion(tx, ds.site_id);

    // Its own run (the one-live-crawl index ignores APPROVE), so it may overlap a crawl.
    const run = { id: randomUUID() };
    await tx.query(
      `INSERT INTO crawl_runs (id, site_id, trigger, status, started_at, workflow_run_id)
       VALUES ($1::uuid, $2, 'APPROVE', 'RUNNING', now(), 'inproc:' || $1::text)`,
      [run.id, ds.site_id],
    );

    const base = deps.appBaseUrl.replace(/\/+$/, '');
    const endpoint = `${base}/v1/${encodeURIComponent(site.slug ?? ds.site_id)}/datasets/${encodeURIComponent(ds.slug)}/records`;
    const visible = servedFields(sv.fields);
    const common = { actorType: 'PUBLISHER' as const, actorId: publisherId, publisherId };
    await audit(tx, {
      ...common,
      entity: 'schema_versions',
      entityId: sv.id,
      action: 'SCHEMA_APPROVED',
      data: {
        datasetId: ds.id,
        version: sv.version,
        visibleFields: visible.map((f) => f.name),
        filterableFields: visible.filter((f) => f.filterable.length > 0).map((f) => f.name),
        rightsAttested: true,
      },
    });
    await audit(tx, {
      ...common,
      entity: 'datasets',
      entityId: ds.id,
      action: 'DATASET_PUBLISHED',
      data: {
        siteId: ds.site_id,
        slug: ds.slug,
        from: ds.status,
        schemaVersionId: sv.id,
        crawlRunId: run.id,
        policyVersion,
        endpoint,
      },
    });

    return {
      status: 'LIVE',
      endpoint,
      datasetId: ds.id,
      schemaVersionId: sv.id,
      crawlRunId: run.id,
      publisherId,
      fields: sv.fields,
    };
  });
}

export async function rejectDataset(
  db: Db,
  publisherId: string,
  datasetId: string,
): Promise<{ status: 'REJECTED' }> {
  const scope = forPublisher(publisherId);
  return db.tx(async (tx) => {
    const ds = await scope.get<DatasetRow>(tx, 'datasets', datasetId, {
      columns: 't.id, t.site_id, t.slug, t.status',
      forUpdate: true,
    });
    const rejected = await transition(tx, 'datasets', ds.id, 'PROPOSED', 'REJECTED', {
      updated_at: new Date(),
    });
    if (!rejected) {
      throw new ApiError(
        'STATE_CONFLICT',
        `This dataset is ${ds.status}; only a proposal can be rejected.`,
        {
          status: ds.status,
        },
      );
    }
    const { rows } = await tx.query<{ id: string }>(
      `UPDATE schema_versions SET status = 'REJECTED', updated_at = now()
        WHERE dataset_id = $1 AND status = 'PROPOSED' RETURNING id`,
      [ds.id],
    );
    await audit(tx, {
      actorType: 'PUBLISHER',
      actorId: publisherId,
      publisherId,
      entity: 'datasets',
      entityId: ds.id,
      action: 'DATASET_REJECTED',
      data: { siteId: ds.site_id, slug: ds.slug, schemaVersionIds: rows.map((r) => r.id) },
    });
    return { status: 'REJECTED' };
  });
}
