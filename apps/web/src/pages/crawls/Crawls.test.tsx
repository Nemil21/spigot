import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient, type FetchLike } from '../../api/client';
import type { EventSourceLike } from '../../api/sse';
import runsFixture from '../../fixtures/api/sites/00000000-0000-4000-8000-0000000000a1/crawl-runs.json';
import CrawlsPage, { EVENTS_URL } from '../Crawls';
import {
  applyFrame,
  formatDuration,
  pausedMessage,
  type CrawlAiCalls,
  type CrawlRun,
  type CrawlSite,
} from './model';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const SITE_ID = '00000000-0000-4000-8000-0000000000a1';
const SITE: CrawlSite = {
  id: SITE_ID,
  slug: 'bluebonnet',
  origin: 'https://bluebonnet.example',
  status: 'READY',
};
const FIXTURE = runsFixture.runs as CrawlRun[];
const DISCOVERY = FIXTURE.find((r) => r.trigger === 'CONNECT')!;
const RUNS_URL = `/api/sites/${SITE_ID}/crawl-runs?limit=20`;
const runEvents = (id: string) => `/api/crawl-runs/${id}/events`;

function run(over: Partial<CrawlRun> = {}): CrawlRun {
  return {
    id: 'run-new',
    siteId: SITE_ID,
    trigger: 'MANUAL',
    status: 'RUNNING',
    workflowRunId: 'inproc:run-new',
    pagesTotal: 2469,
    pagesFetched: 0,
    pagesNotModified: 0,
    pagesFailed: 0,
    recordsAdded: 0,
    recordsUpdated: 0,
    recordsRemoved: 0,
    aiCalls: 0,
    error: null,
    startedAt: '2026-11-12T12:00:00.000Z',
    finishedAt: null,
    createdAt: '2026-11-12T12:00:00.000Z',
    ...over,
  };
}

function totals(runs: CrawlRun[]): CrawlAiCalls {
  const connect = runs.filter((r) => r.trigger === 'CONNECT');
  return {
    discovery: connect.length ? connect.reduce((n, r) => n + r.aiCalls, 0) : null,
    routine: runs.filter((r) => r.trigger !== 'CONNECT').reduce((n, r) => n + r.aiCalls, 0),
  };
}

interface State {
  sites: CrawlSite[];
  runs: CrawlRun[];
  /** What the API returns as `aiCalls`; default: totals over `runs` (the API sums every run). */
  aiCalls?: CrawlAiCalls;
  crawl: () => Response;
  /** While set, POST /crawl stays open until it resolves. */
  crawlHeld?: Promise<void>;
}

/** A fake API: answers W10's endpoints from `state` and records every call. */
function fakeApi(over: Partial<State> = {}) {
  const state: State = {
    sites: [SITE],
    runs: structuredClone(FIXTURE),
    crawl: () => {
      state.runs = [run({ status: 'QUEUED', pagesTotal: 0, startedAt: null }), ...state.runs];
      return json(202, { crawlRunId: 'run-new', workflowRunId: 'inproc:run-new' });
    },
    ...over,
  };
  const fetch = vi.fn<FetchLike>(async (url, init) => {
    const method = init.method ?? 'GET';
    if (method === 'GET' && url === '/api/sites') return json(200, { sites: state.sites });
    if (method === 'GET' && url === RUNS_URL)
      return json(200, { runs: state.runs, aiCalls: state.aiCalls ?? totals(state.runs) });
    if (method === 'POST' && url === `/api/sites/${SITE_ID}/crawl`) {
      await state.crawlHeld;
      return state.crawl();
    }
    return json(404, { error: { code: 'NOT_FOUND', message: `no route ${method} ${url}` } });
  });
  const calls = (method: string, url: string) =>
    fetch.mock.calls.filter(([u, i]) => u === url && (i.method ?? 'GET') === method);
  return { state, fetch, calls, client: createApiClient({ fetch, fixtures: false }) };
}

