import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api as defaultApi, ApiError, type ApiClient } from '../../api/client';
import { useEventStream } from '../../api/sse';
import { EmptyState, ErrorBanner, errorMessage, Skeleton, SkeletonText } from '../../components';
import { paths } from '../../routes';
import {
  ago,
  cardClass,
  CodeBlock,
  CopyButton,
  forgetSiteKeys,
  OnboardingLayout,
  peekSiteKeys,
  Pill,
  primaryButton,
  secondaryButton,
  type SiteKeys,
} from './kit';

// ---------------------------------------------------------------------------------------------
// API shapes (api.md §Publisher endpoints; SP-008a / SP-008b / SP-009b)

/** `GET /api/sites/:id` (no key hashes; the verify token is public). */
export interface SiteView {
  id: string;
  slug: string;
  origin: string;
  sitemapUrl: string | null;
  status: string;
  verify: { path: string; content: string };
  lastGateSeenAt: string | null;
}

/** `GET /api/sites/:id/gate-status`: `installed` = a hit post in the last 10 minutes. */
export interface GateStatus {
  installed: boolean;
  lastSeenAt: string | null;
  policyVersion: number;
}

export type RunStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'PAUSED';

/** One row of `GET /api/sites/:id/crawl-runs`. */
export interface CrawlRun {
  id: string;
  status: RunStatus;
  pagesTotal: number;
  pagesFetched: number;
  pagesNotModified: number;
  pagesFailed: number;
  error: string | null;
}

/** `progress` / `done` frames of `GET /api/crawl-runs/:id/events`. */
interface ProgressFrame {
  crawlRunId: string;
  status: RunStatus;
  pagesTotal: number;
  pagesFetched: number;
  pagesNotModified: number;
  pagesFailed: number;
}

const LIVE: readonly RunStatus[] = ['QUEUED', 'RUNNING'];
const DONE: readonly RunStatus[] = ['SUCCEEDED', 'PARTIAL'];

export const W03_COPY = {
  failsOpen: 'Fails open: if Spigot is down, your site keeps working',
  waiting: 'Waiting for first hit',
  keysGone:
    'Your keys were shown once, when you connected the site. If you lost them, rotate them in Settings.',
  failedFallback: 'The crawl stopped before it finished.',
  paused: 'Your site asked us to slow down, so we paused the crawl.',
} as const;

type CrawlState =
  | { kind: 'unknown' }
  | { kind: 'none' }
  | { kind: 'starting' }
  | { kind: 'live'; run: CrawlRun }
  | { kind: 'done'; run: CrawlRun }
  | { kind: 'failed'; run: CrawlRun | null; reason: string };

function crawlStateOf(run: CrawlRun | undefined): CrawlState {
  if (!run) return { kind: 'none' };
  if (LIVE.includes(run.status)) return { kind: 'live', run };
  if (DONE.includes(run.status)) return { kind: 'done', run };
  return {
    kind: 'failed',
    run,
    reason: run.error ?? (run.status === 'PAUSED' ? W03_COPY.paused : W03_COPY.failedFallback),
  };
}

const handled = (r: CrawlRun) => r.pagesFetched + r.pagesNotModified + r.pagesFailed;

// ---------------------------------------------------------------------------------------------

export interface InstallVerifyProps {
  siteId: string;
  client?: ApiClient;
  /** Gate-status poll (and crawl fallback poll) interval. */
  pollMs?: number;
  /** The `apiBase` in the install snippet: the app's own origin (the API serves this app). */
  apiBase?: string;
  /** SSE on/off (tests); defaults to on outside fixture mode. */
  streamEnabled?: boolean;
}

/**
 * W03 Install the gate + verify (screens.md §W03; features/02, 03). Stepper Verify → Install gate
 * → First crawl. Verifying starts the discovery crawl on the server (api.md), so the crawl step
 * picks that run up; "Start first crawl" is there when no run exists yet, and "Retry" after a
 * failed one. The gate and crawl keys are shown only if this tab just connected the site.
 */
