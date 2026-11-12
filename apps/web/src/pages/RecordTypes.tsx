import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { api as defaultApi, ApiError, type ApiClient } from '../api/client';
import { fixturesEnabled } from '../api/fixtures';
import { useEventStream, type EventSourceFactory } from '../api/sse';
import { EmptyState, ErrorBanner, errorMessage, Skeleton, SkeletonText } from '../components';
import { displayPattern, ProposalCard, type Proposal } from '../components/ProposalCard';
import { paths } from '../routes';
import { LABEL } from '../theme/label';

/**
 * W05 Record types found (SP-028; screens.md §W05, features/04 §Purpose, features/13 §2).
 *
 * Data: `GET /api/sites` (first site, or `?site=<id>`), then for that site
 *   - `GET /api/sites/:id/proposals` (SP-014b): one card per PROPOSED dataset;
 *   - `GET /api/sites/:id/proposal-status` (SP-028): crawl / agent progress, templates being read
 *     and templates skipped by the last run.
 *
 * Live: SSE `proposal.ready` and `crawl.progress` refetch both (events carry ids only), as does a
 * reconnect. While the crawl or the agent is running we also poll every 5 s, because a run that
 * ends with zero proposals emits no `proposal.ready`.
 *
 * States: crawling; proposing (`running`: cards stream in, a "reading 5 sample pages…" line per template
 * still being read); ready; a skipped template ("Couldn't find consistent fields on /blog/*;
 * skipped"); waiting for retry (PROPOSING with no run going: the model was unreachable, the resume
 * job retries; no skeleton, polling continues); none (no repeated structure).
 */

export interface ProposalStatus {
  siteStatus: string;
  crawling: boolean;
  running: boolean;
  templates: { pattern: string; pageCount: number; state: 'reading' | 'skipped' | 'failed' }[];
  message: string | null;
}

interface SiteSummary {
  id: string;
  origin: string;
  status: string;
}

interface Loaded {
  site: SiteSummary | null;
  proposals: Proposal[];
  status: ProposalStatus | null;
}

export const POLL_MS = 5_000;
const SAMPLE_PAGES = 5;
const EVENTS = ['proposal.ready', 'crawl.progress'] as const;

/** "I found 3 kinds of records on your site" */
export function headline(n: number): string {
  return `I found ${n} ${n === 1 ? 'kind of record' : 'kinds of records'} on your site`;
}

/** `/blog/:slug` → `/blog/*`, the way the skip line names a template. */
const starPattern = (p: string) => displayPattern(p).replace(/:[A-Za-z0-9]+/g, '*');

