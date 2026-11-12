import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient, type FetchLike } from '../api/client';
import type { EventSourceLike } from '../api/sse';
import { displayPattern, keyFields, withheldFields } from '../components/ProposalCard';
import sitesFixture from '../fixtures/api/sites.json';
import statusFixture from '../fixtures/api/sites/_/proposal-status.json';
import proposalsFixture from '../fixtures/api/sites/_/proposals.json';
import RecordTypesPage, { headline, type ProposalStatus } from './RecordTypes';

const SITE = sitesFixture.sites[0]!;
const BASE = `/api/sites/${SITE.id}`;
const ALL = proposalsFixture.proposals;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

class FakeSource implements EventSourceLike {
  static all: FakeSource[] = [];
  readyState = 0;
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  listeners = new Map<string, ((ev: MessageEvent) => void)[]>();
  constructor(readonly url: string) {
    FakeSource.all.push(this);
  }
  addEventListener(type: string, l: (ev: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
  }
  close() {
    this.readyState = 2;
  }
  emit(type: string, data: unknown) {
    const ev = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
}

interface World {
  proposals: unknown[];
  status: ProposalStatus;
  sites?: unknown;
  onMutate?: (url: string, init: RequestInit) => Response | Promise<Response>;
}

function setup(world: World) {
  FakeSource.all = [];
  const fetch = vi.fn<FetchLike>(async (url, init) => {
    if (init.method === 'GET' && url === '/api/sites')
      return json(200, world.sites ?? sitesFixture);
    if (init.method === 'GET' && url === `${BASE}/proposals`)
      return json(200, { proposals: world.proposals });
    if (init.method === 'GET' && url === `${BASE}/proposal-status`) return json(200, world.status);
    return world.onMutate ? world.onMutate(url, init) : json(500, {});
  });
  const client = createApiClient({ fetch, fixtures: false });
  const router = createMemoryRouter(
    [
      {
        path: '/app/record-types',
        element: (
          <RecordTypesPage
            client={client}
            createSource={(url) => new FakeSource(url)}
            pollMs={60_000}
          />
        ),
      },
      { path: '/app/datasets/:datasetId', element: <p>W06 editor</p> },
    ],
    { initialEntries: ['/app/record-types'] },
  );
  render(<RouterProvider router={router} />);
  return { fetch, router };
}

const ready: ProposalStatus = statusFixture as ProposalStatus;
const proposing: ProposalStatus = {
  siteStatus: 'PROPOSING',
  crawling: false,
  running: true,
  templates: [
    { pattern: '^/listings/[a-z0-9-]+$', pageCount: 2341, state: 'reading' },
    { pattern: '^/agents/[a-z0-9-]+$', pageCount: 88, state: 'reading' },
    { pattern: '^/open-houses/[0-9]+$', pageCount: 40, state: 'reading' },
  ],
  message: null,
};

const cards = () => screen.queryAllByRole('article');

describe('W05 Record types found', () => {
  it('pure helpers: headline, display pattern, key / withheld fields', () => {
    expect(headline(3)).toBe('I found 3 kinds of records on your site');
    expect(headline(1)).toBe('I found 1 kind of record on your site');
    expect(displayPattern('^/listings/[a-z0-9-]+$')).toBe('/listings/:slug');
    expect(displayPattern('^/open-houses/[0-9]+$')).toBe('/open-houses/:id');
    expect(displayPattern('^/a\\.b/[a-z]+/x$')).toBe('/a.b/:slug/x');
    expect(displayPattern('/blog/:slug')).toBe('/blog/:slug');
    const listing = ALL[0]!.fields;
    expect(keyFields(listing).map((f) => f.name)).toEqual([
      'title',
      'price_usd',
      'bedrooms',
      'city',
    ]);
    expect(withheldFields(listing).map((f) => f.name)).toEqual(['agent_phone']);
  });

  it('after a live discovery crawl, three cards stream in over SSE without a reload', async () => {
    const world: World = {
      proposals: [],
      status: {
        siteStatus: 'VERIFIED',
        crawling: true,
        running: false,
        templates: [],
        message: null,
      },
    };
    const { fetch } = setup(world);
    expect(await screen.findByText('Crawling your site…')).toBeInTheDocument();
    expect(cards()).toHaveLength(0);
    const source = FakeSource.all.at(-1)!;
    expect(source.url).toBe('/api/publishers/me/events');

    // Crawl done → the agent starts reading templates.
    world.status = proposing;
    act(() => source.emit('crawl.progress', { type: 'crawl.progress', ids: ['run1'] }));
    expect(await screen.findAllByText(/reading 5 sample pages/, { selector: 'li' })).toHaveLength(
      3,
    );
    expect(screen.getByText('/listings/:slug')).toBeInTheDocument();

    // One proposal at a time, as the agent writes them.
    for (let n = 1; n <= 3; n++) {
      world.proposals = ALL.slice(0, n);
      world.status = {
        ...proposing,
        templates: proposing.templates.slice(n),
        ...(n === 3 ? { siteStatus: 'READY', running: false } : {}),
      };
      act(() =>
        source.emit('proposal.ready', { type: 'proposal.ready', ids: [ALL[n - 1]!.datasetId] }),
      );
      await waitFor(() => expect(cards()).toHaveLength(n));
    }

    expect(
      screen.getByRole('heading', { level: 1, name: 'I found 3 kinds of records on your site' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Listing · 2,341' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Agent · 88' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Open House · 40' })).toBeInTheDocument();
    expect(screen.queryByText(/reading 5 sample pages/)).toBeNull();
    expect(screen.getByText(/Claude wrote the extractor once\./)).toHaveTextContent(
      'It now runs with no AI on each page.',
    );
    // Never a reload: /api/sites was read once per refetch, never via navigation.
    expect(
      fetch.mock.calls.filter(([u]) => u === `${BASE}/proposals`).length,
    ).toBeGreaterThanOrEqual(4);
  });

  it('a card: pattern, source badge, 4 key fields, quality bar, price, 5-row grid, rationale', async () => {
    setup({ proposals: ALL, status: ready });
    const card = (await screen.findByRole('heading', { name: 'Listing · 2,341' })).closest(
      'article',
    )!;
    const c = within(card as HTMLElement);
    expect(c.getByText('/listings/:slug')).toBeInTheDocument();
    expect(c.getByText('JSON-LD')).toBeInTheDocument();
    const keys = within(c.getByLabelText('Key fields'));
    expect(keys.getAllByRole('term').map((t) => t.textContent)).toEqual([
      'title',
      'price_usd',
      'bedrooms',
      'city',
    ]);
    expect(
      c.getByRole('img', { name: '4 of 7 fields filled on every sample page' }),
    ).toBeInTheDocument();
    expect(c.getByText('$1.50 / 1,000 records')).toBeInTheDocument();
    expect(c.getByText('Why Claude chose these fields')).toBeInTheDocument();

    const grid = c.getByRole('region', { name: 'Listing sample rows' });
    await waitFor(() =>
      expect(within(grid).getByText('Downtown loft with skyline views')).toBeInTheDocument(),
    );
    for (const row of ALL[0]!.sampleRows)
      expect(within(grid).getByText(row.title)).toBeInTheDocument();
  });

  it('hidden-by-default PII fields get a PII badge and are not key fields or grid columns', async () => {
    setup({ proposals: ALL, status: ready });
    const card = (await screen.findByRole('heading', { name: 'Listing · 2,341' })).closest(
      'article',
    )!;
    const c = within(card as HTMLElement);
    const keys = within(c.getByLabelText('Key fields'));
    expect(keys.queryByText('agent_phone')).toBeNull();
    const withheld = within(c.getByLabelText('Not for sale by default'));
    const item = withheld.getByText('agent_phone').closest('li')!;
    expect(within(item).getByText('PII')).toBeInTheDocument();
    expect(within(item).getByText('hidden')).toBeInTheDocument();
    const grid = c.getByRole('region', { name: 'Listing sample rows' });
    await waitFor(() => expect(within(grid).getByText('title')).toBeInTheDocument());
    expect(within(grid).queryByText('agent_phone')).toBeNull();
    expect(within(grid).queryByText('(512) 555-0142')).toBeNull();
  });

  it('Reject moves the card out; Review opens W06 for that dataset', async () => {
    const posted: string[] = [];
    const world: World = {
      proposals: ALL,
      status: ready,
      onMutate: (url, init) => {
        posted.push(`${init.method} ${url}`);
        return json(200, { status: 'REJECTED' });
      },
    };
    const { router } = setup(world);
    await screen.findByRole('heading', { name: 'Agent · 88' });

    await userEvent.click(screen.getByRole('button', { name: 'Reject Agent' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Agent · 88' })).toBeNull());
    expect(posted).toEqual([`POST /api/datasets/${ALL[1]!.datasetId}/reject`]);
    expect(cards()).toHaveLength(2);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'I found 2 kinds of records on your site',
    );

    // A refetch that still lists it (started before the reject) doesn't bring it back.
    act(() => FakeSource.all.at(-1)!.emit('proposal.ready', { ids: [] }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('heading', { name: 'Agent · 88' })).toBeNull();

    await userEvent.click(screen.getByRole('link', { name: 'Review Listing' }));
    expect(router.state.location.pathname).toBe(`/app/datasets/${ALL[0]!.datasetId}`);
    expect(screen.getByText('W06 editor')).toBeInTheDocument();
  });

  it('a failed reject keeps the card and says why', async () => {
    setup({
      proposals: ALL,
      status: ready,
      onMutate: () =>
        json(500, {
          error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side.' },
        }),
    });
    await screen.findByRole('heading', { name: 'Agent · 88' });
    await userEvent.click(screen.getByRole('button', { name: 'Reject Agent' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't reject: Something went wrong on our side.",
    );
    expect(cards()).toHaveLength(3);
  });

  it('one template skipped: "Couldn\'t find consistent fields on /blog/*; skipped"', async () => {
    setup({ proposals: ALL, status: ready });
    expect(
      await screen.findByText("Couldn't find consistent fields on /blog/*; skipped"),
    ).toBeInTheDocument();
    expect(cards()).toHaveLength(3);
  });

  it('none: no repeated structure', async () => {
    setup({
      proposals: [],
      status: {
        siteStatus: 'READY',
        crawling: false,
        running: false,
        templates: [],
        message: 'no repeated structure found',
      },
    });
    expect(await screen.findByText(/didn't find repeated page structure/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Record types on your site',
    );
  });

  it('no site yet → connect your site', async () => {
    setup({ proposals: [], status: ready, sites: { sites: [] } });
    expect(await screen.findByRole('link', { name: 'Connect your site' })).toHaveAttribute(
      'href',
      '/app/connect',
    );
  });

  it('skeletons first; an error banner with retry when loading fails', async () => {
    let fail = true;
    FakeSource.all = [];
    const fetch = vi.fn<FetchLike>(async (url) => {
      if (fail) return json(500, { error: { code: 'INTERNAL_ERROR', message: 'Down for a bit.' } });
      if (url === '/api/sites') return json(200, sitesFixture);
      if (url.endsWith('/proposals')) return json(200, { proposals: ALL });
      return json(200, ready);
    });
    const client = createApiClient({ fetch, fixtures: false });
    const router = createMemoryRouter(
      [
        {
          path: '/',
          element: <RecordTypesPage client={client} createSource={(u) => new FakeSource(u)} />,
        },
      ],
      { initialEntries: ['/'] },
    );
    render(<RouterProvider router={router} />);
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(await screen.findByRole('alert')).toHaveTextContent('Down for a bit.');
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(cards()).toHaveLength(3));
  });
});
