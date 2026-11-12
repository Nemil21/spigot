import { staleDataMessage } from '@spigot/shared/copy';
import { useState } from 'react';
import type { DatasetDetail, SourceDiffRow } from './model';

/**
 * W06 stale banner (SP-052b; screens.md §W06 "stale (drift banner)", §W15 "Stale data"): the
 * freshness line "Last good extract 6 h ago; the site changed layout.", where re-inference stands,
 * and, once Claude has re-proposed the extractor, Review → the field-by-field diff of sources.
 * Publish (below) approves the re-proposal: same field names, the dataset goes back to LIVE.
 */
export function StaleBanner({
  detail,
  now = Date.now(),
  retrying,
  onRetry,
}: {
  detail: DatasetDetail;
  now?: number;
  retrying: boolean;
  onRetry: () => void;
}) {
  const [reviewing, setReviewing] = useState(false);
  const since = detail.lastGoodExtractAt ?? detail.staleSince;
  if (!since) return null;
  const r = detail.reinference ?? null;
  const changed = r?.sources.filter((s) => s.changed) ?? [];
  const dropped = r?.sources.filter((s) => s.after === null) ?? [];

  return (
    <section
      aria-label="Layout changed"
      data-slot="stale-banner"
      className="rounded-md border border-warning bg-warning-tint px-4 py-3 text-sm text-warning"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="font-semibold" role="status">
            {staleDataMessage({ lastGoodExtractAgeMs: now - new Date(since).getTime() })}
          </p>
          <p className="text-body">Buyers still get the last good records, marked stale.</p>
          {(!r || r.state === 'QUEUED' || r.state === 'RUNNING') && (
            <p className="text-body" data-reinfer-state={r?.state ?? 'QUEUED'}>
              Claude is reading the new layout to fix the extractor. Field names stay the same.
            </p>
          )}
          {r?.state === 'PROPOSED' && (
            <p className="text-body" data-reinfer-state="PROPOSED">
              A new extractor (v{r.version}) is ready: same {r.sources.length} fields,{' '}
              {changed.length} {changed.length === 1 ? 'source' : 'sources'} updated
              {dropped.length > 0 ? `, ${dropped.length} no longer found` : ''}. Review it, then
              Publish.
            </p>
          )}
          {r?.state === 'FAILED' && (
            <p className="text-body" data-reinfer-state="FAILED">
              Couldn't re-read the new layout{r.reason ? ` (${r.reason})` : ''}. We retry every few
              minutes.
            </p>
          )}
        </div>
        {r?.state === 'PROPOSED' && (
          <button
            type="button"
            aria-expanded={reviewing}
            aria-controls="source-diff"
            onClick={() => setReviewing((v) => !v)}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-strong"
          >
            {reviewing ? 'Hide changes' : 'Review'}
          </button>
        )}
        {r?.state === 'FAILED' && (
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-body disabled:opacity-50"
          >
            {retrying ? 'Starting…' : 'Try again'}
          </button>
        )}
      </div>
      {reviewing && r?.state === 'PROPOSED' && <SourceDiff rows={r.sources} />}
    </section>
  );
}

function SourceDiff({ rows }: { rows: SourceDiffRow[] }) {
  return (
    <div id="source-diff" className="mt-3 overflow-x-auto rounded-md bg-surface">
      <table
        className="w-full text-left text-xs text-body"
        aria-label="Where each field comes from"
      >
        <thead className="text-muted">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Field
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Before (live)
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              After (new layout)
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.name}
              data-changed={row.changed ? '' : undefined}
              className={row.changed ? 'bg-accent-tint' : undefined}
            >
              <th scope="row" className="px-3 py-1.5 font-mono font-normal text-ink">
                {row.name}
              </th>
              <td className={`px-3 py-1.5 font-mono ${row.changed ? 'line-through' : ''}`}>
                {row.before}
              </td>
              <td className="px-3 py-1.5 font-mono">
                {row.after === null ? (
                  <span className="text-danger">no longer found</span>
                ) : row.changed ? (
                  row.after
                ) : (
                  <span className="text-muted">unchanged</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