export function InstallVerify({
  siteId,
  client = defaultApi,
  pollMs = 5_000,
  apiBase = typeof window === 'undefined' ? '' : window.location.origin,
  streamEnabled,
}: InstallVerifyProps) {
  const navigate = useNavigate();
  const [site, setSite] = useState<SiteView | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);

  // Keys: read once from memory, then dropped from memory when this screen goes away.
  const [keys] = useState<SiteKeys | null>(() => peekSiteKeys(siteId));
  useEffect(() => () => forgetSiteKeys(siteId), [siteId]);

  const onAuthError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        const next = `${paths.installVerify}?site=${encodeURIComponent(siteId)}`;
        navigate(`${paths.login}?next=${encodeURIComponent(next)}`, { replace: true });
        return true;
      }
      return false;
    },
    [navigate, siteId],
  );

  useEffect(() => {
    let live = true;
    setLoadError(null);
    client.get<SiteView>(`/api/sites/${encodeURIComponent(siteId)}`).then(
      (s) => live && setSite(s),
      (err: unknown) => live && !onAuthError(err) && setLoadError(err),
    );
    return () => {
      live = false;
    };
  }, [client, siteId, attempt, onAuthError]);

  if (loadError) {
    return (
      <ErrorBanner
        title="We couldn't load your site."
        error={loadError}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  }
  if (!site) {
    return (
      <div className={cardClass} aria-busy="true">
        <SkeletonText lines={4} />
      </div>
    );
  }
  return (
    <Steps
      site={site}
      setSite={setSite}
      keys={keys}
      client={client}
      pollMs={pollMs}
      apiBase={apiBase}
      streamEnabled={streamEnabled}
    />
  );
}

