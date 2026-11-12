// Persist one checked proposal (features/04 §4; data-model §datasets, §schema_versions): in one
// transaction a `datasets` row (PROPOSED, `record_count = page_count`), its `schema_versions` v1
// (PROPOSED, `proposed_by: AI`), the `SCHEMA_PROPOSED` audit row with token counts, and the
// `proposal.ready` event (delivered on COMMIT only). Idempotent per template: `datasets.template_id`
// is unique, so a second writer for the same template stores nothing.
import { PUBLISHER_EVENTS_CHANNEL, publisherEvent } from '@spigot/shared';
import { audit } from '../audit/audit.js';
import { notify, type Db, type Queryable } from '../db/index.js';
import type { TokenUsage } from './claude.js';
import type { CheckedProposal } from './selfcheck.js';

export interface ProposalAiInfo {
  /** Model id that produced the proposal (`recorded` replays carry the recorded model id). */
  model: string;
  replayed: boolean;
  /** JSON-LD-only auto-schema (model unavailable): `model` is "auto (no AI)". */
  auto?: boolean;
  /** Model calls for this template (first answer + retry). */
  calls: number;
  usage: TokenUsage;
}

export interface PersistArgs {
  siteId: string;
  publisherId: string;
  templateId: string;
  urlPattern: string;
  pathPattern: string;
  pageCount: number;
  runId: string | null;
  checked: CheckedProposal;
  ai: ProposalAiInfo;
}

export interface Persisted {
  datasetId: string;
  schemaVersionId: string;
  slug: string;
}

/** `Listing` → `listings`, `Open House` → `open-houses`, `Property` → `properties`. */
export function slugForTypeName(typeName: string): string {
  const kebab =
    typeName
      .trim()
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'records';
  if (/[^aeiou]y$/.test(kebab)) return kebab.slice(0, -1) + 'ies';
  if (/(s|x|z|ch|sh)$/.test(kebab)) return kebab + 'es';
  return kebab + 's';
}

async function freeSlug(tx: Queryable, siteId: string, base: string): Promise<string> {
  const { rows } = await tx.query<{ slug: string }>(
    `SELECT slug FROM datasets WHERE site_id = $1 AND (slug = $2 OR slug LIKE $2 || '-%')`,
    [siteId, base],
  );
  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

export async function persistProposal(db: Db, a: PersistArgs): Promise<Persisted | null> {
  const { checked, ai } = a;
  return db.tx(async (tx) => {
    // Serialise slug choice per site (two templates proposed concurrently may share a type name).
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `datasets-slug:${a.siteId}`,
    ]);
    const slug = await freeSlug(tx, a.siteId, slugForTypeName(checked.proposal.typeName));
    const ds = await tx.query<{ id: string }>(
      `INSERT INTO datasets (site_id, template_id, slug, type_name, status, record_count)
       VALUES ($1, $2, $3, $4, 'PROPOSED', $5)
       ON CONFLICT (template_id) DO NOTHING
       RETURNING id`,
      [a.siteId, a.templateId, slug, checked.proposal.typeName, a.pageCount],
    );
    const datasetId = ds.rows[0]?.id;
    if (!datasetId) return null;

    const sv = await tx.query<{ id: string }>(
      `INSERT INTO schema_versions
         (dataset_id, version, status, fields, extractor, record_key, sample_stats, ai_model, ai_rationale, proposed_by)
       VALUES ($1, 1, 'PROPOSED', $2, $3, $4, $5, $6, $7, 'AI')
       RETURNING id`,
      [
        datasetId,
        JSON.stringify(checked.fields),
        JSON.stringify(checked.spec),
        JSON.stringify(checked.spec.recordKey),
        JSON.stringify(checked.sampleStats),
        ai.model,
        checked.proposal.rationale,
      ],
    );
    const schemaVersionId = sv.rows[0]!.id;

    await audit(tx, {
      actorType: 'SCHEMA_AGENT',
      actorId: ai.model,
      publisherId: a.publisherId,
      entity: 'datasets',
      entityId: datasetId,
      action: 'SCHEMA_PROPOSED',
      data: {
        label: ai.auto ? ai.model : ai.replayed ? 'replayed proposal' : 'live proposal',
        replayed: ai.replayed,
        auto: ai.auto === true,
        model: ai.model,
        siteId: a.siteId,
        runId: a.runId,
        templateId: a.templateId,
        urlPattern: a.urlPattern,
        pathPattern: a.pathPattern,
        pageCount: a.pageCount,
        schemaVersionId,
        typeName: checked.proposal.typeName,
        slug,
        modelCalls: ai.calls,
        tokens: ai.usage,
        hiddenFields: checked.fields.filter((f) => !f.visible).map((f) => f.name),
        flags: checked.flags,
        notes: checked.notes,
        proposal: checked.proposal,
      },
    });
    await notify(
      tx,
      PUBLISHER_EVENTS_CHANNEL,
      publisherEvent(a.publisherId, 'proposal.ready', [datasetId]),
    );
    return { datasetId, schemaVersionId, slug };
  });
}
