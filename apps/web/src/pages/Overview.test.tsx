// @vitest-environment-options { "url": "https://spigot.example/app" }
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient, type FetchLike } from '../api/client';
import type { EventSourceFactory, EventSourceLike } from '../api/sse';
import { pivotSeries } from '../charts/HitsArea';
import activityFixture from '../fixtures/api/publishers/me/activity.json';
import botsFixture from '../fixtures/api/sites/00000000-0000-4000-8000-0000000000a1/bots.json';
import sitesFixture from '../fixtures/api/sites.json';
import { diffRows } from '../grids/BotsGrid';
import { isValidAgKey } from '../grid';
import { mergeActivity } from '../overview/ActivityFeed';
import type { ActivityEvent, BotRow, BotsReport } from '../overview/types';
import OverviewPage from './Overview';

const SITE = sitesFixture.sites[0]!;
const BOTS = botsFixture as BotsReport;
const NOW = Date.parse('2026-11-12T09:00:00.000Z');
const clone = <T,>(x: T): T => structuredClone(x);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** The report with SIM rows dropped, as the API answers `includeSim=false`. */
function withoutSim(r: BotsReport): BotsReport {
  const byBot = r.byBot.filter((b) => !b.isSimulated);
  const botHits = byBot.reduce((a, b) => a + b.hits, 0);
  return {
    ...r,
    includeSim: false,
    byBot,
    totals: { ...r.totals, botHits, ratio: '1 bot per 248 human visits' },
    earnedThisWeek: { micros: 32_000_000, simMicros: 0, simShare: 0 },
  };
}

interface Server {
  sites: unknown;
  bots: (url: string) => BotsReport;
  activity: () => { events: ActivityEvent[] };
}

function server(over: Partial<Server> = {}) {
  const s: Server = {
    sites: sitesFixture,
    bots: (url) => (url.includes('includeSim=false') ? withoutSim(clone(BOTS)) : clone(BOTS)),
    activity: () => clone(activityFixture) as { events: ActivityEvent[] },
    ...over,
  };
  const fetch = vi.fn<FetchLike>(async (url) => {
    if (url === '/api/sites') return json(200, s.sites);
    if (url.startsWith(`/api/sites/${SITE.id}/bots`)) return json(200, s.bots(url));
    if (url.startsWith('/api/publishers/me/activity')) return json(200, s.activity());
    return json(404, { error: { code: 'NOT_FOUND', message: 'Not found.' } });
  });
  return { s, fetch };
}

