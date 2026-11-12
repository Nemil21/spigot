import { formatCount, formatMicros } from '@spigot/shared/money';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api as defaultApi, type ApiClient } from '../api/client';
import { useEventStream, type EventSourceFactory, type EventStreamMessage } from '../api/sse';
import { HitsArea } from '../charts/HitsArea';
import { EmptyState, ErrorBanner, Kpi, Money, Skeleton } from '../components';
import { BotsGrid } from '../grids/BotsGrid';
import { ActivityFeed, mergeActivity } from '../overview/ActivityFeed';
import { BotDrawer } from '../overview/BotDrawer';
import { CHART_CATEGORIES, categoryLabel, formatBytes } from '../overview/labels';
import type { ActivityEvent, BotRow, BotsReport, SiteSummary } from '../overview/types';
import { paths } from '../routes';

/** Events the feed shows; the newest page is refetched and merged when SSE says something changed. */
export const ACTIVITY_LIMIT = 30;
/** How long a live-arrived feed event stays highlighted. */
const FRESH_MS = 6_000;
const EVENTS_URL = '/api/publishers/me/events';

export interface OverviewProps {
  client?: ApiClient;
  /** A fake EventSource (tests); also turns the stream on in fixture mode. */
  eventSource?: EventSourceFactory;
  now?: () => number;
  /** SSE bursts within this window become one refetch. */
  refetchDelayMs?: number;
}

type Load<T> =
  { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'ready'; data: T };

interface ReportState {
  data: BotsReport | null;
  error: unknown;
  /** The last update came from a live SSE refetch (the grid flashes changed rows). */
  live: boolean;
}

/**
 * W04 Overview / bot report (screens.md §W04; features/13 §1; SP-027b): "who's crawling you",
 * live. KPI row, stacked area by category, the "Who's crawling you" AG Grid and the activity feed.
 *
 * Live: SSE `hits` (ids = site ids) and `call.charged` refetch the report (the grid applies the
 * delta with `applyTransactionAsync` and flashes changed rows; KPIs move); `call.charged`,
 * `proposal.ready` and `payout.updated` refetch the feed and prepend what's new. A reconnect or
 * `resync` refetches both. Bursts are coalesced into one request per `refetchDelayMs`.
 */
