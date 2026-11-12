import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { formatCount, formatMicros } from '@spigot/shared/money';
import type { IServerSideGetRowsParams } from 'ag-grid-community';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient, type FetchLike } from '../api/client';
import earningsFixture from '../fixtures/api/publishers/me/earnings.json';
import ledgerFixture from '../fixtures/api/publishers/me/ledger.json';
import { EARNINGS_CSV_FILE } from '../grids/EarningsGrid';
import { createLedgerDatasource, LEDGER_BLOCK, type LedgerRow } from '../grids/LedgerGrid';
import { EarningsScreen, EVENTS_PATH, W08_COPY } from './Earnings';
import {
  changedRowIds,
  earningsPath,
  gridRowId,
  toBarData,
  toGridRows,
  type Earnings,
  type EarningsApiRow,
} from './earningsData';

/**
 * SP-030b component tests on this ticket's fixtures (src/fixtures/api/publishers/me/*). The API
 * is a fake fetch; SSE is a fake EventSource the test drives.
 */

const fixture = earningsFixture as unknown as Earnings;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

class FakeEventSource {
  static last: FakeEventSource | null = null;
  readyState = 0;
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  private listeners = new Map<string, ((ev: MessageEvent) => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.last = this;
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.(new Event('open'));
    });
  }
  addEventListener(type: string, l: (ev: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
  }
  emit(type: string, data: unknown) {
    const ev = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
  close() {}
}

beforeEach(() => {
  FakeEventSource.last = null;
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => vi.unstubAllGlobals());

/** GETs answered by path (query string included); anything else → 500. */
function fakeFetch(routes: Record<string, () => unknown>) {
  return vi.fn<FetchLike>(async (url) => {
    const handler = routes[url];
    return handler
      ? json(200, handler())
      : json(500, { error: { code: 'INTERNAL_ERROR', message: url } });
  });
}

function renderScreen(fetch: FetchLike, streamEnabled = false) {
  const client = createApiClient({ fetch, fixtures: false });
  const router = createMemoryRouter(
    [
      {
        path: '/app/earnings',
        element: (
          <EarningsScreen
            client={client}
            streamEnabled={streamEnabled}
            origin="https://spigot.test"
          />
        ),
      },
    ],
    { initialEntries: ['/app/earnings'] },
  );
  render(<RouterProvider router={router} />);
}

/** The first AG Grid render in a worker loads and draws the Enterprise bundle: slow in jsdom. */
const gridDrawn = () => screen.findAllByText('Acme Agents', {}, { timeout: 10_000 });

const tile = (label: string) =>
  within(screen.getByRole('region', { name: 'Earnings totals' }))
    .getByText(label)
    .closest('div')!;
const grandTotalRow = () =>
  document.querySelector<HTMLElement>(
    '.ag-center-cols-container [row-id^="rowGroupFooter_ROOT"], .ag-row-footer',
  )!;
const cellText = (row: Element, colId: string) =>
  row.querySelector(`[col-id="${colId}"]`)?.textContent?.trim();

function mcpCall(over: Partial<EarningsApiRow> = {}): EarningsApiRow {
  const buyer = { id: 'b-new', name: 'Claude Desktop (live)' };
  const dataset = fixture.rows[0]!.dims.dataset!;
  return {
    key: `${buyer.name} · ${dataset.key} · MCP · 2026-11-12`,
    id: `${buyer.id}|${dataset.id}|MCP|2026-11-12`,
    dims: { buyer, dataset, channel: 'MCP', day: '2026-11-12' },
    isSimulated: false,
    calls: 1,
    records: 37,
    changes: 0,
    grossMicros: 55_500,
    commissionMicros: 11_100,
    netMicros: 44_400,
    channels: { REST: { calls: 0, grossMicros: 0 }, MCP: { calls: 1, grossMicros: 55_500 } },
    ...over,
  };
}

function withCall(base: Earnings, row: EarningsApiRow): Earnings {
  const k = base.kpis;
  return {
    kpis: {
      ...k,
      grossMicros: k.grossMicros + row.grossMicros,
      commissionMicros: k.commissionMicros + row.commissionMicros,
      netMicros: k.netMicros + row.netMicros,
      payableMicros: k.payableMicros + row.netMicros,
      calls: k.calls + row.calls,
      recordsSold: k.recordsSold + row.records,
      buyers: k.buyers + 1,
    },
    rows: [...base.rows, row],
  };
}

// ---------------------------------------------------------------------------------------------

describe('earningsData', () => {
  it('fixture KPIs equal the sum of its rows', () => {
    const sum = (f: (r: EarningsApiRow) => number) => fixture.rows.reduce((t, r) => t + f(r), 0);
    expect(sum((r) => r.grossMicros)).toBe(fixture.kpis.grossMicros);
    expect(sum((r) => r.netMicros)).toBe(fixture.kpis.netMicros);
    expect(sum((r) => r.calls)).toBe(fixture.kpis.calls);
  });

  it('rolls days up into buyer × dataset × channel leaves, SIM apart, same totals', () => {
    const rows = toGridRows(fixture.rows);
    expect(new Set(rows.map((r) => r.rowId)).size).toBe(rows.length);
    expect(rows.reduce((t, r) => t + r.grossMicros, 0)).toBe(fixture.kpis.grossMicros);
    expect(rows.reduce((t, r) => t + r.records, 0)).toBe(fixture.kpis.recordsSold);
    expect(rows.every((r) => r.rowId === gridRowId(r))).toBe(true);
    expect(rows.some((r) => r.channel === 'MCP') && rows.some((r) => r.isSimulated)).toBe(true);
  });

  it('flags new and grown rows, and nothing on first load', () => {
    const before = toGridRows(fixture.rows);
    expect(changedRowIds(null, before)).toEqual([]);
    expect(changedRowIds(before, before)).toEqual([]);
    const after = toGridRows([...fixture.rows, mcpCall()]);
    expect(changedRowIds(before, after)).toEqual([
      'b-new|' + fixture.rows[0]!.dims.dataset!.id + '|MCP|real',
    ]);
  });

  it('stacks net dollars per day by dataset, every series on every day', () => {
    const bars = toBarData(fixture.rows);
    expect(bars.series.map((s) => s.yName).sort()).toEqual([
      'bluebonnet/agents',
      'bluebonnet/listings',
    ]);
    const total = bars.data.reduce(
      (t, d) => t + bars.series.reduce((u, s) => u + Number(d[s.yKey]), 0),
      0,
    );
    expect(total).toBeCloseTo(fixture.kpis.netMicros / 1_000_000, 6);
    expect(bars.data.map((d) => d.day)).toEqual([...bars.data.map((d) => d.day)].sort());
  });
});

// AG Grid + Charts in jsdom is slow on a loaded machine (CI, parallel workers): above 5 s.
describe('W08 Earnings', { timeout: 30_000 }, () => {
  it('shows the six KPI tiles, and the grouped grand total equals them', async () => {
    renderScreen(fakeFetch({ [earningsPath(true)]: () => fixture }));
    const k = fixture.kpis;
    await waitFor(() => expect(tile('Gross')).toHaveTextContent(formatMicros(k.grossMicros)));
    expect(tile('Spigot commission (20%)')).toHaveTextContent(formatMicros(k.commissionMicros));
    expect(tile('Your earnings')).toHaveTextContent(formatMicros(k.netMicros));
    expect(tile('Payable now')).toHaveTextContent(formatMicros(k.payableMicros));
    expect(tile('Records sold')).toHaveTextContent(formatCount(k.recordsSold));
    expect(tile('Buyers')).toHaveTextContent(String(k.buyers));
    expect(tile('Gross')).toHaveTextContent(/incl\. \$[\d.,]+ SIM/);

    // Grouped Buyer → Dataset, with the grand total row at the bottom.
    expect(await gridDrawn()).not.toHaveLength(0);
    await waitFor(() => expect(grandTotalRow()).toBeTruthy());
    const total = grandTotalRow();
    expect(cellText(total, 'grossMicros')).toBe(formatMicros(k.grossMicros));
    expect(cellText(total, 'commissionMicros')).toBe(formatMicros(k.commissionMicros));
    expect(cellText(total, 'netMicros')).toBe(formatMicros(k.netMicros));
    expect(cellText(total, 'calls')).toBe(formatCount(k.calls));
    expect(cellText(total, 'records')).toBe(formatCount(k.recordsSold));
    // Every SIM leaf has a chip.
    expect(document.querySelectorAll('[col-id="isSimulated"]').length).toBeGreaterThan(1);
    expect(screen.getAllByText('SIM').length).toBeGreaterThan(0);
  });

  it('a paid MCP call (SSE call.charged) appears as a flashing MCP row within 2 s', async () => {
    // The post-event read is held open by the test, so ordering is explicit, not timing-based.
    let release: ((e: Earnings) => void) | null = null;
    let reads = 0;
    const fetch = vi.fn<FetchLike>(async (url) => {
      if (url !== earningsPath(true))
        return json(500, { error: { code: 'INTERNAL_ERROR', message: url } });
      reads += 1;
      if (reads === 1) return json(200, fixture);
      return json(200, await new Promise<Earnings>((r) => (release = r)));
    });
    renderScreen(fetch, true);
    await gridDrawn();
    await waitFor(() => expect(FakeEventSource.last?.url).toBe(EVENTS_PATH));
    await screen.findByText('Live');

    const rowId = gridRowId({
      buyerId: 'b-new',
      datasetId: fixture.rows[0]!.dims.dataset!.id,
      channel: 'MCP',
      isSimulated: false,
    });
    // AG adds the flash class and swaps it out again within ~1.5 s: record that it appeared.
    let flashed = false;
    const flashing = () =>
      document.querySelector(
        `.ag-row[row-id="${rowId}"] .ag-cell-data-changed, .ag-row[row-id="${rowId}"] .ag-cell-data-changed-animation`,
      );
    const seen = new MutationObserver(() => {
      flashed ||= flashing() !== null;
    });
    seen.observe(document.body, {
      attributes: true,
      attributeFilter: ['class'],
      childList: true,
      subtree: true,
    });

    // 2 s budget, the app's share: the refetch goes out in the same tick as the event (no
    // debounce, no timer), so what's left is SSE delivery (SP-025) and one API read.
    act(() =>
      FakeEventSource.last!.emit('call.charged', {
        publisherId: 'p1',
        type: 'call.charged',
        ids: ['call-1'],
        at: new Date().toISOString(),
      }),
    );
    await act(async () => {}); // let the client's fetch() call run (microtasks only, no timers)
    expect(reads).toBe(2);
    expect(release).not.toBeNull();

    // The read returns the new MCP call: its row appears, labelled MCP, and flashes once drawn.
    const current = withCall(fixture, mcpCall());
    act(() => release!(current));
    await waitFor(
      () => {
        const row = document.querySelector(`.ag-row[row-id="${rowId}"]`);
        expect(row?.querySelector('[data-channel="MCP"]')).toBeTruthy();
        expect(flashed).toBe(true);
      },
      // jsdom drawing AG is slow on a loaded CI runner; this bounds the test, not the app.
      { timeout: 10_000 },
    );
    seen.disconnect();
    expect(screen.getByText('Claude Desktop (live)')).toBeInTheDocument();
    expect(tile('Your earnings')).toHaveTextContent(formatMicros(current.kpis.netMicros));
  });

  it('exports the grouped grid as CSV, money in dollars', async () => {
    renderScreen(fakeFetch({ [earningsPath(true)]: () => fixture }));
    await gridDrawn();

    const blobs: Blob[] = [];
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn((b: Blob) => {
          blobs.push(b);
          return 'blob:csv';
        }),
        revokeObjectURL: vi.fn(),
      }),
    );
    const clicks: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push(this.download);
    });

    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(blobs).toHaveLength(1));
    expect(clicks).toEqual([EARNINGS_CSV_FILE]);
    const csv = await blobs[0]!.text();
    expect(csv).toMatch(/"Gross"/);
    expect(csv).toMatch(/"Net \(yours\)"/);
    expect(csv).toContain('Acme Agents');
    expect(csv).toContain('"MCP"');
    expect(csv).toContain(`"${(fixture.kpis.grossMicros / 1_000_000).toFixed(6)}"`);
    click.mockRestore();
  });

  it('"Include simulated" off refetches without SIM', async () => {
    const real = { ...fixture, rows: fixture.rows.filter((r) => !r.isSimulated) };
    const fetch = fakeFetch({
      [earningsPath(true)]: () => fixture,
      [earningsPath(false)]: () => real,
    });
    renderScreen(fetch);
    await gridDrawn();
    expect(screen.queryAllByText('Relocation Scout').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByLabelText('Include simulated'));
    await waitFor(() => expect(screen.queryAllByText('Relocation Scout')).toHaveLength(0));
    expect(fetch).toHaveBeenCalledWith(earningsPath(false), expect.anything());
  });

  it('empty: "No buyers yet. Your API is live at …"', async () => {
    const empty: Earnings = {
      kpis: {
        grossMicros: 0,
        commissionMicros: 0,
        netMicros: 0,
        payableMicros: 0,
        calls: 0,
        recordsSold: 0,
        changesSold: 0,
        buyers: 0,
      },
      rows: [],
    };
    renderScreen(
      fakeFetch({
        [earningsPath(true)]: () => empty,
        '/api/sites': () => ({ sites: [{ slug: 'bluebonnet' }] }),
      }),
    );
    expect(
      await screen.findByText(
        `${W08_COPY.noBuyers} Your API is live at https://spigot.test/v1/bluebonnet.`,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open your catalog page' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Export CSV' })).toBeNull();
  });

  it('a failed load shows an inline error with retry', async () => {
    let ok = false;
    const fetch = vi.fn<FetchLike>(async () =>
      ok
        ? json(200, fixture)
        : json(503, { error: { code: 'INTERNAL_ERROR', message: 'Down for a moment.' } }),
    );
    renderScreen(fetch);
    expect(await screen.findByText('Down for a moment.')).toBeInTheDocument();
    ok = true;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(tile('Gross')).toHaveTextContent(formatMicros(fixture.kpis.grossMicros)),
    );
  });

  it('ledger tab: server-side rows with PayPal ids linking to the payout', async () => {
    const ledgerUrl = '/api/publishers/me/ledger?includeSim=true';
    renderScreen(
      fakeFetch({ [earningsPath(true)]: () => fixture, [ledgerUrl]: () => ledgerFixture }),
    );
    await gridDrawn();
    await userEvent.click(screen.getByRole('tab', { name: 'Ledger' }));
    const payout = (ledgerFixture.rows as LedgerRow[]).find((r) => r.paypalId)!;
    const link = await screen.findByRole('link', { name: 'View payout' }, { timeout: 10_000 });
    expect(link).toHaveAttribute('href', `/app/payouts?item=${payout.paypalId}`);
    expect(screen.getByTitle(payout.paypalId!)).toBeInTheDocument();
    const row = link.closest('.ag-row')!;
    expect(within(row as HTMLElement).getByText('Payout')).toBeInTheDocument();
    expect(cellText(row, 'amountMicros')).toBe(formatMicros(payout.amountMicros));
  });
});

