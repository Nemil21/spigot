import { gunzipSync } from 'node:zlib';
import {
  compileExtractor,
  PUBLISHER_EVENTS_CHANNEL,
  publisherEvent,
  type ExtractorSpec,
  type FieldValue,
} from '@spigot/shared';
import { audit } from '../audit/audit.js';
import { notify, transition, type Db, type Queryable } from '../db/index.js';
import { re2Engine } from './adapters.js';
import { extractPages } from './extractPage.js';

/**
 * Drift detection (SP-052a; features/04 §7, data-model.md: `LIVE → LIVE_STALE`, `stale_since`).
 *
 * The broken extractor writes no new versions: `published_seq` is one max per dataset, so
 * "write but don't publish" would leak on the next healthy run. So, per crawl run and LIVE dataset:
 *
 * 1. **Probe before writing** (`admitChangedPage`, called by SP-014a's `onPageChanged` handler):
 *    a changed page is held (recorded in `drift_pages`, not extracted). When 20 are held, the
 *    extractor dry-runs on them (pure SP-011, no DB writes) and their per-field null rates are
 *    compared with the approved schema's `sample_stats` (`judgeDrift`). Passed → the held pages are
 *    extracted and later pages of the run go straight through. Drifted → `LIVE → LIVE_STALE`,
 *    `stale_since = now()`, an ALERT and a `dataset.stale` event; SP-013's `extractPages` then
 *    skips every write for the dataset until the owner re-approves (SP-052b).
 * 2. **Run ending** (`settleRunDrift`, `onRunEnding`, before the run is terminal; again from
 *    `onRunFinished`): a run with fewer than 20 changed pages probes on what it has, then
 *    releases its held pages. Idempotent: a crash between "PASSED" and extracting the held pages
 *    is retried here (pages stay `held` until extracted).
 * 3. **Backstop** (`backstopRunDrift`, `onRunFinished`): the same check over every changed page of
 *    the run. Drift the probe missed → `LIVE_STALE` for later runs, and the ALERT names this run
 *    as one that may hold partial bad versions.
 *
 * A dataset without baseline null rates in `sample_stats` (hand-made fixtures, old rows) is not
 * gated: there is nothing to compare with. Every decision is serialized on the
 * `drift_checks (dataset_id, run_id)` row lock.
 */

/** Pages the probe dry-runs (features/04 §7: "the first 20 changed pages of that template"). */
export const PROBE_PAGES = 20;
/** A required field whose null rate rises by more than this (25 points) is drift. */
export const REQUIRED_JUMP = 0.25;
/** A field null on more than this share of pages (40%) counts towards … */
export const FIELD_NULL_MAX = 0.4;
/** … this many such fields: drift. */
export const FIELDS_OVER_MAX = 2;

/** `audit_events.data.kind` of a drift ALERT. */
export const DRIFT_ALERT = 'DATASET_DRIFT';

const RELEASE_BATCH = 100;
const BACKSTOP_BATCH = 200;

// --- pure: measuring and judging -----------------------------------------------------------------

export interface NullCounts {
  /** Pages measured. */
  pages: number;
  /** Per field: pages where it had no value. */
  nulls: Record<string, number>;
}

export interface ProbePage {
  url: string;
  html: string;
}

/** One single-field extractor per field: a field's value even when the record gate drops it. */
export function fieldExtractors(spec: ExtractorSpec) {
  return spec.fields.map((f) => ({
    name: f.name,
    extractor: compileExtractor(
      { recordKey: { from: 'url' }, fields: [{ ...f, required: false }] },
      { regex: re2Engine },
    ),
  }));
}

const isEmpty = (v: FieldValue | undefined) =>
  v === null || v === undefined || (Array.isArray(v) && v.length === 0);

/** Count, per field, the pages where the extractor finds no value (adds into `into`). */
export function countNulls(
  extractors: ReturnType<typeof fieldExtractors>,
  pages: readonly ProbePage[],
  into: NullCounts = { pages: 0, nulls: {} },
): NullCounts {
  for (const { name } of extractors) into.nulls[name] ??= 0;
  for (const p of pages) {
    into.pages += 1;
    for (const { name, extractor } of extractors) {
      const rec = extractor.extract(p.html, p.url);
      if (isEmpty(rec?.data[name])) into.nulls[name]! += 1;
    }
  }
  return into;
}