export default function OverviewPage({
  client = defaultApi,
  eventSource,
  now = Date.now,
  refetchDelayMs = 400,
}: OverviewProps) {
  const [params] = useSearchParams();
  const [sites, setSites] = useState<Load<SiteSummary[]>>({ status: 'loading' });
  const [sitesAttempt, setSitesAttempt] = useState(0);
  const [includeSim, setIncludeSim] = useState(true);
  const [category, setCategory] = useState<string>('ALL');
  const [report, setReport] = useState<ReportState>({ data: null, error: null, live: false });
  const [activity, setActivity] = useState<Load<ActivityEvent[]>>({ status: 'loading' });
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<BotRow | null>(null);

  useEffect(() => {
    let live = true;
    setSites({ status: 'loading' });
    client.get<{ sites: SiteSummary[] }>('/api/sites').then(
      (r) => live && setSites({ status: 'ready', data: r.sites }),
      (error: unknown) => live && setSites({ status: 'error', error }),
    );
    return () => {
      live = false;
    };
  }, [client, sitesAttempt]);

  const site = useMemo(() => {
    if (sites.status !== 'ready') return null;
    const wanted = params.get('site');
    return sites.data.find((s) => s.id === wanted) ?? sites.data[0] ?? null;
  }, [sites, params]);
  const siteId = site?.id ?? null;

  // Report: a sequence number drops answers that a newer request (SIM toggle, live) overtook.
  const reportSeq = useRef(0);
  const loadReport = useCallback(
    (live: boolean) => {
      if (!siteId) return;
      const seq = ++reportSeq.current;
      client
        .get<BotsReport>(
          `/api/sites/${encodeURIComponent(siteId)}/bots?includeSim=${includeSim ? 'true' : 'false'}`,
        )
        .then(
          (data) => seq === reportSeq.current && setReport({ data, error: null, live }),
          (error: unknown) =>
            seq === reportSeq.current &&
            // A failed live refetch keeps the last report; the next event tries again.
            setReport((r) => (live && r.data ? r : { data: null, error, live: false })),
        );
    },
    [client, siteId, includeSim],
  );

  useEffect(() => {
    setReport((r) => ({ ...r, error: null, live: false }));
    loadReport(false);
  }, [loadReport]);

  const activityRef = useRef<ActivityEvent[]>([]);
  const freshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadActivity = useCallback(
    (live: boolean) => {
      client
        .get<{ events: ActivityEvent[] }>(`/api/publishers/me/activity?limit=${ACTIVITY_LIMIT}`)
        .then(
          ({ events }) => {
            const merged = live
              ? mergeActivity(activityRef.current, events, ACTIVITY_LIMIT)
              : { events, added: [] };
            activityRef.current = merged.events;
            setActivity({ status: 'ready', data: merged.events });
            if (merged.added.length) {
              setFresh(new Set(merged.added));
              if (freshTimer.current) clearTimeout(freshTimer.current);
              freshTimer.current = setTimeout(() => setFresh(new Set()), FRESH_MS);
            }
          },
          (error: unknown) => {
            if (!live || activityRef.current.length === 0) setActivity({ status: 'error', error });
          },
        );
    },
    [client],
  );
  useEffect(() => {
    setActivity({ status: 'loading' });
    loadActivity(false);
  }, [loadActivity]);
  useEffect(() => () => void (freshTimer.current && clearTimeout(freshTimer.current)), []);

  // Coalesced live refetches.
  const timers = useRef<{
    report?: ReturnType<typeof setTimeout>;
    activity?: ReturnType<typeof setTimeout>;
  }>({});
  const latest = useRef({ loadReport, loadActivity });
  latest.current = { loadReport, loadActivity };
  const schedule = useCallback(
    (what: 'report' | 'activity') => {
      if (timers.current[what]) return;
      timers.current[what] = setTimeout(() => {
        timers.current[what] = undefined;
        if (what === 'report') latest.current.loadReport(true);
        else latest.current.loadActivity(true);
      }, refetchDelayMs);
    },
    [refetchDelayMs],
  );
  useEffect(
    () => () => {
      clearTimeout(timers.current.report);
      clearTimeout(timers.current.activity);
    },
    [],
  );

  const onEvent = useCallback(
    (m: EventStreamMessage) => {
      const ids = (m.data as { ids?: unknown } | null)?.ids;
      const forThisSite =
        !Array.isArray(ids) || ids.length === 0 || (siteId !== null && ids.includes(siteId));
      switch (m.type) {
        case 'hits':
          if (forThisSite) schedule('report');
          break;
        case 'call.charged':
          schedule('report');
          schedule('activity');
          break;
        case 'proposal.ready':
        case 'payout.updated':
          schedule('activity');
          break;
      }
    },
    [siteId, schedule],
  );

  const streamStatus = useEventStream(
    siteId ? EVENTS_URL : null,
    {
      onEvent,
      onRefetch: () => {
        schedule('report');
        schedule('activity');
      },
    },
    eventSource ? { enabled: true, createSource: eventSource } : {},
  );

  const rows = useMemo(() => {
    const all = report.data?.byBot ?? [];
    return category === 'ALL' ? all : all.filter((r) => r.category === category);
  }, [report.data, category]);
  const chartCategories = useMemo(
    () => (category === 'ALL' ? CHART_CATEGORIES : [category]),
    [category],
  );
  const closeDrawer = useCallback(() => setOpen(null), []);

  // --- Render ---------------------------------------------------------------------------------
  const frame = (body: ReactNode, header?: ReactNode) => (
    <section className="mx-auto max-w-7xl space-y-6 px-6 py-8" data-screen="W04">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Overview</h1>
          <p className="mt-1 text-sm text-muted">
            {site
              ? `Who's crawling ${site.origin.replace(/^https?:\/\//, '')}`
              : "Who's crawling you"}
          </p>
        </div>
        {header}
      </div>
      {body}
    </section>
  );

  if (sites.status === 'error') {
    return frame(<ErrorBanner error={sites.error} onRetry={() => setSitesAttempt((n) => n + 1)} />);
  }
  if (sites.status === 'ready' && !site) {
    return frame(
      <EmptyState
        message="Install the gate to see who's crawling you."
        action={{ label: 'Install the gate', to: paths.installVerify }}
      />,
    );
  }
  if (report.error && !report.data) {
    return frame(<ErrorBanner error={report.error} onRetry={() => loadReport(false)} />);
  }

  const data = report.data;
  const loading = !data;
  const t = data?.totals;
  const neverInstalled =
    !!site && !!data && !site.lastGateSeenAt && t!.botHits === 0 && t!.humanHits === 0;

  if (neverInstalled) {
    return frame(
      <>
        {site.status === 'PENDING_VERIFY' && <UnverifiedBanner siteId={site.id} />}
        <EmptyState
          message="Install the gate to see who's crawling you."
          action={{
            label: 'Install the gate',
            to: `${paths.installVerify}?site=${encodeURIComponent(site.id)}`,
          }}
        />
      </>,
    );
  }

  const earned = data?.earnedThisWeek;
  const controls = (
    <div className="flex flex-wrap items-center gap-4 text-sm">
      <LiveBadge status={streamStatus} />
      <label className="flex items-center gap-2 text-body">
        Category
        <select
          className="rounded-md border border-border bg-surface px-2 py-1 text-ink"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="ALL">All bots</option>
          {CHART_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {categoryLabel(c)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-body">
        <input
          type="checkbox"
          checked={includeSim}
          onChange={(e) => setIncludeSim(e.target.checked)}
          className="accent-accent"
        />
        Include simulated
      </label>
    </div>
  );

  return frame(
    <>
      {site?.status === 'PENDING_VERIFY' && <UnverifiedBanner siteId={site.id} />}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5" aria-label="Key numbers" role="group">
        <Kpi label="Bot visits (7 d)" loading={loading} value={t && formatCount(t.botHits)} />
        <Kpi label="Bots vs people" loading={loading} value={t?.ratio} />
        <Kpi
          label="Bots sent to your API"
          loading={loading}
          value={t && formatCount(t.quoted402)}
          hint="402 quotes with your price"
        />
        <Kpi
          label="Bandwidth avoided (est.)"
          loading={loading}
          value={t && formatBytes(t.bytesSavedEstimate)}
          hint="Pages not served to gated bots"
        />
        <Kpi
          label="Earned this week"
          loading={loading}
          value={
            earned && (
              <span
                className="text-money"
                title={
                  earned.simMicros > 0 ? `incl. ${formatMicros(earned.simMicros)} SIM` : undefined
                }
                data-testid="earned-this-week"
              >
                <Money micros={earned.micros} />
              </span>
            )
          }
          hint="Your share after Spigot's fee"
        />
      </div>

      <div className="rounded-lg border border-line bg-surface p-4 shadow-card">
        <h2 className="text-sm font-semibold text-ink">Bot hits by category</h2>
        {data ? (
          <HitsArea report={data} categories={chartCategories} />
        ) : (
          <Skeleton className="mt-3 block h-[260px] w-full" />
        )}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-3">
          <h2 className="text-sm font-semibold text-ink">Who's crawling you</h2>
          {!data ? (
            <Skeleton className="block h-[460px] w-full" />
          ) : t!.botHits === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-surface px-6 py-10 text-center text-body">
              <p>The gate is installed. No bots yet; they usually show up within a day.</p>
              {!includeSim && <p className="mt-2 text-sm text-muted">Simulated bots are hidden.</p>}
            </div>
          ) : (
            <BotsGrid rows={rows} flash={report.live} onOpen={setOpen} now={now} />
          )}
          {data && t!.estimate && (
            <p className="text-xs text-muted">
              "Would have paid" is an estimate: pages sent to your API × records per page ×{' '}
              {data.totals.estimateBasis.priceSource === 'LIVE'
                ? 'your live price'
                : data.totals.estimateBasis.priceSource === 'PROPOSED'
                  ? 'the suggested price'
                  : 'the default $1.50 / 1,000 records'}
              .
            </p>
          )}
        </div>
        <ActivityFeed
          events={activity.status === 'ready' ? activity.data : []}
          fresh={fresh}
          loading={activity.status === 'loading'}
          error={activity.status === 'error' ? activity.error : null}
          onRetry={() => {
            setActivity({ status: 'loading' });
            loadActivity(false);
          }}
          now={now}
        />
      </div>

      {open && data && (
        <BotDrawer bot={open} rows={data.byBot} policy={site?.policy ?? {}} onClose={closeDrawer} />
      )}
    </>,
    data ? controls : undefined,
  );
}

function UnverifiedBanner({ siteId }: { siteId: string }) {
  return (
    <div
      role="status"
      className="rounded-md border border-warning bg-warning-tint px-4 py-3 text-sm text-warning"
    >
      This site isn't verified yet, so nothing is for sale.{' '}
      <Link
        className="font-medium underline"
        to={`${paths.installVerify}?site=${encodeURIComponent(siteId)}`}
      >
        Verify it
      </Link>
    </div>
  );
}

function LiveBadge({ status }: { status: ReturnType<typeof useEventStream> }) {
  if (status === 'disabled') return null;
  const live = status === 'open';
  return (
    <span className="flex items-center gap-1.5 text-xs font-medium text-muted" data-stream={status}>
      <span
        aria-hidden="true"
        className={`inline-block h-2 w-2 rounded-full ${live ? 'bg-positive' : 'bg-warning'}`}
      />
      {live ? 'Live' : status === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
    </span>
  );
}
