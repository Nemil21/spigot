import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { IServerSideGetRowsParams } from 'ag-grid-community';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient, type FetchLike } from '../api/client';
import datasetsFixture from '../fixtures/api/sites/_/datasets.json';
import recordsFixture from '../fixtures/api/datasets/_/records.json';
import versionsFixture from '../fixtures/api/records/_/versions.json';
import { recordColumns, recordsDatasource, RecordsBrowserScreen } from './RecordsBrowser';
import type { BrowserDataset, RecordRow } from './records/model';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const SITE = '00000000-0000-4000-8000-0000000000a1';
const [LISTINGS, AGENTS] = datasetsFixture.datasets as BrowserDataset[];

function routes(over: Record<string, () => Response> = {}) {
  const calls: string[] = [];
  const fetchImpl = vi.fn<FetchLike>(async (url) => {
    calls.push(url);
    const path = url.split('?')[0]!;
    if (over[path]) return over[path]();
    if (path === '/api/sites')
      return json(200, { sites: [{ id: SITE, origin: 'https://bluebonnet.example' }] });
    if (path === `/api/sites/${SITE}/datasets`) return json(200, datasetsFixture);
    if (/^\/api\/datasets\/[^/]+\/records$/.test(path)) return json(200, recordsFixture);
    if (/^\/api\/records\/[^/]+\/versions$/.test(path)) return json(200, versionsFixture);
    return json(404, { error: { code: 'NOT_FOUND', message: 'nope' } });
  });
  return { client: createApiClient({ fetch: fetchImpl, fixtures: false }), calls };
}

function renderAt(url: string, client: ReturnType<typeof routes>['client']) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <RecordsBrowserScreen client={client} />
    </MemoryRouter>,
  );
}

describe('recordColumns', () => {
  it('has a column per schema field, hidden fields marked, plus version, last changed and freshness', () => {
    const cols = recordColumns(LISTINGS!.fields);
    expect(cols.map((c) => c.colId)).toEqual([
      'key',
      'data.title',
      'data.price_usd',
      'data.bedrooms',
      'data.bathrooms',
      'data.city',
      'data.status',
      'data.available_on',
      'data.agent_phone',
      'version',
      'updatedAt',
      'crawledAt',
    ]);
    const phone = cols.find((c) => c.colId === 'data.agent_phone')!;
    expect(phone.headerName).toBe('agent_phone (hidden)');
    expect(phone.cellClass).toContain('line-through');
    expect(phone.headerTooltip).toMatch(/never sold to buyers \(personal data\)/);
    expect(cols.find((c) => c.colId === 'data.price_usd')!.filter).toBe('agNumberColumnFilter');
    expect(cols.find((c) => c.colId === 'data.available_on')!.filter).toBe('agDateColumnFilter');
    expect(cols.find((c) => c.colId === 'updatedAt')!.sort).toBe('desc');
  });
});

describe('recordsDatasource', () => {
  it('asks the API for exactly the block, sort and filter AG Grid requests', async () => {
    const { client, calls } = routes();
    const success = vi.fn();
    const ds = recordsDatasource(client, LISTINGS!.id);
    ds.getRows({
      request: {
        startRow: 200,
        endRow: 300,
        sortModel: [{ colId: 'data.price_usd', sort: 'asc' }],
        filterModel: {
          'data.bedrooms': { filterType: 'number', type: 'greaterThanOrEqual', filter: 3 },
        },
      },
      success,
      fail: vi.fn(),
    } as unknown as IServerSideGetRowsParams<RecordRow>);
    await waitFor(() => expect(success).toHaveBeenCalled());
    const url = new URL(calls[0]!, 'https://x');
    expect(url.pathname).toBe(`/api/datasets/${LISTINGS!.id}/records`);
    expect(url.searchParams.get('startRow')).toBe('200');
    expect(url.searchParams.get('endRow')).toBe('300');
    expect(JSON.parse(url.searchParams.get('sortModel')!)).toEqual([
      { colId: 'data.price_usd', sort: 'asc' },
    ]);
    expect(JSON.parse(url.searchParams.get('filterModel')!)).toEqual({
      'data.bedrooms': { filterType: 'number', type: 'greaterThanOrEqual', filter: 3 },
    });
    expect(success).toHaveBeenCalledWith({
      rowData: recordsFixture.rows,
      rowCount: recordsFixture.rowCount,
    });
  });

  it('fails the block (AG Grid shows its retry) when the API errors', async () => {
    const { client } = routes({ [`/api/datasets/${LISTINGS!.id}/records`]: () => json(500, {}) });
    const fail = vi.fn();
    recordsDatasource(client, LISTINGS!.id).getRows({
      request: { startRow: 0, endRow: 100, sortModel: [], filterModel: {} },
      success: vi.fn(),
      fail,
    } as unknown as IServerSideGetRowsParams<RecordRow>);
    await waitFor(() => expect(fail).toHaveBeenCalled());
  });
});

describe('RecordsBrowserScreen', () => {
  it('shows the first dataset in the server-side grid and opens history from a row', async () => {
    const { client } = routes();
    const user = userEvent.setup();
    renderAt('/app/records', client);
    const picker = await screen.findByRole('combobox', { name: 'Record type' });
    expect(picker).toHaveValue(LISTINGS!.id);
    expect(screen.getByText(/1 hidden field shown to you only/)).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument(); // not stale

    const cell = await screen.findByText(recordsFixture.rows[0]!.key, {}, { timeout: 5000 });
    await screen.findByText(/40 of 2,341 records match/);
    await user.click(cell);
    const drawer = await screen.findByRole('dialog', { name: 'Version history' });
    expect(
      await within(drawer).findByRole('region', { name: 'Changes in version 2' }),
    ).toBeInTheDocument();
  });

  it('shows the stale banner for a stale dataset picked by ?dataset=', async () => {
    const { client } = routes();
    renderAt(`/app/records?dataset=${AGENTS!.id}`, client);
    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent("Your site's layout changed");
    expect(
      within(banner).getByRole('link', { name: 'Review in the dataset editor' }),
    ).toHaveAttribute('href', `/app/datasets/${AGENTS!.id}`);
  });

  it('empty states: no site, nothing published', async () => {
    const none = routes({ '/api/sites': () => json(200, { sites: [] }) });
    const { unmount } = renderAt('/app/records', none.client);
    expect(await screen.findByRole('link', { name: 'Connect your site' })).toBeInTheDocument();
    unmount();

    const empty = routes({ [`/api/sites/${SITE}/datasets`]: () => json(200, { datasets: [] }) });
    renderAt('/app/records', empty.client);
    expect(await screen.findByText(/No published record types yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See record types' })).toHaveAttribute(
      'href',
      '/app/record-types',
    );
  });

  it('shows an error with retry when the dataset list fails', async () => {
    let n = 0;
    const { client } = routes({
      [`/api/sites/${SITE}/datasets`]: () =>
        ++n === 1
          ? json(500, { error: { code: 'INTERNAL', message: 'Try again.' } })
          : json(200, datasetsFixture),
    });
    const user = userEvent.setup();
    renderAt('/app/records', client);
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again.');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('combobox', { name: 'Record type' })).toBeInTheDocument();
  });
});