export interface FieldDrift {
  nullRate: number;
  /** The approved schema's null rate; null when `sample_stats` has none for the field. */
  baseline: number | null;
  required: boolean;
}

export interface DriftVerdict {
  drift: boolean;
  sampled: number;
  reasons: string[];
  fields: Record<string, FieldDrift>;
}

/** `sample_stats.fields[*].nullRate` (SP-012a samples or SP-012b self-check), or null if none. */
export function baselineOf(sampleStats: unknown): Record<string, number> | null {
  const fields = (sampleStats as { fields?: unknown } | null)?.fields;
  if (!fields || typeof fields !== 'object') return null;
  const out: Record<string, number> = {};
  for (const [name, s] of Object.entries(fields as Record<string, unknown>)) {
    const r = (s as { nullRate?: unknown } | null)?.nullRate;
    if (typeof r === 'number' && Number.isFinite(r)) out[name] = r;
  }
  return Object.keys(out).length > 0 ? out : null;
}

const round = (x: number) => Math.round(x * 1000) / 1000;
const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * features/04 §7: a required field's null rate up by more than 25 points, or ≥ 2 fields null on
 * more than 40% of pages → drift. A field only counts towards the second rule if it newly crossed
 * 40% (its baseline was at most 40%); fields without a baseline (added by the owner after the
 * proposal) are reported but never counted. No pages measured → no drift.
 */
export function judgeDrift(
  baseline: Record<string, number>,
  counts: NullCounts,
  required: ReadonlySet<string>,
): DriftVerdict {
  const fields: Record<string, FieldDrift> = {};
  const reasons: string[] = [];
  const over: string[] = [];
  if (counts.pages === 0) return { drift: false, sampled: 0, reasons, fields };
  for (const [name, n] of Object.entries(counts.nulls)) {
    const nullRate = round(n / counts.pages);
    const base = baseline[name] ?? null;
    const isRequired = required.has(name);
    fields[name] = { nullRate, baseline: base, required: isRequired };
    if (base === null) continue;
    if (isRequired && nullRate - base > REQUIRED_JUMP) {
      reasons.push(
        `required field "${name}" empty on ${pct(nullRate)} of pages (was ${pct(base)})`,
      );
    }
    if (nullRate > FIELD_NULL_MAX && base <= FIELD_NULL_MAX) over.push(name);
  }
  if (over.length >= FIELDS_OVER_MAX) {
    reasons.push(
      `${over.length} fields empty on more than ${pct(FIELD_NULL_MAX)} of pages: ${over
        .map((f) => `"${f}" ${pct(fields[f]!.nullRate)}`)
        .join(', ')}`,
    );
  }
  return { drift: reasons.length > 0, sampled: counts.pages, reasons, fields };
}

// --- database --------------------------------------------------------------------------------------

interface GatedDataset {
  id: string;
  status: string;
  publisherId: string;
  typeName: string;
  baseline: Record<string, number>;
  extractors: ReturnType<typeof fieldExtractors>;
  required: Set<string>;
}

/** The dataset with what the probe needs; null when it isn't gated (no baseline / no schema). */
async function loadGated(q: Queryable, datasetId: string): Promise<GatedDataset | null> {
  const row = (
    await q.query<{
      status: string;
      publisher_id: string;
      type_name: string;
      extractor: Record<string, unknown> | null;
      record_key: unknown;
      sample_stats: unknown;
    }>(
      `SELECT d.status, d.type_name, s.publisher_id, sv.extractor, sv.record_key, sv.sample_stats
         FROM datasets d
         JOIN sites s ON s.id = d.site_id
         LEFT JOIN schema_versions sv ON sv.id = d.active_schema_id
        WHERE d.id = $1`,
      [datasetId],
    )
  ).rows[0];
  if (!row?.extractor) return null;
  const baseline = baselineOf(row.sample_stats);
  if (!baseline) return null;
  const { spec } = compileExtractor(
    { ...row.extractor, recordKey: row.record_key ?? row.extractor.recordKey },
    { regex: re2Engine },
  );
  return {
    id: datasetId,
    status: row.status,
    publisherId: row.publisher_id,
    typeName: row.type_name,
    baseline,
    extractors: fieldExtractors(spec),
    required: new Set(spec.fields.filter((f) => f.required).map((f) => f.name)),
  };
}

