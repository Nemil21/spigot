import { formatAge } from '@spigot/shared/copy';
import { ErrorBanner, SimChip, SkeletonText } from '../components';
import type { ActivityEvent } from './types';

/** Merge a fresh page of the feed into what's shown: new events go on top, newest first. */
export function mergeActivity(
  shown: readonly ActivityEvent[],
  fresh: readonly ActivityEvent[],
  limit: number,
): { events: ActivityEvent[]; added: string[] } {
  const known = new Set(shown.map((e) => e.id));
  const added = fresh.filter((e) => !known.has(e.id)).map((e) => e.id);
  const byId = new Map<string, ActivityEvent>();
  for (const e of [...fresh, ...shown]) if (!byId.has(e.id)) byId.set(e.id, e);
  const events = [...byId.values()]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || Number(b.id) - Number(a.id))
    .slice(0, limit);
  return { events, added };
}

/**
 * W04 activity feed: proposals ready, calls charged, top-ups, payouts, crawls. The line comes
 * from the API (`activityLine`, money copy rule); events that arrive live are highlighted.
 */
export function ActivityFeed({
  events,
  fresh,
  loading,
  error,
  onRetry,
  now = Date.now,
}: {
  events: readonly ActivityEvent[];
  fresh: ReadonlySet<string>;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  now?: () => number;
}) {
  return (
    <section
      aria-labelledby="activity-heading"
      className="min-w-0 overflow-hidden rounded-xl border border-line bg-surface shadow-card"
    >
      <h2
        id="activity-heading"
        className="border-b border-line px-5 py-3.5 text-sm font-semibold text-ink"
      >
        Activity
      </h2>
      {error ? (
        <div className="p-4">
          <ErrorBanner error={error} title="Activity didn't load." onRetry={onRetry} />
        </div>
      ) : loading ? (
        <div className="p-5">
          <SkeletonText lines={5} />
        </div>
      ) : events.length === 0 ? (
        <p className="px-5 py-8 text-sm text-muted">
          Nothing yet. Proposals, charged calls and payouts show up here.
        </p>
      ) : (
        <ol className="grid md:grid-cols-2" aria-live="polite">
          {events.map((e) => (
            <li
              key={e.id}
              data-action={e.action}
              data-fresh={fresh.has(e.id) || undefined}
              className={`border-b border-line px-5 py-3 text-sm transition-colors duration-1000 md:odd:border-r ${
                fresh.has(e.id) ? 'bg-accent-tint' : ''
              }`}
            >
              <p className="leading-5 text-ink">
                {e.line} {e.isSimulated && <SimChip />}
              </p>
              <p className="mt-1 text-xs text-muted">
                <time dateTime={e.at}>{formatAge(now() - Date.parse(e.at))} ago</time>
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