/** Fake EventSources by URL: `emit(url, 'progress', frame)`. */
function fakeSse() {
  const sources = new Map<string, Map<string, ((ev: MessageEvent) => void)[]>>();
  return {
    createSource(url: string): EventSourceLike {
      const listeners = new Map<string, ((ev: MessageEvent) => void)[]>();
      sources.set(url, listeners);
      return {
        readyState: 1,
        onopen: null,
        onerror: null,
        addEventListener(type, l) {
          listeners.set(type, [...(listeners.get(type) ?? []), l]);
        },
        close() {
          if (sources.get(url) === listeners) sources.delete(url);
        },
      };
    },
    open: (url: string) => sources.has(url),
    emit(url: string, type: string, data: unknown = {}) {
      act(() => {
        for (const l of sources.get(url)?.get(type) ?? [])
          l(new MessageEvent(type, { data: JSON.stringify(data) }));
      });
    },
  };
}

function renderScreen(api: ReturnType<typeof fakeApi>, sse = fakeSse(), pollMs = 60_000) {
  render(
    <MemoryRouter>
      <CrawlsPage
        client={api.client}
        sse={{ enabled: true, createSource: (u) => sse.createSource(u) }}
        pollMs={pollMs}
        now={() => Date.parse('2026-11-12T12:01:05.000Z')}
      />
    </MemoryRouter>,
  );
  return sse;
}

const aiCell = (runId: string) =>
  document.querySelector(`[row-id="${runId}"] [data-ai-calls]`) as HTMLElement | null;
const kpi = (label: string) => screen.getByText(label).nextElementSibling as HTMLElement;