/**
 * Latest usable (2xx, HTML kept) snapshot of these pages, in the order given; removed pages and
 * pages without one are skipped (they say nothing about the extractor).
 */
async function loadPages(
  q: Queryable,
  pageIds: readonly string[],
  limit: number | null = null,
): Promise<ProbePage[]> {
  if (pageIds.length === 0) return [];
  const { rows } = await q.query<{ url: string; html_gz: Buffer }>(
    `SELECT p.url, s.html_gz
       FROM unnest($1::uuid[]) WITH ORDINALITY AS ids (id, ord)
       JOIN pages p ON p.id = ids.id AND p.removed_at IS NULL
       JOIN LATERAL (
         SELECT http_status, html_gz FROM snapshots
          WHERE page_id = p.id AND html_gz IS NOT NULL
          ORDER BY fetched_at DESC, id DESC LIMIT 1
       ) s ON s.http_status IS NULL OR s.http_status BETWEEN 200 AND 299
      ORDER BY ids.ord
      LIMIT $2`,
    [pageIds, limit],
  );
  return rows.map((r) => ({ url: r.url, html: gunzipSync(r.html_gz).toString('utf8') }));
}

/** Held pages of a check, oldest first. */
async function heldPages(q: Queryable, datasetId: string, runId: string): Promise<string[]> {
  const { rows } = await q.query<{ page_id: string }>(
    `SELECT page_id FROM drift_pages WHERE dataset_id = $1 AND run_id = $2 AND held
      ORDER BY created_at, page_id`,
    [datasetId, runId],
  );
  return rows.map((r) => r.page_id);
}

/** LIVE → LIVE_STALE with the ALERT and `dataset.stale` event, in the caller's transaction. */
async function markStale(
  tx: Queryable,
  ds: GatedDataset,
  runId: string,
  phase: 'probe' | 'backstop',
  verdict: DriftVerdict,
): Promise<boolean> {
  const moved = await transition(tx, 'datasets', ds.id, 'LIVE', 'LIVE_STALE', {
    stale_since: new Date(),
  });
  if (!moved) return false;
  const message =
    phase === 'probe'
      ? `${ds.typeName}: the site's layout changed. Buyers keep getting the last good records ` +
        `(marked stale) and nothing is updated until you approve a new extractor.`
      : `${ds.typeName}: the site's layout changed. Crawl run ${runId} may contain some versions ` +
        `from the broken extractor; later runs write nothing until you approve a new extractor.`;
  await audit(tx, {
    actorType: 'SYSTEM',
    publisherId: ds.publisherId,
    entity: 'datasets',
    entityId: ds.id,
    action: 'ALERT',
    data: {
      kind: DRIFT_ALERT,
      phase,
      datasetId: ds.id,
      runId,
      // The run whose versions may be partly from the broken extractor (backstop only).
      partialBadVersionsRunId: phase === 'backstop' ? runId : null,
      sampled: verdict.sampled,
      reasons: verdict.reasons,
      message,
    },
  });
  await notify(
    tx,
    PUBLISHER_EVENTS_CHANNEL,
    publisherEvent(ds.publisherId, 'dataset.stale', [ds.id, runId]),
  );
  return true;
}

type Decision = 'PENDING' | 'PASSED' | 'DRIFTED';

/**
 * Inside the check's row lock: probe the held pages and record the decision. `final` (run end)
 * decides on whatever is held; otherwise it waits for `PROBE_PAGES` held pages.
 */
