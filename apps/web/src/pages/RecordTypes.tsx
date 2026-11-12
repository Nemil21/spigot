import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { api as defaultApi, ApiError, type ApiClient } from '../api/client';
import { fixturesEnabled } from '../api/fixtures';
import { useEventStream, type EventSourceFactory } from '../api/sse';
import { EmptyState, ErrorBanner, errorMessage, SkeletonText } from '../components';
import { displayPattern, ProposalCard, type Proposal } from '../components/ProposalCard';
import { paths } from '../routes';

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
      <div aria-busy="true" className="mt-6 grid gap-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-lg border border-line bg-surface p-6">
            <SkeletonText lines={4} />
          </div>
        ))}
      </div>
    );
  } else if (state.status === 'error') {
    body = (
      <div className="mt-6">
        <ErrorBanner error={state.error} onRetry={() => setAttempt((n) => n + 1)} />
      </div>
    );
  } else {
    body = renderReady(state.data);
  }

  function renderReady({ site, proposals: all, status }: Loaded): ReactNode {
    if (!site) {
      return (
        <div className="mt-6">
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
        <div className="mt-6">
          <EmptyState
            message="Verify your site and run the first crawl, then the record types show up here."
            action={{ label: 'Install and verify', to: paths.installVerify }}
          />
        </div>
      );
    }

    return (
      <>
        <p className="mt-2 text-body" aria-live="polite">
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

        {(reading.length > 0 || skipped.length > 0) && (
          <ul className="mt-4 space-y-1 text-sm" aria-label="Templates">
            {reading.map((t) => (
              <li key={`r-${t.pattern}`} className="text-muted">
                <code>{displayPattern(t.pattern)}</code>: reading{' '}
                {Math.min(SAMPLE_PAGES, Math.max(t.pageCount, 1))} sample pages…
              </li>
            ))}
            {skipped.map((t) => (
              <li key={`s-${t.pattern}`} className="text-warning">
                {t.state === 'failed'
                  ? `Couldn't read ${starPattern(t.pattern)} yet; trying again in a few minutes`
                  : `Couldn't find consistent fields on ${starPattern(t.pattern)}; skipped`}
              </li>
            ))}
          </ul>
        )}

        {proposals.length > 0 && (
          <p className="mt-4 rounded-md bg-accent-tint px-4 py-3 text-sm text-ink">
            <span className="font-medium">How this works:</span> Claude wrote the extractor once. It
            now runs with no AI on each page.
          </p>
        )}

        {proposals.length > 0 ? (
          <div className="mt-6 grid gap-4" aria-label="Record types">
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
            className="mt-6 rounded-lg border border-dashed border-line bg-surface p-6"
          >
            <SkeletonText lines={3} />
          </div>
        ) : waitingRetry ? null : (
          <div className="mt-6">
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
    <section className="mx-auto max-w-5xl px-6 py-8" data-screen="W05">
      <p className="text-sm font-medium text-muted">Record types</p>
      <h1 className="mt-1 text-2xl font-semibold text-ink">
        {visible > 0 ? headline(visible) : 'Record types on your site'}
      </h1>
      {body}
    </section>
  );
}