function Steps({
  site,
  setSite,
  keys,
  client,
  pollMs,
  apiBase,
  streamEnabled,
}: {
  site: SiteView;
  setSite: (s: SiteView) => void;
  keys: SiteKeys | null;
  client: ApiClient;
  pollMs: number;
  apiBase: string;
  streamEnabled?: boolean;
}) {
  const verified = site.status !== 'PENDING_VERIFY';
  const sitePath = `/api/sites/${encodeURIComponent(site.id)}`;

  // --- Verify
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  async function checkNow() {
    if (verifying) return;
    setVerifying(true);
    setVerifyError(null);
    try {
      const { status } = await client.post<{ status: string }>(`${sitePath}/verify`);
      setSite({ ...site, status });
    } catch (err) {
      setVerifyError(errorMessage(err));
    } finally {
      setVerifying(false);
    }
  }

  // --- Gate status (poll every pollMs) and a 1 s clock for "last hit 4 s ago"
  const [gate, setGate] = useState<GateStatus | null>(null);
  const [gateError, setGateError] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let live = true;
    const load = () =>
      client.get<GateStatus>(`${sitePath}/gate-status`).then(
        (g) => {
          if (!live) return;
          setGate(g);
          setGateError(false);
          setNow(Date.now());
        },
        () => live && setGateError(true),
      );
    void load();
    const poll = setInterval(load, pollMs);
    const clock = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      live = false;
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [client, sitePath, pollMs]);

  // --- Crawl
  const [crawl, setCrawl] = useState<CrawlState>({ kind: 'unknown' });
  const crawlRef = useRef(crawl);
  crawlRef.current = crawl;

  const loadRuns = useCallback(async () => {
    try {
      const { runs } = await client.get<{ runs: CrawlRun[] }>(`${sitePath}/crawl-runs?limit=1`);
      const cur = crawlRef.current;
      // A click on "Start first crawl" in flight owns the state until it resolves, and a read
      // that doesn't include the run we are following can't replace it.
      if (cur.kind === 'starting') return;
      if (cur.kind === 'live' && runs[0]?.id !== cur.run.id) return;
      setCrawl(crawlStateOf(runs[0]));
    } catch {
      // Keep what we have; the next poll tries again.
    }
  }, [client, sitePath]);

  // Once verified: read the latest run, and keep re-reading while there is none (the discovery
  // crawl starts just after verify) or the stream isn't delivering progress.
  const runId = crawl.kind === 'live' ? crawl.run.id : null;
  const streamUrl = runId ? `/api/crawl-runs/${encodeURIComponent(runId)}/events` : null;
  const streamStatus = useEventStream(
    streamUrl,
    {
      onEvent: (msg) => {
        const f = msg.data as ProgressFrame;
        const cur = crawlRef.current;
        if (cur.kind !== 'live' || f?.crawlRunId !== cur.run.id) return;
        const run: CrawlRun = { ...cur.run, ...f, id: cur.run.id };
        if (msg.type === 'done' || !LIVE.includes(run.status)) {
          setCrawl(crawlStateOf(run));
          // The done frame has no error text; the run row does.
          if (!DONE.includes(run.status)) void loadRuns();
        } else if (handled(run) >= handled(cur.run) || run.pagesTotal !== cur.run.pagesTotal) {
          setCrawl({ kind: 'live', run });
        }
      },
      onRefetch: () => void loadRuns(),
    },
    {
      events: ['progress', 'done'],
      ...(streamEnabled === undefined ? {} : { enabled: streamEnabled }),
    },
  );

  const needsPoll =
    verified &&
    (crawl.kind === 'unknown' ||
      crawl.kind === 'none' ||
      (crawl.kind === 'live' && streamStatus !== 'open'));
  useEffect(() => {
    if (!verified) return;
    if (crawlRef.current.kind === 'unknown') void loadRuns();
    if (!needsPoll) return;
    const t = setInterval(() => void loadRuns(), pollMs);
    return () => clearInterval(t);
  }, [verified, needsPoll, loadRuns, pollMs]);

  async function startCrawl() {
    const prev = crawlRef.current;
    if (prev.kind === 'starting' || prev.kind === 'live') return;
    setCrawl({ kind: 'starting' });
    crawlRef.current = { kind: 'starting' };
    const pending = (id: string): CrawlRun => ({
      id,
      status: 'QUEUED',
      pagesTotal: 0,
      pagesFetched: 0,
      pagesNotModified: 0,
      pagesFailed: 0,
      error: null,
    });
    let next: CrawlState;
    try {
      const { crawlRunId } = await client.post<{ crawlRunId: string }>(
        `${sitePath}/crawl`,
        { trigger: 'MANUAL' },
        { idempotencyKey: `w03-crawl-${crypto.randomUUID()}` },
      );
      next = { kind: 'live', run: pending(crawlRunId) };
    } catch (err) {
      const liveId =
        err instanceof ApiError && err.code === 'CRAWL_IN_PROGRESS'
          ? (err.details.crawlRunId as string | undefined)
          : undefined;
      next = liveId
        ? { kind: 'live', run: pending(liveId) }
        : {
            kind: 'failed',
            run: prev.kind === 'failed' ? prev.run : null,
            reason: errorMessage(err),
          };
    }
    crawlRef.current = next;
    setCrawl(next);
    // Fill in the run's counters; a failed request keeps its own reason on screen.
    if (next.kind === 'live') void loadRuns();
  }

  const gateSeen = !!gate?.lastSeenAt;
  const step = !verified ? 1 : crawl.kind === 'done' ? 4 : gateSeen ? 3 : 2;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-ink">Set up {hostOf(site.origin)}</h1>
        <p className="mt-1 text-sm text-muted">
          Prove you own the site, install the gate, then let Spigot read your pages.
        </p>
        <Stepper current={step} />
      </header>

      <section aria-labelledby="w03-verify" className={cardClass}>
        <div className="flex items-center justify-between gap-3">
          <h2 id="w03-verify" className="font-semibold text-ink">
            1. Verify you own the site
          </h2>
          {verified ? (
            <Pill tone="positive">Verified</Pill>
          ) : verifying ? (
            <Pill tone="info">Checking…</Pill>
          ) : (
            <Pill tone="neutral">Not verified yet</Pill>
          )}
        </div>
        {verified ? (
          <p className="mt-2 text-sm text-body">We found the verification file on {site.origin}.</p>
        ) : (
          <>
            <p className="mt-2 text-sm text-body">
              Serve this text at <span className="font-mono">{site.verify.path}</span> on your site.
            </p>
            <p className="mt-3 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted">
              File path
            </p>
            <CodeBlock code={site.verify.path} copyLabel="Copy file path" />
            <p className="mt-3 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted">
              Content
            </p>
            <CodeBlock code={site.verify.content} copyLabel="Copy file content" />
            {verifyError && (
              <p
                role="alert"
                className="mt-3 rounded-md bg-danger-tint px-3 py-2 text-sm text-danger"
              >
                {verifyError}
              </p>
            )}
            <button
              type="button"
              onClick={checkNow}
              disabled={verifying}
              className={`mt-4 rounded-full ${secondaryButton}`}
            >
              {verifying ? 'Checking…' : 'Check now'}
            </button>
          </>
        )}
      </section>

      <section aria-labelledby="w03-install" className={cardClass}>
        <div className="flex items-center justify-between gap-3">
          <h2 id="w03-install" className="font-semibold text-ink">
            2. Install the gate
          </h2>
          <GatePill gate={gate} failed={gateError} now={now} />
        </div>
        <p className="mt-3 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted">
          Install
        </p>
        <CodeBlock code="npm i @spigot/gate" copyLabel="Copy install command" />
        <p className="mt-3 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted">
          Add it to your Express app
        </p>
        <CodeBlock code={expressSnippet(apiBase)} copyLabel="Copy Express snippet" />
        <p className="mt-3 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted">
          Environment variables
        </p>
        {keys ? (
          <>
            <p className="mt-1 text-sm text-warning">
              Shown once. Copy them now: Spigot keeps only a hash.
            </p>
            <KeyRow name="SPIGOT_GATE_KEY" value={keys.gateKey} />
            <KeyRow name="SPIGOT_CRAWL_KEY" value={keys.crawlKey} />
          </>
        ) : (
          <p className="mt-1 rounded-md bg-surface-2 px-3 py-2 text-sm text-body">
            {W03_COPY.keysGone}{' '}
            <Link className="font-medium text-accent hover:underline" to={paths.settings}>
              Rotate in Settings
            </Link>
          </p>
        )}
        <p className="mt-4 text-sm text-muted">{W03_COPY.failsOpen}</p>
      </section>

      <section aria-labelledby="w03-crawl" className={cardClass}>
        <h2 id="w03-crawl" className="font-semibold text-ink">
          3. First crawl
        </h2>
        <CrawlBox verified={verified} crawl={crawl} onStart={startCrawl} />
      </section>

      <p className="text-center text-sm text-muted">
        <Link className="font-medium text-accent hover:underline" to={paths.overview}>
          Go to the dashboard
        </Link>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

