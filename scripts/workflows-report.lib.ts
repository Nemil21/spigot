import type pg from 'pg';

/**
 * SP-041b's Render check, read-only (docs/deploy.md §Render Workflows check). For one site:
 * its crawl runs with the mode each ran in, connect → discovery-crawl time (spec 03's < 4 min),
 * page / snapshot / record / version counts with duplicate checks, and the latest payout
 * batches. Ids and counts only: no emails, keys or page bodies.
 */

export interface RunLine {
  id: string;
  trigger: string;
  status: string;
  /** `workflows` when Render ran it (a Render task run id), else `inproc`. */
  mode: 'workflows' | 'inproc' | 'unknown';
  workflowRunId: string | null;
  pagesTotal: number;
  pagesFetched: number;
  pagesNotModified: number;
  pagesFailed: number;
  recordsAdded: number;
  recordsUpdated: number;
  recordsRemoved: number;
  /** finished − started, seconds (null while it runs). */
  seconds: number | null;
  startedAt: string | null;
}

export interface WorkflowsReport {
  site: { id: string; origin: string; status: string; createdAt: string };
  runs: RunLine[];
  /** Site connected → its first CONNECT run finished, seconds (spec 03: < 240 on Render). */
  connectToDiscoverySeconds: number | null;
  pages: number;
  snapshots: number;
  pagesWithDuplicateSnapshots: number;
  datasets: {
    id: string;
    slug: string;
    status: string;
    records: number;
    versions: number;
    recordsWithDuplicateVersions: number;
  }[];
  payoutBatches: { id: string; status: string; itemCount: number; createdAt: string }[];
}

const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());

export function modeOf(workflowRunId: string | null): RunLine['mode'] {
  if (!workflowRunId) return 'unknown';
  return workflowRunId.startsWith('inproc:') ? 'inproc' : 'workflows';
}