async function decide(
  tx: Queryable,
  ds: GatedDataset,
  runId: string,
  final: boolean,
): Promise<Decision> {
  const held = await heldPages(tx, ds.id, runId);
  if (!final && held.length < PROBE_PAGES) return 'PENDING';
  let verdict: DriftVerdict;
  let decision: Decision;
  let note: string | undefined;
  if (ds.status !== 'LIVE') {
    // Unpublished or re-approved mid-run: nothing to protect here; release decides by status.
    verdict = { drift: false, sampled: 0, reasons: [], fields: {} };
    decision = 'PASSED';
    note = `dataset was ${ds.status}`;
  } else {
    const pages = await loadPages(tx, held, PROBE_PAGES);
    // 20 changed pages but none usable (all removed / failed): keep waiting until run end.
    if (pages.length === 0 && !final) return 'PENDING';
    verdict = judgeDrift(ds.baseline, countNulls(ds.extractors, pages), ds.required);
    decision = verdict.drift ? 'DRIFTED' : 'PASSED';
  }
  await tx.query(
    `UPDATE drift_checks SET status = $3, probe = $4, decided_at = now()
      WHERE dataset_id = $1 AND run_id = $2`,
    [ds.id, runId, decision, JSON.stringify({ ...verdict, final, ...(note ? { note } : {}) })],
  );
  if (decision === 'DRIFTED') await markStale(tx, ds, runId, 'probe', verdict);
  return decision;
}