/** A controllable EventSource. */
class FakeSource implements EventSourceLike {
  readyState = 1;
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  listeners = new Map<string, ((ev: MessageEvent) => void)[]>();
  addEventListener(type: string, l: (ev: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
  }
  close() {
    this.readyState = 2;
  }
  emit(type: string, ids: string[]) {
    const ev = new MessageEvent(type, {
      data: JSON.stringify({ type, publisherId: 'p', ids, at: new Date(NOW).toISOString() }),
    });
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
}

function setup(fetch: FetchLike, path = '/app') {
  const sources: FakeSource[] = [];
  const factory: EventSourceFactory = () => {
    const src = new FakeSource();
    sources.push(src);
    queueMicrotask(() => src.onopen?.(new Event('open')));
    return src;
  };
  const client = createApiClient({ fetch, fixtures: false });
  const router = createMemoryRouter(
    [
      {
        path: '/app',
        element: (
          <OverviewPage client={client} eventSource={factory} now={() => NOW} refetchDelayMs={10} />
        ),
      },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return { router, sources, source: () => sources.at(-1)! };
}

const kpi = (label: string) => screen.getByText(label).closest('div')!;
/** The rendered row with this id that holds the data cells (AG also renders pinned containers). */
const gridRow = (id: string) =>
  [...document.querySelectorAll<HTMLElement>(`.ag-row[row-id="${CSS.escape(id)}"]`)].find((r) =>
    r.querySelector('[col-id="hits"]'),
  ) ?? null;
const leafRowIds = () =>
  [
    ...new Set(
      [...document.querySelectorAll('.ag-row[row-id]')].map((r) => r.getAttribute('row-id')!),
    ),
  ].filter((id) => !id.startsWith('row-group'));
const botsCalls = (fetch: ReturnType<typeof vi.fn>) =>
  fetch.mock.calls.map(([u]) => u as string).filter((u) => u.includes('/bots'));

/** Records every grid row that flashes, so checks don't depend on catching AG's 1.5 s fade. */
function watchFlashes() {
  const ids = new Set<string>();
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      const el = r.target as HTMLElement;
      if (el.classList?.contains('ag-cell-data-changed')) {
        const id = el.closest('.ag-row')?.getAttribute('row-id');
        if (id) ids.add(id);
      }
    }
  });
  observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
  return { ids, stop: () => observer.disconnect() };
}

describe('W04 Overview (SP-027b)', () => {
  it('shows the KPI row, the chart, the grouped grid and the activity feed', async () => {
    const { fetch } = server();
    setup(fetch);
    expect(await screen.findByText('18,480')).toBeInTheDocument();
    expect(kpi('Bots vs people')).toHaveTextContent('1 bot per 31 human visits');
    expect(kpi('Bots sent to your API')).toHaveTextContent('16,152');
    expect(kpi('Bandwidth avoided (est.)')).toHaveTextContent('1.6 GB');
    const earned = screen.getByTestId('earned-this-week');
    expect(earned).toHaveTextContent('$412.00');
    expect(earned).toHaveAttribute('title', 'incl. $380.00 SIM');
    expect(
      screen.getByRole('figure', { name: 'Bot hits by category over time' }),
    ).toBeInTheDocument();

    // Grid: grouped by category (badge in the group row), GPTBot with its SIM chip.
    // AG Grid mounts React cell renderers (chip, sparkline, badge) a frame after the row itself.
    await waitFor(() => {
      const gpt = gridRow('AI_TRAINING|GPTBot|QUOTE_402|sim');
      expect(gpt).not.toBeNull();
      expect(gpt).toHaveTextContent('6,120');
      expect(gpt).toHaveTextContent('Sent to API');
      expect(gpt).toHaveTextContent('SIM');
      expect(
        within(gpt!).getByRole('img', { name: /GPTBot: .* hits in the last 24 h/ }),
      ).toBeInTheDocument();
    });
    await waitFor(() =>
      expect(document.querySelector('[data-category="AI_TRAINING"]')).toHaveTextContent(
        'AI training',
      ),
    );

    const feed = screen.getByRole('region', { name: 'Activity' });
    expect(
      await within(feed).findByText(/Acme Agents: \$0.0555 charged for 37 Listing records/),
    ).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  it('every SIM row shows a chip, and real rows do not', async () => {
    const { fetch } = server();
    setup(fetch);
    await waitFor(() => expect(gridRow('SEARCH|Googlebot|PASS|real')).not.toBeNull());
    // The chip is a React cell renderer, mounted after the row: wait until every SIM row has it.
    await waitFor(() => {
      const simIds = leafRowIds().filter((id) => id.endsWith('|sim'));
      expect(simIds.length).toBeGreaterThan(0);
      for (const id of simIds) expect(within(gridRow(id)!).queryByText('SIM'), id).not.toBeNull();
    });
    let sim = 0;
    for (const id of leafRowIds()) {
      const row = gridRow(id)!;
      const chip = within(row).queryByText('SIM');
      if (id.endsWith('|sim')) {
        expect(chip, id).not.toBeNull();
        sim += 1;
      } else expect(chip, id).toBeNull();
    }
    expect(sim).toBeGreaterThan(0);
  });

  it('toggling SIM off refetches with includeSim=false and updates the grid and KPIs', async () => {
    const { fetch } = server();
    setup(fetch);
    await screen.findByText('18,480');
    await waitFor(() => expect(gridRow('AI_TRAINING|GPTBot|QUOTE_402|sim')).not.toBeNull());

    await userEvent.click(screen.getByRole('checkbox', { name: 'Include simulated' }));
    await waitFor(() => expect(botsCalls(fetch).at(-1)).toContain('includeSim=false'));
    await waitFor(() =>
      expect(kpi('Bots vs people')).toHaveTextContent('1 bot per 248 human visits'),
    );
    expect(screen.getByTestId('earned-this-week')).not.toHaveAttribute('title');
    await waitFor(() => expect(gridRow('AI_TRAINING|GPTBot|QUOTE_402|sim')).toBeNull());
    expect(gridRow('SEARCH|Googlebot|PASS|real')).not.toBeNull();
    expect(leafRowIds().some((id) => id.endsWith('|sim'))).toBe(false);
    for (const id of leafRowIds()) expect(within(gridRow(id)!).queryByText('SIM')).toBeNull();
  });

  it('SSE `hits` for this site refetches, updates the row in place and flashes it', async () => {
    const { s, fetch } = server();
    const { source } = setup(fetch);
    await waitFor(() => expect(gridRow('AI_TRAINING|GPTBot|QUOTE_402|sim')).not.toBeNull());
    const before = botsCalls(fetch).length;

    // Another site's hits: no refetch.
    act(() => source().emit('hits', ['some-other-site']));
    await new Promise((r) => setTimeout(r, 40));
    expect(botsCalls(fetch)).toHaveLength(before);

    s.bots = () => {
      const r = clone(BOTS);
      const gpt = r.byBot.find((b) => b.botName === 'GPTBot')!;
      gpt.hits += 50;
      r.totals.botHits += 50;
      return r;
    };
    const watch = watchFlashes();
    const flashed = watch.ids;

    act(() => {
      source().emit('hits', [SITE.id]);
      source().emit('hits', [SITE.id]); // a burst is one refetch
    });
    const slow = { timeout: 5_000 };
    await waitFor(
      () => expect(gridRow('AI_TRAINING|GPTBot|QUOTE_402|sim')).toHaveTextContent('6,170'),
      slow,
    );
    expect(botsCalls(fetch)).toHaveLength(before + 1);
    expect(await screen.findByText('18,530', {}, slow)).toBeInTheDocument();
    await waitFor(() => expect(flashed).toContain('AI_TRAINING|GPTBot|QUOTE_402|sim'), slow);
    watch.stop();
    // Unchanged rows don't flash.
    expect(flashed).not.toContain('SEARCH|Googlebot|PASS|real');
  });

  it('a filter change after a live update does not flash the rows it brings back', async () => {
    const { s, fetch } = server();
    const { source } = setup(fetch);
    await waitFor(() => expect(gridRow('SEARCH|Googlebot|PASS|real')).not.toBeNull());
    const flashed = watchFlashes();

    s.bots = () => {
      const r = clone(BOTS);
      r.byBot.find((b) => b.botName === 'GPTBot')!.hits += 50;
      return r;
    };
    act(() => source().emit('hits', [SITE.id]));
    await waitFor(() => expect(flashed.ids).toContain('AI_TRAINING|GPTBot|QUOTE_402|sim'), {
      timeout: 5_000,
    });
    flashed.ids.clear();

    const select = screen.getByRole('combobox', { name: 'Category' });
    await userEvent.selectOptions(select, 'SCRAPER_TOOL');
    await waitFor(() => expect(gridRow('SEARCH|Googlebot|PASS|real')).toBeNull());
    await userEvent.selectOptions(select, 'ALL');
    await waitFor(() => expect(gridRow('SEARCH|Googlebot|PASS|real')).not.toBeNull());
    await new Promise((r) => setTimeout(r, 300));
    flashed.stop();
    expect([...flashed.ids]).toEqual([]);
  });

  it("switching ?site= never shows the previous site's report, and closes the drawer", async () => {
    const OTHER = {
      ...SITE,
      id: '00000000-0000-4000-8000-0000000000b2',
      origin: 'https://other.example',
    };
    let release: (r: Response) => void = () => undefined;
    const { fetch: base } = server({ sites: { sites: [SITE, OTHER] } });
    const fetch = vi.fn<FetchLike>((url, init) =>
      url.startsWith(`/api/sites/${OTHER.id}/bots`)
        ? new Promise<Response>((r) => (release = r))
        : base(url, init),
    );
    const { router } = setup(fetch);
    await waitFor(() => expect(gridRow('AI_TRAINING|GPTBot|QUOTE_402|sim')).not.toBeNull());
    await userEvent.click(within(gridRow('AI_TRAINING|GPTBot|QUOTE_402|sim')!).getByText('6,120'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    await act(() => router.navigate(`/app?site=${OTHER.id}`));
    expect(await screen.findByText("Who's crawling other.example")).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('18,480')).toBeNull();
    expect(gridRow('AI_TRAINING|GPTBot|QUOTE_402|sim')).toBeNull();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();

    const other = clone(BOTS);
    other.byBot = other.byBot.filter((b) => b.botName === 'Googlebot');
    other.totals.botHits = 1_840;
    await act(async () => release(json(200, other)));
    expect(await screen.findByText('1,840')).toBeInTheDocument();
  });

  it('SSE `call.charged` prepends the new activity event and moves Earned this week', async () => {
    const { s, fetch } = server();
    const { source } = setup(fetch);
    const feed = await screen.findByRole('region', { name: 'Activity' });
    await within(feed).findByText(/Acme Agents: \$0.0555/);

    s.activity = () => {
      const a = clone(activityFixture) as { events: ActivityEvent[] };
      a.events.unshift({
        id: '1211',
        at: new Date(NOW).toISOString(),
        action: 'CALL_CHARGED',
        entity: 'api_call',
        entityId: 'c-new',
        isSimulated: false,
        line: 'Claude Desktop: $0.0555 charged for 37 Listing records',
      });
      return a;
    };
    s.bots = () => {
      const r = clone(BOTS);
      r.earnedThisWeek.micros += 44_400;
      return r;
    };
    act(() => source().emit('call.charged', ['c-new']));
    const item = (await within(feed).findByText(/Claude Desktop: \$0.0555/)).closest('li')!;
    expect(item).toHaveAttribute('data-fresh', 'true');
    expect(within(feed).getAllByRole('listitem')[0]).toBe(item);
    await waitFor(() =>
      expect(screen.getByTestId('earned-this-week')).toHaveTextContent('$412.04'),
    );
  });

  it('category filter narrows the grid', async () => {
    const { fetch } = server();
    setup(fetch);
    await waitFor(() => expect(gridRow('SEARCH|Googlebot|PASS|real')).not.toBeNull());
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Category' }),
      'SCRAPER_TOOL',
    );
    await waitFor(() => expect(gridRow('SEARCH|Googlebot|PASS|real')).toBeNull());
    expect(gridRow('SCRAPER_TOOL|python-requests|QUOTE_402|sim')).not.toBeNull();
  });

  it('a row opens the detail drawer; Escape closes it', async () => {
    const { fetch } = server();
    setup(fetch);
    await waitFor(() => expect(gridRow('AI_TRAINING|GPTBot|QUOTE_402|sim')).not.toBeNull());
    await userEvent.click(within(gridRow('AI_TRAINING|GPTBot|QUOTE_402|sim')!).getByText('6,120'));
    const drawer = await screen.findByRole('dialog', { name: 'GPTBot details' });
    expect(drawer).toHaveTextContent('Send to API'); // site policy AI_TRAINING: QUOTE
    expect(drawer).toHaveTextContent('Sent to API');
    expect(drawer).toHaveTextContent('never stores paths or IP addresses');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('no site: the empty state points to W03', async () => {
    const { fetch } = server({ sites: { sites: [] } });
    setup(fetch);
    expect(
      await screen.findByText("Install the gate to see who's crawling you."),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Install the gate' })).toHaveAttribute(
      'href',
      '/app/install',
    );
  });

  it('gate never seen and no hits: empty state for this site, plus the unverified banner', async () => {
    const empty = clone(BOTS);
    empty.byBot = [];
    empty.series = [];
    Object.assign(empty.totals, {
      botHits: 0,
      humanHits: 0,
      quoted402: 0,
      ratio: 'No bot visits yet',
    });
    const { fetch } = server({
      sites: { sites: [{ ...SITE, status: 'PENDING_VERIFY', lastGateSeenAt: null }] },
      bots: () => clone(empty),
    });
    setup(fetch);
    expect(await screen.findByRole('link', { name: 'Install the gate' })).toHaveAttribute(
      'href',
      `/app/install?site=${SITE.id}`,
    );
    expect(screen.getByRole('status')).toHaveTextContent("This site isn't verified yet");
  });

  it('gate installed but no bots yet', async () => {
    const quiet = clone(BOTS);
    quiet.byBot = [];
    Object.assign(quiet.totals, { botHits: 0, quoted402: 0, ratio: 'No bot visits yet' });
    const { fetch } = server({ bots: () => clone(quiet) });
    setup(fetch);
    expect(await screen.findByText(/The gate is installed. No bots yet/)).toBeInTheDocument();
    expect(kpi('Bots vs people')).toHaveTextContent('No bot visits yet');
  });

  it('a failed load shows an error banner with retry', async () => {
    let fail = true;
    const { fetch: ok } = server();
    const fetch = vi.fn<FetchLike>(async (url, init) =>
      fail
        ? json(500, {
            error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side.' },
          })
        : ok(url, init),
    );
    setup(fetch);
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our side.');
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('18,480')).toBeInTheDocument();
  });

  const key = process.env.VITE_AG_GRID_LICENSE_KEY || process.env.AG_GRID_LICENSE_KEY || '';
  it.runIf(isValidAgKey(key))('shows no AG licence watermark', async () => {
    const { fetch } = server();
    setup(fetch);
    await waitFor(() => expect(gridRow('AI_TRAINING|GPTBot|QUOTE_402|sim')).not.toBeNull());
    expect(document.querySelector('.ag-watermark:not(.ag-hidden)')).toBeNull();
  });
});

describe('W04 helpers', () => {
  const row = (o: Partial<BotRow>): BotRow => ({
    botName: 'GPTBot',
    category: 'AI_TRAINING',
    hits: 1,
    decision: 'QUOTE_402',
    lastSeen: '2026-11-12T08:00:00.000Z',
    bytes: 0,
    wouldHavePaid: 0,
    isSimulated: false,
    hits24h: [0, 1],
    ...o,
  });

  it('diffRows: adds, updates only changed rows, removes', () => {
    const a = row({});
    const b = row({ botName: 'ClaudeBot' });
    const c = row({ botName: 'CCBot' });
    const d = diffRows([a, b, c], [row({ hits: 2 }), b, row({ botName: 'Bytespider' })]);
    expect(d.add.map((r) => r.botName)).toEqual(['Bytespider']);
    expect(d.update.map((r) => [r.botName, r.hits])).toEqual([['GPTBot', 2]]);
    expect(d.remove.map((r) => r.botName)).toEqual(['CCBot']);
    // SIM and real rows of one bot are different rows.
    expect(diffRows([a], [row({ isSimulated: true })]).add).toHaveLength(1);
  });

  it('mergeActivity: puts new events on top, dedupes, keeps the limit', () => {
    const ev = (id: string, at: string) =>
      ({
        id,
        at,
        action: 'CALL_CHARGED',
        entity: null,
        entityId: null,
        isSimulated: false,
        line: id,
      }) as ActivityEvent;
    const shown = [ev('2', '2026-11-12T08:00:00Z'), ev('1', '2026-11-12T07:00:00Z')];
    const fresh = [ev('3', '2026-11-12T09:00:00Z'), ev('2', '2026-11-12T08:00:00Z')];
    const m = mergeActivity(shown, fresh, 2);
    expect(m.events.map((e) => e.id)).toEqual(['3', '2']);
    expect(m.added).toEqual(['3']);
  });

  it('pivotSeries: one zero-filled point per bucket per bot category, no HUMAN', () => {
    const pts = pivotSeries({
      range: {
        from: '2026-11-12T00:00:00.000Z',
        to: '2026-11-12T03:00:00.000Z',
        bucketSize: 'hour',
      },
      series: [
        { bucket: '2026-11-12T01:00:00.000Z', category: 'AI_TRAINING', hits: 5 },
        { bucket: '2026-11-12T01:00:00.000Z', category: 'HUMAN', hits: 500 },
      ],
    });
    expect(pts).toHaveLength(3);
    expect(pts[1]).toMatchObject({ AI_TRAINING: 5, SEARCH: 0 });
    expect(pts[1]).not.toHaveProperty('HUMAN');
    expect(pts[0]!.AI_TRAINING).toBe(0);
    // Filtered to one category.
    expect(
      Object.keys(pivotSeries({ range: BOTS.range, series: BOTS.series }, ['SCRAPER_TOOL'])[0]!),
    ).toEqual(['time', 'SCRAPER_TOOL']);
  });
});
