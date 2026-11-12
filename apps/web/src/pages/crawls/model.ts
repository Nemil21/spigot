import { crawlBlockedMessage } from '@spigot/shared/copy';
import type { PillTone } from '../../components';

// ---------------------------------------------------------------------------------------------
// API shapes (api.md §Publisher endpoints; SP-009b)

export type RunStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'PAUSED';
export type CrawlTrigger = 'CONNECT' | 'MANUAL' | 'SCHEDULE' | 'PING' | 'DEMO_MUTATE' | 'APPROVE';

/** One row of `GET /api/sites/:id/crawl-runs` (newest first). */
export interface CrawlRun {
  id: string;
  siteId: string;
  trigger: CrawlTrigger;
  status: RunStatus;
  workflowRunId: string | null;
  pagesTotal: number;
  pagesFetched: number;
  pagesNotModified: number;
  pagesFailed: number;
  recordsAdded: number;
  recordsUpdated: number;
  recordsRemoved: number;
  /** Claude calls for this run: the discovery run's schema proposals; 0 for routine crawls. */
  aiCalls: number;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/** `progress` / `done` frames of `GET /api/crawl-runs/:id/events`. */
export interface ProgressFrame {
  crawlRunId: string;
  status: RunStatus;
  pagesTotal: number;
  pagesFetched: number;
  pagesNotModified: number;
  pagesFailed: number;
}

/** `GET /api/sites` row (the fields W10 reads). */
export interface CrawlSite {
  id: string;
  slug: string;
  origin: string;
  status: string;
}

// ---------------------------------------------------------------------------------------------

export const LIVE_STATUSES: readonly RunStatus[] = ['QUEUED', 'RUNNING'];
export const isLive = (r: Pick<CrawlRun, 'status'>) => LIVE_STATUSES.includes(r.status);

/** The origin's Retry-After cap (features/03 §Logic 4): what a paused site waits at most. */
export const PAUSE_RETRY_MS = 10 * 60_000;

export const W10_COPY = {
  polite:
    'Spigot reads at most 2 pages at a time from your site, waits between requests and honours Retry-After.',
  aiRoutine: 'Routine crawls use plain code: no AI calls.',
  empty: 'No crawls yet. Run the first one to read your pages.',
  inProgress: 'A crawl of this site is already running; following it.',
} as const;

const TRIGGER_LABEL: Record<CrawlTrigger, string> = {
  CONNECT: 'Discovery',
  MANUAL: 'Crawl now',
  SCHEDULE: 'Scheduled',
  PING: 'CMS ping',
  DEMO_MUTATE: 'Demo mutate',
  APPROVE: 'Publish',
};

export function triggerLabel(t: CrawlTrigger): string {
  return TRIGGER_LABEL[t] ?? t;
}

const STATUS: Record<RunStatus, [label: string, tone: PillTone]> = {
  QUEUED: ['Queued', 'neutral'],
  RUNNING: ['Running', 'info'],
  SUCCEEDED: ['Done', 'positive'],
  PARTIAL: ['Partly done', 'warning'],
  FAILED: ['Failed', 'danger'],
  PAUSED: ['Paused', 'warning'],
};

export function runStatusLabel(s: RunStatus): string {
  return STATUS[s]?.[0] ?? s;
}
export function runStatusTone(s: RunStatus): PillTone {
  return STATUS[s]?.[1] ?? 'neutral';
}

/**
 * The AI-calls cell's note. The discovery run carries the schema agent's calls (one proposal per
 * record type, plus any repairs); every other run should be 0 (features/04 §6).
 */
export function aiCallsNote(r: Pick<CrawlRun, 'trigger' | 'aiCalls'>): string | null {
  if (r.aiCalls === 0) return null;
  return r.trigger === 'CONNECT' ? 'schema proposal' : 'unexpected';
}

/** AI calls across every run that isn't the discovery crawl: the number W10 exists to show. */
export function routineAiCalls(runs: readonly CrawlRun[]): number {
  return runs.filter((r) => r.trigger !== 'CONNECT').reduce((n, r) => n + r.aiCalls, 0);
}

export const pagesHandled = (
  r: Pick<CrawlRun, 'pagesFetched' | 'pagesNotModified' | 'pagesFailed'>,
) => r.pagesFetched + r.pagesNotModified + r.pagesFailed;

/** Run time: start (or creation) to finish; a live run runs to `now`; a queued one is null. */
export function runDurationMs(r: CrawlRun, now: number): number | null {
  const start = r.startedAt ?? (r.status === 'QUEUED' ? null : r.createdAt);
  if (!start) return null;
  const end = r.finishedAt ? Date.parse(r.finishedAt) : isLive(r) ? now : null;
  if (end === null) return null;
  return Math.max(0, end - Date.parse(start));
}

/** "45 s", "3 min 12 s", "1 h 4 min". */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

export function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export const formatCount = (n: number) => n.toLocaleString('en-US');

/**
 * The paused-site copy (screens.md §W15): "Your site returned 429. We paused and will retry after
 * 10 min." The run's error names the origin's status ("Origin answered 503 3 times…"); 429 when
 * it doesn't.
 */
export function pausedMessage(run: Pick<CrawlRun, 'error'> | undefined): string {
  const m = run?.error?.match(/answered (\d{3})/);
  return crawlBlockedMessage({
    httpStatus: m ? Number(m[1]) : 429,
    retryAfterMs: PAUSE_RETRY_MS,
  });
}

/** A live progress frame applied to its run; older or repeated counters never move it back. */
export function applyFrame(run: CrawlRun, f: ProgressFrame): CrawlRun {
  if (f.crawlRunId !== run.id) return run;
  const next = { ...run, ...f, id: run.id };
  if (!isLive(next)) return next;
  return pagesHandled(next) >= pagesHandled(run) || next.pagesTotal !== run.pagesTotal ? next : run;
}