/** `site` is a site id or its origin (e.g. https://bluebonnet-rentals.onrender.com). */
export async function workflowsReport(
  pool: pg.Pool,
  site: string,
  opts: { runs?: number } = {},
): Promise<WorkflowsReport | null> {
  const byId = /^[0-9a-f-]{36}$/i.test(site);
  const { rows: sites } = await pool.query<{
    id: string;
    origin: string;
    status: string;
    created_at: Date;
  }>(
    `SELECT id, origin, status, created_at FROM sites
      WHERE ${byId ? 'id = $1::uuid' : 'origin = $1'} ORDER BY created_at DESC LIMIT 1`,
    [byId ? site : site.replace(/\/+$/, '')],
  );
  const s = sites[0];
  if (!s) return null;

  const { rows: runs } = await pool.query(
    `SELECT id, trigger, status, workflow_run_id, pages_total, pages_fetched, pages_not_modified,
            pages_failed, records_added, records_updated, records_removed, started_at,
            EXTRACT(EPOCH FROM (finished_at - started_at))::float AS seconds
       FROM crawl_runs WHERE site_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [s.id, opts.runs ?? 10],
  );

  const { rows: timing } = await pool.query<{ seconds: number | null }>(
    `SELECT EXTRACT(EPOCH FROM (r.finished_at - s.created_at))::float AS seconds
       FROM crawl_runs r JOIN sites s ON s.id = r.site_id
      WHERE r.site_id = $1 AND r.trigger = 'CONNECT' AND r.finished_at IS NOT NULL
      ORDER BY r.created_at LIMIT 1`,
    [s.id],
  );

  const { rows: pageCounts } = await pool.query<{ pages: number; snapshots: number; dup: number }>(
    `SELECT (SELECT count(*)::int FROM pages WHERE site_id = $1) AS pages,
            (SELECT count(*)::int FROM snapshots sn JOIN pages p ON p.id = sn.page_id
              WHERE p.site_id = $1) AS snapshots,
            (SELECT count(*)::int FROM (
               SELECT sn.page_id FROM snapshots sn JOIN pages p ON p.id = sn.page_id
                WHERE p.site_id = $1 GROUP BY sn.page_id, sn.content_hash HAVING count(*) > 1) d) AS dup`,
    [s.id],
  );

  const { rows: datasets } = await pool.query(
    `SELECT d.id, d.slug, d.status,
            (SELECT count(*)::int FROM records r WHERE r.dataset_id = d.id) AS records,
            (SELECT count(*)::int FROM record_versions v WHERE v.dataset_id = d.id) AS versions,
            (SELECT count(*)::int FROM (
               SELECT v.record_id FROM record_versions v WHERE v.dataset_id = d.id
                GROUP BY v.record_id, v.version HAVING count(*) > 1) x) AS dup
       FROM datasets d WHERE d.site_id = $1 ORDER BY d.slug`,
    [s.id],
  );

  const { rows: batches } = await pool.query(
    `SELECT b.id, b.status, b.created_at,
            (SELECT count(*)::int FROM payout_items i WHERE i.batch_id = b.id) AS item_count
       FROM payout_batches b ORDER BY b.created_at DESC LIMIT 5`,
  );

  return {
    site: { id: s.id, origin: s.origin, status: s.status, createdAt: iso(s.created_at)! },
    runs: runs.map((r) => ({
      id: r.id,
      trigger: r.trigger,
      status: r.status,
      mode: modeOf(r.workflow_run_id),
      workflowRunId: r.workflow_run_id,
      pagesTotal: r.pages_total,
      pagesFetched: r.pages_fetched,
      pagesNotModified: r.pages_not_modified,
      pagesFailed: r.pages_failed,
      recordsAdded: r.records_added,
      recordsUpdated: r.records_updated,
      recordsRemoved: r.records_removed,
      seconds: r.seconds === null ? null : Math.round(r.seconds * 10) / 10,
      startedAt: iso(r.started_at),
    })),
    connectToDiscoverySeconds:
      timing[0]?.seconds == null ? null : Math.round(timing[0].seconds * 10) / 10,
    pages: pageCounts[0]!.pages,
    snapshots: pageCounts[0]!.snapshots,
    pagesWithDuplicateSnapshots: pageCounts[0]!.dup,
    datasets: datasets.map((d) => ({
      id: d.id,
      slug: d.slug,
      status: d.status,
      records: d.records,
      versions: d.versions,
      recordsWithDuplicateVersions: d.dup,
    })),
    payoutBatches: batches.map((b) => ({
      id: b.id,
      status: b.status,
      itemCount: b.item_count,
      createdAt: iso(b.created_at)!,
    })),
  };
}

/** Human-readable lines for the Render Shell. */
export function formatReport(r: WorkflowsReport): string {
  const out: string[] = [];
  out.push(`site ${r.site.id} ${r.site.origin} (${r.site.status})`);
  const t = r.connectToDiscoverySeconds;
  out.push(
    `connect → discovery crawl: ${t === null ? 'not finished' : `${t} s`}` +
      (t === null
        ? ''
        : t < 240
          ? ' (< 4 min: pass)'
          : ' (≥ 4 min: record the time and reason in README)'),
  );
  out.push(
    `pages ${r.pages} · snapshots ${r.snapshots} · pages with a duplicate snapshot ${r.pagesWithDuplicateSnapshots}`,
  );
  for (const d of r.datasets) {
    out.push(
      `dataset ${d.slug} (${d.status}): records ${d.records} · versions ${d.versions} · duplicate versions ${d.recordsWithDuplicateVersions}`,
    );
  }
  out.push('runs (newest first):');
  for (const run of r.runs) {
    out.push(
      `  ${run.startedAt ?? '-'} ${run.trigger.padEnd(11)} ${run.status.padEnd(9)} ${run.mode.padEnd(9)} ` +
        `total ${run.pagesTotal} fetched ${run.pagesFetched} 304 ${run.pagesNotModified} failed ${run.pagesFailed} ` +
        `records +${run.recordsAdded}/~${run.recordsUpdated}/-${run.recordsRemoved} ` +
        `${run.seconds === null ? 'running' : `${run.seconds} s`} ${run.workflowRunId ?? ''}`,
    );
  }
  out.push('payout batches (newest first):');
  for (const b of r.payoutBatches)
    out.push(`  ${b.createdAt} ${b.id} ${b.status} items ${b.itemCount}`);
  return out.join('\n');
}