describe('W10 Crawls & health', () => {
  it('post-approval runs show AI calls 0; the discovery run shows its proposal calls', async () => {
    renderScreen(fakeApi());
    await waitFor(() => expect(aiCell(DISCOVERY.id)).not.toBeNull());

    for (const r of FIXTURE.filter((r) => r.trigger !== 'CONNECT')) {
      expect(aiCell(r.id)).toHaveAttribute('data-ai-calls', '0');
      expect(aiCell(r.id)).toHaveTextContent(/^0$/);
    }
    expect(aiCell(DISCOVERY.id)).toHaveAttribute('data-ai-calls', '3');
    expect(aiCell(DISCOVERY.id)).toHaveTextContent('3(schema proposal)');

    expect(kpi('AI calls on routine crawls')).toHaveTextContent(/^0$/);
    expect(kpi('AI calls on discovery')).toHaveTextContent(/^3$/);
    expect(screen.getByText(/Routine crawls use plain code: no AI calls\./)).toBeInTheDocument();
  });

  it('AI-call KPIs come from the API totals, not the 20 listed runs (discovery past the first page)', async () => {
    // 25 runs on the site; the API lists the newest 20, none of them the discovery run.
    const listed = Array.from({ length: 20 }, (_, i) =>
      run({
        id: `run-${i}`,
        trigger: i % 2 ? 'SCHEDULE' : 'PING',
        status: 'SUCCEEDED',
        finishedAt: '2026-11-12T12:01:00.000Z',
      }),
    );
    renderScreen(fakeApi({ runs: listed, aiCalls: { discovery: 3, routine: 0 } }));
    await waitFor(() => expect(aiCell('run-19')).not.toBeNull());
    expect(aiCell(DISCOVERY.id)).toBeNull();
    expect(kpi('AI calls on discovery')).toHaveTextContent(/^3$/);
    expect(kpi('AI calls on routine crawls')).toHaveTextContent(/^0$/);
  });

  it('a routine AI call anywhere on the site shows in the KPI', async () => {
    renderScreen(fakeApi({ aiCalls: { discovery: 3, routine: 2 } }));
    await waitFor(() => expect(kpi('AI calls on routine crawls')).toHaveTextContent(/^2$/));
  });

  it('no discovery run yet: the discovery KPI reads —', async () => {
    renderScreen(fakeApi({ runs: [] }));
    await screen.findByText(/No crawls yet\./);
    expect(kpi('AI calls on discovery')).toHaveTextContent(/^—$/);
    expect(kpi('AI calls on routine crawls')).toHaveTextContent(/^0$/);
  });

  it('shows triggers, page and record counters and durations', async () => {
    renderScreen(fakeApi());
    const row = await waitFor(() => {
      const el = document.querySelector('[row-id="00000000-0000-4000-8000-0000000000c4"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    const cell = (col: string) => row.querySelector(`[col-id="${col}"]`);
    expect(cell('trigger')).toHaveTextContent('Demo mutate');
    expect(cell('status')).toHaveTextContent('Done');
    expect(cell('pagesFetched')).toHaveTextContent('12');
    expect(cell('pagesNotModified')).toHaveTextContent('2,457');
    expect(cell('pagesFailed')).toHaveTextContent('0');
    expect(cell('recordsAdded')).toHaveTextContent('+1');
    expect(cell('recordsUpdated')).toHaveTextContent('9');
    expect(cell('recordsRemoved')).toHaveTextContent('−2');
    expect(cell('duration')).toHaveTextContent('1 min 12 s');
  });

  it('running: progress follows the run stream, and done re-reads the run', async () => {
    const api = fakeApi({ runs: [run({ pagesFetched: 100 }), ...structuredClone(FIXTURE)] });
    const sse = renderScreen(api);
    const bar = await screen.findByRole('progressbar', { name: 'Pages read' });
    expect(bar).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByRole('button', { name: 'Crawling…' })).toBeDisabled();
    await waitFor(() => expect(sse.open(runEvents('run-new'))).toBe(true));

    const frame = {
      crawlRunId: 'run-new',
      status: 'RUNNING',
      pagesTotal: 2469,
      pagesFetched: 1000,
      pagesNotModified: 200,
      pagesFailed: 3,
    };
    sse.emit(runEvents('run-new'), 'progress', frame);
    expect(bar).toHaveAttribute('aria-valuenow', '1203');
    expect(screen.getByText('1,203 of 2,469 pages')).toBeInTheDocument();

    // An older frame never moves the counters back.
    sse.emit(runEvents('run-new'), 'progress', { ...frame, pagesFetched: 500 });
    expect(bar).toHaveAttribute('aria-valuenow', '1203');

    // Done: the run row (records, AI calls, finish time) comes from a re-read.
    api.state.runs[0] = run({
      status: 'SUCCEEDED',
      pagesFetched: 2266,
      pagesNotModified: 200,
      pagesFailed: 3,
      recordsUpdated: 7,
      finishedAt: '2026-11-12T12:01:00.000Z',
    });
    const before = api.calls('GET', RUNS_URL).length;
    sse.emit(runEvents('run-new'), 'done', { ...frame, status: 'SUCCEEDED', pagesFetched: 2266 });
    await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull());
    expect(api.calls('GET', RUNS_URL).length).toBeGreaterThan(before);
    await waitFor(() =>
      expect(
        document.querySelector('[row-id="run-new"] [col-id="recordsUpdated"]'),
      ).toHaveTextContent('7'),
    );
    expect(aiCell('run-new')).toHaveAttribute('data-ai-calls', '0');
    expect(screen.getByRole('button', { name: 'Crawl now' })).toBeEnabled();
  });

  it('paused: the W15 copy, records still on sale, and "Resume and crawl now"', async () => {
    const api = fakeApi({
      sites: [{ ...SITE, status: 'PAUSED' }],
      runs: [
        run({
          status: 'PAUSED',
          pagesFetched: 40,
          error: 'Origin answered 429 3 times in a row; crawl paused',
          finishedAt: '2026-11-12T12:00:30.000Z',
        }),
        ...structuredClone(FIXTURE),
      ],
    });
    renderScreen(api);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Your site returned 429. We paused and will retry after 10 min.',
    );
    expect(alert).toHaveTextContent('Your records are still on sale');

    await userEvent.click(screen.getByRole('button', { name: 'Resume and crawl now' }));
    expect(api.calls('POST', `/api/sites/${SITE_ID}/crawl`)).toHaveLength(1);
    await waitFor(() => expect(screen.queryByText(/We paused/)).toBeNull());
    expect(await screen.findByRole('progressbar')).toBeInTheDocument();
  });

  it('paused by a 503 says 503', () => {
    expect(pausedMessage({ error: 'Origin answered 503 3 times in a row; crawl paused' })).toBe(
      'Your site returned 503. We paused and will retry after 10 min.',
    );
    expect(pausedMessage(undefined)).toBe(
      'Your site returned 429. We paused and will retry after 10 min.',
    );
  });

  it('"Crawl now": a double click sends one request with an Idempotency-Key and the run goes live', async () => {
    const api = fakeApi();
    const sse = renderScreen(api);
    const button = await screen.findByRole('button', { name: 'Crawl now' });
    await waitFor(() => expect(button).toBeEnabled());

    let release!: () => void;
    api.state.crawlHeld = new Promise((r) => (release = r));
    await userEvent.dblClick(button);
    release();

    expect(await screen.findByRole('progressbar')).toBeInTheDocument();
    const posts = api.calls('POST', `/api/sites/${SITE_ID}/crawl`);
    expect(posts).toHaveLength(1);
    const init = posts[0]![1];
    expect(JSON.parse(init.body as string)).toEqual({ trigger: 'MANUAL' });
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toMatch(/^w10-crawl-/);
    expect(screen.getByText('Crawl queued')).toBeInTheDocument();
    await waitFor(() => expect(sse.open(runEvents('run-new'))).toBe(true));
  });

  it('"Crawl now" while another crawl runs: follows the live run (409 CRAWL_IN_PROGRESS)', async () => {
    const api = fakeApi({
      crawl: () => {
        api.state.runs = [run({ id: 'run-other', trigger: 'SCHEDULE' }), ...api.state.runs];
        return json(409, {
          error: {
            code: 'CRAWL_IN_PROGRESS',
            message: 'A crawl of this site is already running.',
            details: { crawlRunId: 'run-other' },
          },
        });
      },
    });
    renderScreen(api);
    const button = await screen.findByRole('button', { name: 'Crawl now' });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'A crawl of this site is already running; following it.',
    );
    expect(await screen.findByRole('progressbar')).toBeInTheDocument();
    expect(document.querySelector('[row-id="run-other"] [col-id="trigger"]')).toHaveTextContent(
      'Scheduled',
    );
  });

  it('"Crawl now" on an unverified site links to verification', async () => {
    const api = fakeApi({
      runs: [],
      crawl: () =>
        json(403, {
          error: { code: 'SITE_NOT_VERIFIED', message: 'Verify the site before crawling it.' },
        }),
    });
    renderScreen(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Crawl now' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Verify the site before crawling it.');
    expect(within(alert).getByRole('link', { name: 'Verify the site' })).toHaveAttribute(
      'href',
      `/app/install?site=${SITE_ID}`,
    );
  });

  it('failed: the last run’s error is shown', async () => {
    renderScreen(
      fakeApi({
        runs: [
          run({
            status: 'FAILED',
            error: 'Sitemap fetch failed: HTTP 500',
            finishedAt: '2026-11-12T12:00:02.000Z',
          }),
          ...structuredClone(FIXTURE),
        ],
      }),
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The last crawl failed.');
    expect(alert).toHaveTextContent('Sitemap fetch failed: HTTP 500');
  });

  it('opens a run’s details', async () => {
    renderScreen(fakeApi());
    await userEvent.click(await screen.findByRole('button', { name: `Open run ${DISCOVERY.id}` }));
    const details = screen.getByRole('region', { name: 'Run details' });
    expect(within(details).getByText('AI calls').nextSibling).toHaveTextContent(
      '3 (schema proposal)',
    );
    expect(within(details).getByText('Trigger').nextSibling).toHaveTextContent('Discovery');
    expect(within(details).getByText('Duration').nextSibling).toHaveTextContent('4 min');
    await userEvent.click(within(details).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'Run details' })).toBeNull();
  });

  it('a publisher crawl.progress event re-reads the runs (a crawl started elsewhere)', async () => {
    const api = fakeApi();
    const sse = renderScreen(api);
    await waitFor(() => expect(aiCell(DISCOVERY.id)).not.toBeNull());
    await waitFor(() => expect(sse.open(EVENTS_URL)).toBe(true));
    api.state.runs = [run({ id: 'run-sched', trigger: 'SCHEDULE' }), ...api.state.runs];
    sse.emit(EVENTS_URL, 'crawl.progress', { ids: ['run-sched'] });
    expect(await screen.findByRole('progressbar')).toBeInTheDocument();
  });

  it('polls while the run stream is not open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const api = fakeApi({ runs: [run({ pagesFetched: 10 })] });
      // A stream that never delivers: readyState CONNECTING, no events.
      render(
        <MemoryRouter>
          <CrawlsPage
            client={api.client}
            sse={{ enabled: false }}
            pollMs={1_000}
            now={() => Date.parse('2026-11-12T12:01:05.000Z')}
          />
        </MemoryRouter>,
      );
      await screen.findByRole('progressbar');
      const before = api.calls('GET', RUNS_URL).length;
      api.state.runs = [run({ pagesFetched: 900 })];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_100);
      });
      await waitFor(() =>
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '900'),
      );
      expect(api.calls('GET', RUNS_URL).length).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('no runs yet: empty state with one action', async () => {
    renderScreen(fakeApi({ runs: [] }));
    expect(await screen.findByText(/No crawls yet\./)).toBeInTheDocument();
  });

  it('no site: connect your site', async () => {
    renderScreen(fakeApi({ sites: [] }));
    expect(await screen.findByRole('link', { name: 'Connect your site' })).toHaveAttribute(
      'href',
      '/app/connect',
    );
  });

  it('error: inline banner with retry', async () => {
    const api = fakeApi();
    api.fetch.mockImplementation(async (url, init) =>
      url === RUNS_URL && api.calls('GET', RUNS_URL).length === 1
        ? json(500, { error: { code: 'INTERNAL', message: 'Database is down.' } })
        : url === '/api/sites'
          ? json(200, { sites: api.state.sites })
          : url === RUNS_URL
            ? json(200, { runs: api.state.runs, aiCalls: totals(api.state.runs) })
            : json(404, { error: { code: 'NOT_FOUND', message: String(init.method) } }),
    );
    renderScreen(api);
    expect(await screen.findByRole('alert')).toHaveTextContent('Database is down.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(aiCell(DISCOVERY.id)).not.toBeNull());
  });
});

describe('W10 model', () => {
  it('formats durations', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(45_000)).toBe('45 s');
    expect(formatDuration(192_000)).toBe('3 min 12 s');
    expect(formatDuration(240_000)).toBe('4 min');
    expect(formatDuration(3_840_000)).toBe('1 h 4 min');
  });

  it('applyFrame ignores another run and never goes backwards while live', () => {
    const r = run({ pagesFetched: 10 });
    const f = {
      crawlRunId: r.id,
      status: 'RUNNING' as const,
      pagesTotal: r.pagesTotal,
      pagesFetched: 5,
      pagesNotModified: 0,
      pagesFailed: 0,
    };
    expect(applyFrame(r, f)).toBe(r);
    expect(applyFrame(r, { ...f, crawlRunId: 'other', pagesFetched: 99 })).toBe(r);
    expect(applyFrame(r, { ...f, pagesFetched: 20 }).pagesFetched).toBe(20);
    expect(applyFrame(r, { ...f, status: 'SUCCEEDED' }).status).toBe('SUCCEEDED');
  });
});