const STEPS = ['Verify', 'Install gate', 'First crawl'] as const;

function Stepper({ current }: { current: number }) {
  return (
    <ol className="mt-6 grid grid-cols-3 gap-3" aria-label="Setup steps">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const state = n < current ? 'done' : n === current ? 'current' : 'todo';
        return (
          <li
            key={label}
            data-state={state}
            aria-current={state === 'current' ? 'step' : undefined}
            className="min-w-0 text-sm"
          >
            <span
              aria-hidden="true"
              className={`block h-1 rounded-full ${state === 'todo' ? 'bg-line' : 'bg-accent'}`}
            />
            <span
              className={`mt-2.5 flex items-center gap-1.5 ${
                state === 'current'
                  ? 'font-semibold text-ink'
                  : state === 'done'
                    ? 'font-medium text-body'
                    : 'text-muted'
              }`}
            >
              {state === 'done' ? (
                <>
                  <span className="sr-only">Done: </span>
                  <svg
                    viewBox="0 0 16 16"
                    className="size-3.5 shrink-0 text-accent"
                    aria-hidden="true"
                  >
                    <path
                      d="M3.5 8.5l3 3 6-7"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </>
              ) : (
                <span className="tabular-nums">{n}.</span>
              )}
              <span className="truncate">{label}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function GatePill({
  gate,
  failed,
  now,
}: {
  gate: GateStatus | null;
  failed: boolean;
  now: number;
}) {
  if (!gate) {
    return failed ? (
      <Pill tone="neutral">Gate status unavailable</Pill>
    ) : (
      <Skeleton className="h-5 w-32" />
    );
  }
  const label = 'Gate status';
  if (!gate.lastSeenAt) {
    return (
      <Pill tone="info" label={`${label}: ${W03_COPY.waiting}`}>
        {W03_COPY.waiting}
      </Pill>
    );
  }
  const text = gate.installed
    ? `Installed · last hit ${ago(gate.lastSeenAt, now)}`
    : `No recent hits · last hit ${ago(gate.lastSeenAt, now)}`;
  return (
    <Pill tone={gate.installed ? 'positive' : 'warning'} label={`${label}: ${text}`}>
      {text}
    </Pill>
  );
}

function KeyRow({ name, value }: { name: string; value: string }) {
  return (
    <div className="mt-2 flex items-center gap-2 rounded-md bg-surface-2 p-3">
      <code className="min-w-0 flex-1 truncate font-mono text-sm text-ink">
        {name}={value}
      </code>
      <CopyButton text={value} label={`Copy ${name}`} />
    </div>
  );
}

function CrawlBox({
  verified,
  crawl,
  onStart,
}: {
  verified: boolean;
  crawl: CrawlState;
  onStart: () => void;
}) {
  if (!verified) {
    return (
      <p className="mt-2 text-sm text-muted">Verify the site first. Then we read your sitemap.</p>
    );
  }
  switch (crawl.kind) {
    case 'unknown':
      return (
        <div className="mt-3" aria-busy="true">
          <Skeleton className="h-3 w-full" />
        </div>
      );
    case 'none':
    case 'starting':
      return (
        <>
          <p className="mt-2 text-sm text-body">
            Spigot reads the pages in your sitemap, 2 at a time, and respects Retry-After.
          </p>
          <button
            type="button"
            onClick={onStart}
            disabled={crawl.kind === 'starting'}
            className={`mt-4 ${primaryButton}`}
          >
            {crawl.kind === 'starting' ? 'Starting…' : 'Start first crawl'}
          </button>
        </>
      );
    case 'live':
      return <Progress run={crawl.run} />;
    case 'done':
      return (
        <>
          <Progress run={crawl.run} />
          <p className="mt-3 text-sm text-positive">
            Done. We read {crawl.run.pagesTotal.toLocaleString('en-US')} pages.
          </p>
          <Link to={paths.recordTypes} className={`mt-4 inline-block ${primaryButton}`}>
            See what we found
          </Link>
        </>
      );
    case 'failed':
      return (
        <>
          {crawl.run && <Progress run={crawl.run} />}
          <div
            role="alert"
            className="mt-3 rounded-md bg-danger-tint px-3 py-2 text-sm text-danger"
          >
            <p className="font-medium">The crawl failed.</p>
            <p className="mt-1">{crawl.reason}</p>
          </div>
          <button type="button" onClick={onStart} className={`mt-4 ${primaryButton}`}>
            Retry crawl
          </button>
        </>
      );
  }
}

function Progress({ run }: { run: CrawlRun }) {
  const done = handled(run);
  const pct = run.pagesTotal > 0 ? Math.min(100, Math.round((done / run.pagesTotal) * 100)) : 0;
  const fmt = (n: number) => n.toLocaleString('en-US');
  return (
    <div className="mt-3">
      <div
        role="progressbar"
        aria-label="Crawl progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-2 w-full overflow-hidden rounded-full bg-surface-2"
      >
        <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 text-sm text-body">
        {run.pagesTotal === 0 && LIVE.includes(run.status)
          ? 'Reading your sitemap…'
          : `${fmt(run.pagesTotal)} pages found · ${fmt(done)} fetched`}
        {run.pagesFailed > 0 && ` · ${fmt(run.pagesFailed)} failed`}
      </p>
    </div>
  );
}

export function expressSnippet(apiBase: string): string {
  return [
    "import { spigotGate } from '@spigot/gate';",
    '// Before your routes:',
    `app.use(spigotGate({ gateKey: process.env.SPIGOT_GATE_KEY, apiBase: '${apiBase}' }));`,
  ].join('\n');
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

// ---------------------------------------------------------------------------------------------

/**
 * `/app/install?site=<id>`. Without `?site=` (e.g. a bookmark), the publisher's newest site; with
 * no site at all, a pointer back to W02.
 */
export default function InstallVerifyPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const fromQuery = params.get('site');
  const [siteId, setSiteId] = useState<string | null>(fromQuery);
  const [state, setState] = useState<'loading' | 'none' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (fromQuery) {
      setSiteId(fromQuery);
      return;
    }
    let live = true;
    setState('loading');
    defaultApi.get<{ sites: { id: string }[] }>('/api/sites').then(
      ({ sites }) => {
        if (!live) return;
        const newest = sites[sites.length - 1];
        if (newest) setSiteId(newest.id);
        else setState('none');
      },
      (err: unknown) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 401) {
          navigate(`${paths.login}?next=${encodeURIComponent(paths.installVerify)}`, {
            replace: true,
          });
          return;
        }
        setError(err);
        setState('error');
      },
    );
    return () => {
      live = false;
    };
  }, [fromQuery, attempt, navigate]);

  return (
    <OnboardingLayout wide>
      {siteId ? (
        <InstallVerify key={siteId} siteId={siteId} />
      ) : state === 'none' ? (
        <EmptyState
          message="Connect a site first."
          action={{ label: 'Connect your site', to: paths.connectSite }}
        />
      ) : state === 'error' ? (
        <ErrorBanner error={error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : (
        <div className={cardClass} aria-busy="true">
          <SkeletonText lines={4} />
        </div>
      )}
    </OnboardingLayout>
  );
}
