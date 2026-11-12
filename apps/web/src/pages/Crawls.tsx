import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api as defaultApi, ApiError, type ApiClient } from '../api/client';
import { useEventStream, type EventStreamOptions } from '../api/sse';
import { EmptyState, ErrorBanner, errorMessage, Kpi, SkeletonText } from '../components';
import { paths } from '../routes';
import { RunDetails } from './crawls/RunDetails';
import { RunsGrid } from './crawls/RunsGrid';
import {
  applyFrame,
  formatCount,
  isLive,
  pagesHandled,
  pausedMessage,
  W10_COPY,
  type CrawlAiCalls,
  type CrawlRun,
  type CrawlSite,
  type ProgressFrame,
} from './crawls/model';
import { cardClass, primaryButton } from './onboarding/kit';
import { KPI_STRIP, PAGE, PageHeader } from './Panel';

export const EVENTS_URL = '/api/publishers/me/events';
const RUNS_LIMIT = 20;

type Load<T> =
  { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'ready'; data: T };
type Notice = { tone: 'info' | 'danger'; text: ReactNode } | null;

export interface CrawlsProps {
  client?: ApiClient;
  /** Tests pass a fake EventSource (both streams use it). */
  sse?: EventStreamOptions & { enabled?: boolean };
  /** Runs re-read while a run is live and its stream isn't open. */
  pollMs?: number;
  now?: () => number;
}

/**
 * W10 Crawls & health (screens.md §W10; features/03 §Screens, features/04 §6; SP-054). Shows the
 * crawler is polite and that routine crawls make **0 AI calls**: the runs table with counters and
 * an AI-calls column (the discovery run carries the schema proposal calls), live progress of the
 * running crawl over `GET /api/crawl-runs/:id/events`, the paused state (W15 copy) and "Crawl now".
 * Publisher SSE `crawl.progress` (or a reconnect) re-reads the runs, so a crawl started elsewhere
 * (schedule, ping, publish) shows up.
 *
 * Drift alerts land with SP-052a, which adds the LIVE_STALE signal this screen would read.
 */