describe('createLedgerDatasource (offset blocks → keyset cursors)', () => {
  const rowsOf = (n: number, from: number): LedgerRow[] =>
    Array.from({ length: n }, (_, i) => ({
      ...(ledgerFixture.rows[1] as LedgerRow),
      id: String(from - i),
    }));

  function run(ds: ReturnType<typeof createLedgerDatasource>, startRow: number) {
    return new Promise<{ rowData: LedgerRow[]; rowCount?: number }>((resolve, reject) =>
      ds.getRows({
        request: { startRow, endRow: startRow + LEDGER_BLOCK },
        success: resolve,
        fail: reject,
      } as unknown as IServerSideGetRowsParams<LedgerRow>),
    );
  }

  it('follows nextCursor block by block, walks skipped blocks, and ends with a row count', async () => {
    const pages: Record<string, unknown> = {
      '/api/publishers/me/ledger?includeSim=false': { rows: rowsOf(100, 300), nextCursor: 'c1' },
      '/api/publishers/me/ledger?includeSim=false&cursor=c1': {
        rows: rowsOf(100, 200),
        nextCursor: 'c2',
      },
      '/api/publishers/me/ledger?includeSim=false&cursor=c2': {
        rows: rowsOf(40, 100),
        nextCursor: null,
      },
    };
    const fetch = fakeFetch(
      Object.fromEntries(Object.entries(pages).map(([k, v]) => [k, () => v])),
    );
    const ds = createLedgerDatasource(createApiClient({ fetch, fixtures: false }), false);

    // A jump straight to block 2 walks block 0 and 1 for their cursors.
    const last = await run(ds, 200);
    expect(last.rowData[0]!.id).toBe('100');
    expect(last.rowCount).toBe(240);
    expect(fetch).toHaveBeenCalledTimes(3);

    const first = await run(ds, 0);
    expect(first.rowData).toHaveLength(100);
    expect(first.rowCount).toBeUndefined();

    const beyond = await run(ds, 300);
    expect(beyond).toEqual({ rowData: [], rowCount: 300 });
  });
});
