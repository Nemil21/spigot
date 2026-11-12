import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { createApiClient, type FetchLike } from '../../api/client';
import liveFixture from '../../fixtures/api/datasets/fx-live.json';
import { DatasetEditorScreen } from '../DatasetEditor';
import type { DatasetDetail, Reinference } from './model';
import { StaleBanner } from './StaleBanner';

// SP-052b: W06 stale banner, re-inference states and the diff of sources.

const LIVE = liveFixture as unknown as DatasetDetail;
const NEW_VERSION = '00000000-0000-4000-8000-0000000000e9';
const NOW = Date.parse('2026-11-12T14:00:00.000Z');

const proposedReinference: Reinference = {
  state: 'PROPOSED',
  schemaVersionId: NEW_VERSION,
  version: 2,
  reason: null,
  sources: [
    {
      name: 'price_usd',
      before: 'JSON-LD $.offers.price · toInt',
      after: 'JSON-LD $.offers.price · toInt',
      changed: false,
    },
    {
      name: 'available_from',
      before: 'CSS dl.facts dd[data-k=available] · trim, date',
      after: 'CSS time.move-in-date @datetime · trim, date',
      changed: true,
    },
    {
      name: 'pets_allowed',
      before: 'CSS dl.facts dd[data-k=pets] · trim',
      after: 'CSS dl.specs dd[data-spec=pet-policy] · trim',
      changed: true,
    },
  ],
};

const stale = (
  reinference: Reinference | null,
  extra: Partial<DatasetDetail> = {},
): DatasetDetail => ({
  ...LIVE,
  status: 'LIVE_STALE',
  staleSince: '2026-11-12T08:30:00.000Z',
  lastGoodExtractAt: '2026-11-12T08:00:00.000Z',
  reinference,
  ...extra,
});

describe('StaleBanner', () => {
  it('shows the W15 freshness copy from the last good extract', () => {
    render(<StaleBanner detail={stale(null)} now={NOW} retrying={false} onRetry={() => {}} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Last good extract 6 h ago; the site changed layout.',
    );
    expect(screen.getByText(/Claude is reading the new layout/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('a re-proposal: Review opens the diff of sources, changed rows marked', async () => {
    render(
      <StaleBanner
        detail={stale(proposedReinference)}
        now={NOW}
        retrying={false}
        onRetry={() => {}}
      />,
    );
    expect(
      screen.getByText(/A new extractor \(v2\) is ready: same 3 fields, 2 sources updated/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Review' }));
    const table = screen.getByRole('table', { name: 'Where each field comes from' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getByRole('rowheader').textContent)).toEqual([
      'price_usd',
      'available_from',
      'pets_allowed',
    ]);
    expect(rows[0]).toHaveTextContent('unchanged');
    expect(rows[1]).toHaveAttribute('data-changed');
    expect(rows[1]).toHaveTextContent('CSS time.move-in-date @datetime · trim, date');
    expect(screen.getByRole('button', { name: 'Hide changes' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('a field the self-check dropped reads "no longer found"', async () => {
    const r: Reinference = {
      ...proposedReinference,
      sources: [
        { name: 'status', before: 'CSS dl.facts dd[data-k=status]', after: null, changed: true },
      ],
    };
    render(<StaleBanner detail={stale(r)} now={NOW} retrying={false} onRetry={() => {}} />);
    expect(screen.getByText(/1 no longer found/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(screen.getByText('no longer found')).toBeInTheDocument();
  });
});

describe('W06 with a stale dataset', () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  function api(first: DatasetDetail, afterRetry: DatasetDetail) {
    const calls: { method: string; path: string }[] = [];
    let detail = first;
    const fetch: FetchLike = async (path, init) => {
      const method = init.method ?? 'GET';
      calls.push({ method, path });
      if (method === 'GET' && path === `/api/datasets/${first.id}`) return json(200, detail);
      if (method === 'POST' && path === `/api/datasets/${first.id}/reinfer`) {
        detail = afterRetry;
        return json(202, { status: 'REINFERRING' });
      }
      return json(404, { error: { code: 'NOT_FOUND', message: `no route ${method} ${path}` } });
    };
    return { calls, client: createApiClient({ fetch, fixtures: false }) };
  }

  it('a failed re-inference: Try again posts /reinfer and shows the new state', async () => {
    const failed = stale({
      ...proposedReinference,
      state: 'FAILED',
      reason: 'model unavailable',
      sources: [],
    });
    const a = api(failed, stale({ ...proposedReinference, state: 'RUNNING', sources: [] }));
    render(
      <MemoryRouter>
        <DatasetEditorScreen datasetId={failed.id} client={a.client} sse={{ enabled: false }} />
      </MemoryRouter>,
    );
    expect(
      await screen.findByText(/Couldn't re-read the new layout \(model unavailable\)/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/Claude is reading the new layout/)).toBeInTheDocument();
    expect(a.calls.filter((c) => c.method === 'POST')).toEqual([
      { method: 'POST', path: `/api/datasets/${failed.id}/reinfer` },
    ]);
  });

  it('a LIVE dataset has no stale banner', async () => {
    const a = api(LIVE, LIVE);
    render(
      <MemoryRouter>
        <DatasetEditorScreen datasetId={LIVE.id} client={a.client} sse={{ enabled: false }} />
      </MemoryRouter>,
    );
    await screen.findByRole('region', { name: 'Live' });
    expect(screen.queryByRole('region', { name: 'Layout changed' })).toBeNull();
  });
});