export default function CrawlsPage({
  client = defaultApi,
  sse,
  pollMs = 5_000,
  now = Date.now,
}: CrawlsProps) {
  const [params] = useSearchParams();
  const [sites, setSites] = useState<Load<CrawlSite[]>>({ status: 'loading' });
  const [sitesAttempt, setSitesAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setSites({ status: 'loading' });
    client.get<{ sites: CrawlSite[] }>('/api/sites').then(
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

  const frame = (body: ReactNode, header?: ReactNode) => (
    <section className={PAGE} data-screen="W10">
      <PageHeader
        title="Crawls"
        description={
          site
            ? `How Spigot reads ${site.origin.replace(/^https?:\/\//, '')}`
            : 'How Spigot reads your site'
        }
        actions={header}
      />
      {body}
    </section>
  );

  if (sites.status === 'error') {
    return frame(<ErrorBanner error={sites.error} onRetry={() => setSitesAttempt((n) => n + 1)} />);
  }
  if (sites.status === 'loading') {
    return frame(
      <div className={cardClass} aria-busy="true">
        <SkeletonText lines={4} />
      </div>,
    );
  }
  if (!site) {
    return frame(
      <EmptyState
        message="Connect your site to start crawling it."
        action={{ label: 'Connect your site', to: paths.connectSite }}
      />,
    );
  }
  return (
    <SiteCrawls
      key={site.id}
      site={site}
      client={client}
      sse={sse}
      pollMs={pollMs}
      now={now}
      frame={frame}
    />
  );
}

function SiteCrawls({
  site: initialSite,
  client,
  sse,
  pollMs,
  now,
  frame,
}: {
  site: CrawlSite;
  client: ApiClient;
  sse?: EventStreamOptions & { enabled?: boolean };
  pollMs: number;
  now: () => number;
  frame: (body: ReactNode, header?: ReactNode) => ReactNode;
}) {
  const [site, setSite] = useState(initialSite);
  const [runs, setRuns] = useState<Load<CrawlRun[]>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [clock, setClock] = useState(now);
  // Site-wide totals from the API: the listed page holds only the newest RUNS_LIMIT runs.
  const [aiCalls, setAiCalls] = useState<CrawlAiCalls | null>(null);
  const runsRef = useRef<CrawlRun[]>([]);
  const seq = useRef(0);
  const runsPath = `/api/sites/${encodeURIComponent(site.id)}/crawl-runs?limit=${RUNS_LIMIT}`;

  const setRunList = useCallback((list: CrawlRun[]) => {
    runsRef.current = list;
    setRuns({ status: 'ready', data: list });
  }, []);

  /** Re-read the runs; an answer a newer request overtook is dropped. */
  const refetch = useCallback(async () => {
    const mine = ++seq.current;
    const res = await client.get<{ runs: CrawlRun[]; aiCalls: CrawlAiCalls }>(runsPath);
    if (mine !== seq.current) return;
    setAiCalls(res.aiCalls);
    setRunList(res.runs);
  }, [client, runsPath, setRunList]);

  useEffect(() => {
    let live = true;
    setRuns({ status: 'loading' });
    refetch().catch((error: unknown) => live && setRuns({ status: 'error', error }));
    return () => {
      live = false;
    };
  }, [refetch, attempt]);

  const quietRefetch = useCallback(() => {
    refetch().catch(() => undefined); // Keep the rows we have; the next event or poll retries.
  }, [refetch]);

  const list = runs.status === 'ready' ? runs.data : [];
  const liveRun = list.find(isLive) ?? null;
  const latest = list[0];

  // Live progress of the running crawl.
  const streamUrl = liveRun ? `/api/crawl-runs/${encodeURIComponent(liveRun.id)}/events` : null;
  const runStream = useEventStream(
    streamUrl,
    {
      onEvent: (msg) => {
        const f = msg.data as ProgressFrame | undefined;
        if (!f?.crawlRunId) return;
        const cur = runsRef.current;
        const i = cur.findIndex((r) => r.id === f.crawlRunId);
        if (i < 0) return;
        const next = applyFrame(cur[i]!, f);
        if (next !== cur[i]) setRunList(cur.map((r, j) => (j === i ? next : r)));
        // The done frame has no records, error or finish time; the run row does.
        if (msg.type === 'done' || !isLive(next)) quietRefetch();
      },
      onRefetch: quietRefetch,
    },
    { ...sse, events: ['progress', 'done'] },
  );

  // Runs started elsewhere (schedule, ping, publish) arrive as publisher `crawl.progress`.
  useEventStream(
    EVENTS_URL,
    {
      onEvent: (m) => m.type === 'crawl.progress' && quietRefetch(),
      onRefetch: quietRefetch,
    },
    { ...sse, events: ['crawl.progress'] },
  );

  const needsPoll = liveRun !== null && runStream !== 'open';
  useEffect(() => {
    if (!needsPoll) return;
    const t = setInterval(quietRefetch, pollMs);
    return () => clearInterval(t);
  }, [needsPoll, quietRefetch, pollMs]);

  // A 1 s clock for the live run's duration.
  const ticking = liveRun !== null;
  useEffect(() => {
    if (!ticking) return;
    setClock(now());
    const t = setInterval(() => setClock(now()), 1_000);
    return () => clearInterval(t);
  }, [ticking, now]);

  async function crawlNow() {
    if (startingRef.current || liveRun) return;
    startingRef.current = true;
    setStarting(true);
    setNotice(null);
    try {
      await client.post<{ crawlRunId: string }>(
        `/api/sites/${encodeURIComponent(site.id)}/crawl`,
        { trigger: 'MANUAL' },
        { idempotencyKey: `w10-crawl-${crypto.randomUUID()}` },
      );
      // The API resumes a PAUSED site before crawling it.
      if (site.status === 'PAUSED') setSite({ ...site, status: 'READY' });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CRAWL_IN_PROGRESS') {
        setNotice({ tone: 'info', text: W10_COPY.inProgress });
      } else if (err instanceof ApiError && err.code === 'SITE_NOT_VERIFIED') {
        setNotice({
          tone: 'danger',
          text: (
            <>
              {errorMessage(err)}{' '}
              <Link
                className="font-medium underline"
                to={`${paths.installVerify}?site=${encodeURIComponent(site.id)}`}
              >
                Verify the site
              </Link>
            </>
          ),
        });
      } else {
        setNotice({ tone: 'danger', text: errorMessage(err) });
      }
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
    await refetch().catch(() => undefined);
  }

  const paused = !liveRun && (site.status === 'PAUSED' || latest?.status === 'PAUSED');
  const crawlButton = (
    <button
      type="button"
      onClick={crawlNow}
      disabled={starting || liveRun !== null || runs.status !== 'ready'}
      className={primaryButton}
    >
      {starting
        ? 'Starting…'
        : liveRun
          ? 'Crawling…'
          : paused
            ? 'Resume and crawl now'
            : 'Crawl now'}
    </button>
  );

  if (runs.status === 'error') {
    return frame(
      <ErrorBanner error={runs.error} onRetry={() => setAttempt((n) => n + 1)} />,
      crawlButton,
    );
  }

  const ready = runs.status === 'ready';
  const opened = openId ? list.find((r) => r.id === openId) : undefined;

  return frame(
    <>
      {notice && (
        <p
          role={notice.tone === 'danger' ? 'alert' : 'status'}
          className={`rounded-lg px-4 py-3 text-sm ${
            notice.tone === 'danger' ? 'bg-danger-tint text-danger' : 'bg-info-tint text-info'
          }`}
        >
          {notice.text}
        </p>
      )}

      {paused && (
        <div
          role="alert"
          data-paused=""
          className="rounded-lg border border-warning/30 bg-warning-tint px-4 py-3 text-sm text-warning"
        >
          <p className="font-medium">
            {pausedMessage(latest?.status === 'PAUSED' ? latest : undefined)}
          </p>
          <p className="mt-1">
            Your records are still on sale; they update again once the crawl resumes.
          </p>
        </div>
      )}

      {ready && !liveRun && latest?.status === 'FAILED' && (
        <div
          role="alert"
          className="rounded-lg border border-danger/30 bg-danger-tint px-4 py-3 text-sm text-danger"
        >
          <p className="font-medium">The last crawl failed.</p>
          {latest.error && <p className="mt-1">{latest.error}</p>}
        </div>
      )}

      <div>
        <div
          className={`${KPI_STRIP} grid-cols-1 sm:grid-cols-3`}
          role="group"
          aria-label="Crawl health"
        >
          <Kpi
            label="AI calls on routine crawls"
            loading={!ready}
            value={aiCalls ? formatCount(aiCalls.routine) : '—'}
            hint="Every crawl after the first: plain code, no Claude"
          />
          <Kpi
            label="AI calls on discovery"
            loading={!ready}
            value={aiCalls?.discovery == null ? '—' : formatCount(aiCalls.discovery)}
            hint="One-time schema proposal on the first crawl"
          />
          <Kpi
            label="Pages in the last crawl"
            loading={!ready}
            value={latest ? formatCount(latest.pagesTotal) : '—'}
          />
        </div>
        <p className="mt-3 max-w-[80ch] text-sm leading-6 text-muted">
          {W10_COPY.aiRoutine} {W10_COPY.polite}
        </p>
      </div>

      {liveRun && <LiveProgress run={liveRun} />}

      {!ready ? (
        <div className={cardClass} aria-busy="true">
          <SkeletonText lines={4} />
        </div>
      ) : list.length === 0 ? (
        <EmptyState message={W10_COPY.empty} action={{ label: 'Crawl now', onClick: crawlNow }} />
      ) : (
        <section
          aria-label="Crawl runs"
          className="min-w-0 overflow-hidden rounded-lg border border-line bg-surface"
        >
          <div className="border-b border-line px-5 py-3.5">
            <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-ink">
              Crawl runs
            </h2>
            <p className="mt-0.5 text-xs text-muted">Open a run for its pages and changes.</p>
          </div>
          <RunsGrid bare runs={list} now={clock} onOpen={(r) => setOpenId(r.id)} />
        </section>
      )}

      {opened && <RunDetails run={opened} now={clock} onClose={() => setOpenId(null)} />}
    </>,
    crawlButton,
  );
}

function LiveProgress({ run }: { run: CrawlRun }) {
  const done = pagesHandled(run);
  const total = run.pagesTotal;
  return (
    <section aria-label="Crawl in progress" className={cardClass}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold text-ink">
          {run.status === 'QUEUED' ? 'Crawl queued' : 'Crawling'}
        </h2>
        <p className="text-sm tabular-nums text-body" data-progress="">
          {total > 0
            ? `${formatCount(done)} of ${formatCount(total)} pages`
            : 'Reading the sitemap…'}
        </p>
      </div>
      <div
        role="progressbar"
        aria-label="Pages read"
        aria-valuemin={0}
        aria-valuemax={total || undefined}
        aria-valuenow={total ? done : undefined}
        className="mt-3 h-2 overflow-hidden rounded-full bg-surface-2"
      >
        <div
          className="h-full rounded-full bg-accent transition-[width]"
          style={{ width: total ? `${Math.min(100, (done / total) * 100)}%` : '0%' }}
        />
      </div>
      <p className="mt-2 text-sm tabular-nums text-muted">
        {formatCount(run.pagesFetched)} fetched · {formatCount(run.pagesNotModified)} not modified ·{' '}
        {formatCount(run.pagesFailed)} failed · AI calls {formatCount(run.aiCalls)}
      </p>
    </section>
  );
}