export default function RecordTypesPage({
  client = defaultApi,
  createSource,
  pollMs = POLL_MS,
}: {
  client?: ApiClient;
  /** Tests pass a fake EventSource. */
  createSource?: EventSourceFactory;
  pollMs?: number;
}) {
  const [params] = useSearchParams();
  const wantedSite = params.get('site');
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'ready'; data: Loaded }
  >({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  /** Rejected here: hidden even if a refetch that started before the reject still lists them. */
  const rejected = useRef(new Set<string>());
  const [rejecting, setRejecting] = useState<ReadonlySet<string>>(new Set());
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const seq = useRef(0);

  const load = useCallback(
    async (initial: boolean) => {
      const mine = ++seq.current;
      if (initial) setState({ status: 'loading' });
      try {
        const { sites } = await client.get<{ sites: SiteSummary[] }>('/api/sites');
        const site = sites.find((s) => s.id === wantedSite) ?? sites[0] ?? null;
        let proposals: Proposal[] = [];
        let status: ProposalStatus | null = null;
        if (site) {
          const base = `/api/sites/${encodeURIComponent(site.id)}`;
          [{ proposals }, status] = await Promise.all([
            client.get<{ proposals: Proposal[] }>(`${base}/proposals`),
            client.get<ProposalStatus>(`${base}/proposal-status`),
          ]);
        }
        if (mine !== seq.current) return;
        setState({ status: 'ready', data: { site, proposals, status } });
      } catch (error) {
        if (mine !== seq.current) return;
        // A background refresh that fails keeps what's on screen; only the first load shows it.
        setState((s) => (s.status === 'ready' && !initial ? s : { status: 'error', error }));
      }
    },
    [client, wantedSite],
  );

  useEffect(() => {
    void load(true);
  }, [load, attempt]);

  const refresh = useCallback(() => void load(false), [load]);

  useEventStream(
    '/api/publishers/me/events',
    {
      onEvent: (m) => {
        if ((EVENTS as readonly string[]).includes(m.type)) refresh();
      },
      onRefetch: refresh,
    },
    { events: EVENTS, ...(createSource ? { createSource, enabled: true } : {}) },
  );

  const data = state.status === 'ready' ? state.data : null;
  const busy =
    !!data?.status &&
    (data.status.crawling || data.status.running || data.status.siteStatus === 'PROPOSING');
  useEffect(() => {
    if (!busy || (fixturesEnabled() && !createSource)) return;
    const t = setInterval(refresh, pollMs);
    return () => clearInterval(t);
  }, [busy, refresh, pollMs, createSource]);

  async function reject(p: Proposal) {
    setRejecting((s) => new Set(s).add(p.datasetId));
    setCardErrors(({ [p.datasetId]: _, ...rest }) => rest);
    try {
      await client.post(`/api/datasets/${encodeURIComponent(p.datasetId)}/reject`);
      rejected.current.add(p.datasetId);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
        // Already rejected or approved elsewhere: the list is stale, refetch it.
        refresh();
      } else {
        setCardErrors((e) => ({ ...e, [p.datasetId]: `Couldn't reject: ${errorMessage(err)}` }));
      }
    } finally {
      setRejecting((s) => {
        const next = new Set(s);
        next.delete(p.datasetId);
        return next;
      });
    }
  }

  let body: ReactNode;
  if (state.status === 'loading') {
    body = (
      <div aria-busy="true" className="mt-8 grid gap-5">
        {[0, 1].map((i) => (
          <div key={i} className="rounded-lg border border-line bg-surface p-6">
            <Skeleton className="block h-5 w-44" />
            <Skeleton className="mt-2 block h-3 w-32" />
            <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_15rem]">
              <SkeletonText lines={4} />
              <SkeletonText lines={2} />
            </div>
          </div>
        ))}
      </div>
    );
  } else if (state.status === 'error') {
    body = (
      <div className="mt-8">
        <ErrorBanner error={state.error} onRetry={() => setAttempt((n) => n + 1)} />
      </div>
    );
  } else {
    body = renderReady(state.data);
  }

  function renderReady({ site, proposals: all, status }: Loaded): ReactNode {
    if (!site) {
      return (
        <div className="mt-8">
          <EmptyState
            message="Connect your site to find the kinds of records on it."
            action={{ label: 'Connect your site', to: paths.connectSite }}
          />
        </div>
      );
    }
    const proposals = all.filter((p) => !rejected.current.has(p.datasetId));
    const reading = status?.templates.filter((t) => t.state === 'reading') ?? [];
    const skipped = status?.templates.filter((t) => t.state !== 'reading') ?? [];
    const crawling = !!status?.crawling;
    const proposing = !!status?.running;
    // The last run ended without proposals because the model was unreachable; the site stays
    // PROPOSING until SP-012a's resume job retries (~5 min). Polling continues meanwhile.
    const waitingRetry = !!status && !proposing && status.siteStatus === 'PROPOSING';
    const notCrawledYet =
      !crawling &&
      !proposing &&
      !waitingRetry &&
      (status?.siteStatus === 'PENDING_VERIFY' || status?.siteStatus === 'VERIFIED');

    if (notCrawledYet && proposals.length === 0) {
      return (
        <div className="mt-8">
          <EmptyState
            message="Verify your site and run the first crawl, then the record types show up here."
            action={{ label: 'Install and verify', to: paths.installVerify }}
          />
        </div>
      );
    }

    const live = crawling || proposing;
    // Done with nothing left to review: every step is complete, none is current.
    const step = crawling ? 0 : proposing || waitingRetry ? 1 : proposals.length > 0 ? 2 : 3;

    return (
      <>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[15px] leading-6">
          <span className="font-mono text-sm text-muted">{hostOf(site.origin)}</span>
          <p className="flex items-center gap-2 text-body" aria-live="polite">
            {live && <LiveDot />}
            {crawling
              ? 'Crawling your site…'
              : proposing
                ? 'Claude is reading a few sample pages of each page template.'
                : waitingRetry
                  ? "Claude couldn't be reached just now. Spigot tries again in a few minutes."
                  : proposals.length > 0
                    ? 'Review a type to choose its fields and price, then publish it.'
                    : null}
          </p>
        </div>

        <Steps current={step} retrying={waitingRetry} />

        {(reading.length > 0 || skipped.length > 0) && (
          <ul
            className="mt-6 divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface text-sm"
            aria-label="Templates"
          >
            {reading.map((t) => (
              <li key={`r-${t.pattern}`} className="flex items-center gap-3 px-4 py-3 text-body">
                <LiveDot />
                <code className="font-mono text-[13px] text-ink">
                  {displayPattern(t.pattern)}
                </code>{' '}
                reading {Math.min(SAMPLE_PAGES, Math.max(t.pageCount, 1))} sample pages…
              </li>
            ))}
            {skipped.map((t) => (
              <li key={`s-${t.pattern}`} className="flex items-center gap-3 px-4 py-3 text-body">
                <WarnIcon />
                {t.state === 'failed'
                  ? `Couldn't read ${starPattern(t.pattern)} yet; trying again in a few minutes`
                  : `Couldn't find consistent fields on ${starPattern(t.pattern)}; skipped`}
              </li>
            ))}
          </ul>
        )}

        {proposals.length > 0 && (
          <div className="mt-6 flex items-start gap-3 rounded-lg border border-accent-tint bg-accent-tint/50 px-4 py-3.5">
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              className="mt-0.5 size-4 shrink-0 text-accent"
            >
              <circle
                cx="10"
                cy="10"
                r="7.25"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <path
                d="M10 9v4.5M10 6.4v.1"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
              />
            </svg>
            <p className="text-sm leading-6 text-ink">
              <span className="font-semibold">How this works:</span> Claude wrote the extractor
              once. It now runs with no AI on each page.
            </p>
          </div>
        )}

        {proposals.length > 0 ? (
          <div className="mt-6 grid gap-5" aria-label="Record types">
            {proposals.map((p) => (
              <ProposalCard
                key={p.datasetId}
                proposal={p}
                onReject={reject}
                rejecting={rejecting.has(p.datasetId)}
                error={cardErrors[p.datasetId] ?? null}
              />
            ))}
          </div>
        ) : proposing || crawling ? (
          <div
            aria-busy="true"
            className="mt-6 rounded-lg border border-dashed border-border bg-surface p-6"
          >
            <Skeleton className="block h-5 w-44" />
            <div className="mt-5">
              <SkeletonText lines={3} />
            </div>
          </div>
        ) : waitingRetry ? null : (
          <div className="mt-8">
            <EmptyState
              message={
                all.length > 0
                  ? 'No record types are waiting for review.'
                  : "We didn't find repeated page structure on your site, so there are no record types to sell yet."
              }
              action={{ label: 'See crawls', to: paths.crawls }}
            />
          </div>
        )}
      </>
    );
  }

  const visible = data?.proposals.filter((p) => !rejected.current.has(p.datasetId)).length ?? 0;
  return (
    <section className="mx-auto max-w-5xl px-5 py-8 sm:px-8 sm:py-10" data-screen="W05">
      <h1 className="text-balance text-2xl font-semibold tracking-tight text-ink sm:text-[1.75rem] sm:leading-9">
        {visible > 0 ? (
          <span>
            I found {visible}{' '}
            <em className="font-serif font-normal italic text-accent">
              {visible === 1 ? 'kind of record' : 'kinds of records'}
            </em>{' '}
            on your site
          </span>
        ) : (
          'Record types on your site'
        )}
      </h1>
      {body}
    </section>
  );
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** A small pulsing dot for work in progress (static under prefers-reduced-motion). */
function LiveDot() {
  return (
    <span aria-hidden="true" className="relative inline-flex size-2 shrink-0">
      <span className="absolute inset-0 animate-ping rounded-full bg-accent opacity-50 motion-reduce:hidden" />
      <span className="relative inline-flex size-2 rounded-full bg-accent" />
    </span>
  );
}

function WarnIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4 shrink-0 text-warning">
      <path
        d="M8 2.5l6 10.5H2L8 2.5z M8 7v2.5 M8 11.2v.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const STEPS = ['Crawl the site', 'Claude reads each template', 'You review and price'] as const;

/** Where the discovery run is: crawl → agent → owner review. Decorative; the live line says it. */
function Steps({ current, retrying }: { current: number; retrying: boolean }) {
  return (
    <ol aria-hidden="true" className="mt-6 flex flex-wrap items-center gap-x-2 gap-y-2">
      {STEPS.map((label, i) => {
        const done = i < current;
        const now = i === current;
        return (
          <li key={label} className="flex items-center gap-2">
            {i > 0 && <span className={`h-px w-6 ${done || now ? 'bg-accent' : 'bg-border'}`} />}
            <span
              className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 ${LABEL} ${
                now
                  ? retrying
                    ? 'border-warning-tint bg-warning-tint text-warning'
                    : 'border-accent-tint bg-accent-tint text-accent-strong'
                  : done
                    ? 'border-line bg-surface text-body'
                    : 'border-line bg-surface text-muted'
              }`}
            >
              {done && (
                <svg viewBox="0 0 16 16" className="size-3 text-accent">
                  <path
                    d="M3.5 8.5l3 3 6-7"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
