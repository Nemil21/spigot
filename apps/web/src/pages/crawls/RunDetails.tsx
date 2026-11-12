import { Pill, secondaryButton, cardClass } from '../onboarding/kit';
import {
  aiCallsNote,
  formatCount,
  formatDuration,
  formatWhen,
  runDurationMs,
  runStatusLabel,
  runStatusTone,
  triggerLabel,
  type CrawlRun,
} from './model';

/** "Open run" (screens.md §W10): every counter of one run, its error and its workflow run id. */
export function RunDetails({
  run,
  now,
  onClose,
}: {
  run: CrawlRun;
  now: number;
  onClose: () => void;
}) {
  const note = aiCallsNote(run);
  const rows: [string, string][] = [
    ['Trigger', triggerLabel(run.trigger)],
    ['Started', formatWhen(run.startedAt ?? run.createdAt)],
    ['Finished', run.finishedAt ? formatWhen(run.finishedAt) : '—'],
    ['Duration', formatDuration(runDurationMs(run, now))],
    ['Pages in sitemap', formatCount(run.pagesTotal)],
    ['Fetched', formatCount(run.pagesFetched)],
    ['Not modified (304)', formatCount(run.pagesNotModified)],
    ['Failed', formatCount(run.pagesFailed)],
    ['Records added', formatCount(run.recordsAdded)],
    ['Records updated', formatCount(run.recordsUpdated)],
    ['Records removed', formatCount(run.recordsRemoved)],
    ['AI calls', `${formatCount(run.aiCalls)}${note ? ` (${note})` : ''}`],
    ['Workflow run', run.workflowRunId ?? '—'],
  ];
  return (
    <section aria-label="Run details" className={cardClass}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold text-ink">
          Run <span className="font-mono text-sm">{run.id.slice(0, 8)}</span>{' '}
          <Pill tone={runStatusTone(run.status)}>{runStatusLabel(run.status)}</Pill>
        </h2>
        <button type="button" onClick={onClose} className={secondaryButton}>
          Close
        </button>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        {rows.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-muted">{k}</dt>
            <dd className="truncate tabular-nums text-ink" title={v}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
      {run.error && (
        <p className="mt-4 rounded-md bg-danger-tint px-3 py-2 text-sm text-danger">{run.error}</p>
      )}
    </section>
  );
}