/** Lock (creating if needed) the check row; returns its status. */
async function lockCheck(tx: Queryable, datasetId: string, runId: string): Promise<Decision> {
  await tx.query(
    `INSERT INTO drift_checks (dataset_id, run_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [datasetId, runId],
  );
  const { rows } = await tx.query<{ status: Decision }>(
    `SELECT status FROM drift_checks WHERE dataset_id = $1 AND run_id = $2 FOR UPDATE`,
    [datasetId, runId],
  );
  return rows[0]!.status;
}

/** Extract held pages after a PASSED decision, then mark them released. */
async function release(db: Db, datasetId: string, runId: string, pageIds: readonly string[]) {
  for (let i = 0; i < pageIds.length; i += RELEASE_BATCH) {
    const batch = pageIds.slice(i, i + RELEASE_BATCH);
    // extractPages skips the batch itself if the dataset went LIVE_STALE meanwhile.
    await extractPages({ datasetId, runId, pageIds: batch }, { db });
    await db.pool.query(
      `UPDATE drift_pages SET held = false
        WHERE dataset_id = $1 AND run_id = $2 AND page_id = ANY($3::uuid[])`,
      [datasetId, runId, batch],
    );
  }
}

export type AdmitOutcome =
  /** Not gated (not LIVE, or no baseline): extract as before SP-052a. */
  | 'UNGATED'
  /** Held until the probe decides. */
  | 'HELD'
  /** The probe passed (now or earlier): this page and any held ones were extracted. */
  | 'EXTRACTED'
  /** The dataset drifted in this run: nothing written. */
  | 'DRIFTED';

/**
 * SP-014a's `onPageChanged` handler calls this for each LIVE dataset of the changed page, in
 * place of `extractPage`. It extracts what may be extracted and returns what happened.
 */
export async function admitChangedPage(
  db: Db,
  args: { datasetId: string; pageId: string; runId: string },
): Promise<AdmitOutcome> {
  const { datasetId, pageId, runId } = args;
  const ds = await loadGated(db.pool, datasetId);
  if (!ds || ds.status !== 'LIVE') return 'UNGATED';

  const { decision, toRelease } = await db.tx(async (tx) => {
    let decision = await lockCheck(tx, datasetId, runId);
    await tx.query(
      `INSERT INTO drift_pages (dataset_id, run_id, page_id) VALUES ($1, $2, $3)
       ON CONFLICT (dataset_id, run_id, page_id) DO UPDATE SET held = true`,
      [datasetId, runId, pageId],
    );
    if (decision !== 'PENDING') {
      // Decided earlier: only this page. The decider released the held batch; a crash there
      // is swept up at run end (`settleRunDrift`).
      return { decision, toRelease: decision === 'PASSED' ? [pageId] : [] };
    }
    decision = await decide(tx, ds, runId, false);
    const toRelease = decision === 'PASSED' ? await heldPages(tx, datasetId, runId) : [];
    return { decision, toRelease };
  });
  if (decision === 'PENDING') return 'HELD';
  if (decision === 'DRIFTED') return 'DRIFTED';
  await release(db, datasetId, runId, toRelease);
  return 'EXTRACTED';
}

/**
 * Run ending (`onRunEnding`, and again from `onRunFinished`): decide every check of the run still
 * PENDING on the pages it has, and extract held pages of PASSED checks. Idempotent.
 */
export async function settleRunDrift(db: Db, runId: string): Promise<void> {
  const { rows } = await db.pool.query<{ dataset_id: string }>(
    `SELECT dataset_id FROM drift_checks WHERE run_id = $1 ORDER BY dataset_id`,
    [runId],
  );
  for (const { dataset_id: datasetId } of rows) {
    const ds = await loadGated(db.pool, datasetId);
    const toRelease = await db.tx(async (tx) => {
      let decision = await lockCheck(tx, datasetId, runId);
      if (decision === 'PENDING') {
        if (!ds) {
          // Baseline gone (schema changed mid-run): stop gating, like an ungated dataset.
          await tx.query(
            `UPDATE drift_checks SET status = 'PASSED', decided_at = now(),
                    probe = '{"note":"no baseline at run end"}'
              WHERE dataset_id = $1 AND run_id = $2`,
            [datasetId, runId],
          );
          decision = 'PASSED';
        } else {
          decision = await decide(tx, ds, runId, true);
        }
      }
      return decision === 'PASSED' ? heldPages(tx, datasetId, runId) : [];
    });
    if (toRelease.length === 0) continue;
    // Release only into a dataset that is still sold (an unpublished one gets nothing new).
    const status = (
      await db.pool.query<{ status: string }>('SELECT status FROM datasets WHERE id = $1', [
        datasetId,
      ])
    ).rows[0]?.status;
    if (status === 'LIVE') await release(db, datasetId, runId, toRelease);
  }
}

/**
 * Post-run backstop (`onRunFinished`): re-check every changed page of the run for each check the
 * probe passed. Drift found → `LIVE_STALE` for later runs; the ALERT names this run. Idempotent
 * (`backstop` is written once).
 */
export async function backstopRunDrift(db: Db, runId: string): Promise<string[]> {
  const { rows } = await db.pool.query<{ dataset_id: string }>(
    `SELECT dataset_id FROM drift_checks
      WHERE run_id = $1 AND status = 'PASSED' AND backstop IS NULL ORDER BY dataset_id`,
    [runId],
  );
  const drifted: string[] = [];
  for (const { dataset_id: datasetId } of rows) {
    const ds = await loadGated(db.pool, datasetId);
    if (!ds || ds.status !== 'LIVE') continue;
    const pageIds = (
      await db.pool.query<{ page_id: string }>(
        `SELECT page_id FROM drift_pages WHERE dataset_id = $1 AND run_id = $2
          ORDER BY created_at, page_id`,
        [datasetId, runId],
      )
    ).rows.map((r) => r.page_id);
    const counts: NullCounts = { pages: 0, nulls: {} };
    for (let i = 0; i < pageIds.length; i += BACKSTOP_BATCH) {
      countNulls(
        ds.extractors,
        await loadPages(db.pool, pageIds.slice(i, i + BACKSTOP_BATCH)),
        counts,
      );
    }
    const verdict = judgeDrift(ds.baseline, counts, ds.required);
    const stale = await db.tx(async (tx) => {
      const status = await lockCheck(tx, datasetId, runId);
      const done = await tx.query(
        `UPDATE drift_checks SET backstop = $3
          WHERE dataset_id = $1 AND run_id = $2 AND backstop IS NULL`,
        [datasetId, runId, JSON.stringify(verdict)],
      );
      if (status !== 'PASSED' || done.rowCount === 0 || !verdict.drift) return false;
      await tx.query(
        `UPDATE drift_checks SET status = 'DRIFTED' WHERE dataset_id = $1 AND run_id = $2`,
        [datasetId, runId],
      );
      return markStale(tx, ds, runId, 'backstop', verdict);
    });
    if (stale) drifted.push(datasetId);
  }
  return drifted;
}
