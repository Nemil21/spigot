import type { ExtractorField, ExtractorSpec } from '@spigot/shared';
import type { Queryable } from '../db/index.js';
import { pendingReproposal } from '../schema-agent/reinfer.js';

/**
 * What W06 shows for a LIVE_STALE dataset (SP-052b; screens.md §W06 stale, §W15 stale copy):
 * when the last good extract was, and where re-inference stands, with the field-by-field diff of
 * sources between the live extractor and the re-proposal.
 */

export interface SourceDiffRow {
  name: string;
  /** The live (approved) extractor's source, e.g. `CSS dl.facts dd[data-k=pets] · trim`. */
  before: string;
  /** The re-proposal's source; null when the self-check dropped the field. */
  after: string | null;
  changed: boolean;
}

export interface ReinferenceView {
  /**
   * QUEUED: not started yet (the crawl hook or the sweep picks it up) · RUNNING · PROPOSED: a new
   * version waits for review · FAILED: the last attempt failed (the sweep retries).
   */
  state: 'QUEUED' | 'RUNNING' | 'PROPOSED' | 'FAILED';
  schemaVersionId: string | null;
  version: number | null;
  reason: string | null;
  sources: SourceDiffRow[];
}

/** `JSON-LD $.offers.price · toInt`, `CSS time.move-in-date @datetime · trim, date`. */
export function describeSource(f: Pick<ExtractorField, 'source' | 'transforms'>): string {
  const s = f.source as { jsonld?: string; css?: string; attr?: string; all?: boolean };
  const where =
    s.jsonld !== undefined
      ? `JSON-LD ${s.jsonld}`
      : `CSS ${s.css}${s.attr && s.attr !== 'text' ? ` @${s.attr}` : ''}${s.all ? ' (all)' : ''}`;
  return f.transforms?.length ? `${where} · ${f.transforms.join(', ')}` : where;
}

export function sourceDiff(before: ExtractorSpec, after: ExtractorSpec): SourceDiffRow[] {
  const next = new Map(after.fields.map((f) => [f.name, f]));
  return before.fields.map((f) => {
    const n = next.get(f.name);
    const b = describeSource(f);
    const a = n ? describeSource(n) : null;
    return { name: f.name, before: b, after: a, changed: a !== b };
  });
}

/** Newest records `crawled_at` of the dataset: drift stops every write, so this is the last good one. */
export async function lastGoodExtractAt(q: Queryable, datasetId: string): Promise<Date | null> {
  const { rows } = await q.query<{ at: Date | null }>(
    'SELECT max(crawled_at) AS at FROM records WHERE dataset_id = $1 AND removed_at IS NULL',
    [datasetId],
  );
  return rows[0]?.at ?? null;
}

export async function reinferenceView(
  q: Queryable,
  ds: { id: string; status: string; staleSince: Date | null; activeExtractor: unknown },
): Promise<ReinferenceView | null> {
  if (ds.status !== 'LIVE_STALE' || !ds.staleSince) return null;
  const pending = await pendingReproposal(q, ds.id);
  if (pending) {
    const { rows } = await q.query<{ extractor: ExtractorSpec }>(
      'SELECT extractor FROM schema_versions WHERE id = $1',
      [pending.id],
    );
    const active = ds.activeExtractor as ExtractorSpec | null;
    return {
      state: 'PROPOSED',
      schemaVersionId: pending.id,
      version: pending.version,
      reason: null,
      sources: active && rows[0] ? sourceDiff(active, rows[0].extractor) : [],
    };
  }
  const { rows } = await q.query<{ action: string; data: { outcome?: string; reason?: string } }>(
    `SELECT action, data FROM audit_events
      WHERE entity = 'datasets' AND entity_id = $1 AND at >= $2
        AND action IN ('SCHEMA_REINFER_STARTED', 'SCHEMA_REINFER_DONE')
      ORDER BY id DESC LIMIT 1`,
    [ds.id, ds.staleSince],
  );
  const last = rows[0];
  const base = { schemaVersionId: null, version: null, sources: [] };
  if (!last) return { ...base, state: 'QUEUED', reason: null };
  if (last.action === 'SCHEMA_REINFER_STARTED') return { ...base, state: 'RUNNING', reason: null };
  const outcome = last.data?.outcome ?? '';
  if (!['failed', 'rejected', 'skipped'].includes(outcome)) {
    return { ...base, state: 'QUEUED', reason: null };
  }
  return { ...base, state: 'FAILED', reason: last.data?.reason ?? outcome };
}
