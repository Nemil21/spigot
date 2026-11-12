import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient, type FetchLike } from '../../api/client';
import auditFixture from '../../fixtures/admin/audit.json';
import healthFixture from '../../fixtures/admin/health.json';
import { AuditScreen } from './Audit';
import { auditUrl, dataSummary, formatAt, isSimEvent, lastGateHit } from './model';
import type { AdminHealth, AdminRunResult, AuditEvent, LedgerCheckResult } from './model';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const CAPTURE = 'FXCAPTURE3H8W1';
const BUYER = '00000000-0000-4000-8000-0000000000b1';
const PUBLISHER = '00000000-0000-4000-8000-000000000001';

const EVENTS = auditFixture.events as AuditEvent[];
const HEALTH = healthFixture as AdminHealth;

interface State {
  events: AuditEvent[];
  health: AdminHealth;
  ledger: LedgerCheckResult;
  run: () => AdminRunResult;
  status: number | null;
}

/** A fake SP-043 / SP-021 API: filters audit rows like `searchAudit`, records every call. */
function fakeApi(over: Partial<State> = {}) {
  const state: State = {
    events: EVENTS,
    health: HEALTH,
    ledger: { sumMicros: 0, accountsChecked: 41, mismatches: [] },
    run: () => ({
      demoControl: true,
      outcome: 'PENDING',
      batchId: 'aaaaaaaa-0000-4000-8000-000000000009',
      resumed: false,
      paypalBatchId: 'PPBATCHRUN01',
      items: [{ id: 'i1', publisherId: PUBLISHER, netCents: 41_275 }],
    }),
    status: null,
    ...over,
  };
  const fetch = vi.fn<FetchLike>(async (url, init) => {
    const method = init.method ?? 'GET';
    if (state.status)
      return json(state.status, { error: { code: 'FORBIDDEN', message: 'Admins only.' } });
    const u = new URL(url, 'http://x');
    if (method === 'GET' && u.pathname === '/admin/health') return json(200, state.health);
    if (method === 'GET' && u.pathname === '/admin/audit') {
      const q = u.searchParams;
      const limit = Number(q.get('limit') ?? 50);
      const cursor = q.get('cursor');
      const rows = state.events.filter(
        (e) =>
          (!q.get('paypalId') || e.paypalId === q.get('paypalId')) &&
          (!q.get('publisherId') || e.publisherId === q.get('publisherId')) &&
          (!q.get('actorId') || e.actorId === q.get('actorId')) &&
          (!cursor || BigInt(e.id) < BigInt(cursor)),
      );
      const page = rows.slice(0, limit);
      return json(200, {
        events: page,
        next: rows.length > limit ? page[page.length - 1]!.id : null,
      });
    }
    if (method === 'POST' && url === '/admin/ledger/check') return json(200, state.ledger);
    if (method === 'POST' && url === '/admin/payouts/run') {
      await new Promise((r) => setTimeout(r, 20)); // a second click lands while this is open
      return json(200, state.run());
    }
    return json(404, { error: { code: 'NOT_FOUND', message: `no route ${method} ${url}` } });
  });
  return { state, fetch, client: createApiClient({ fetch, fixtures: false }) };
}

function renderScreen(api: ReturnType<typeof fakeApi>, at = '/app/admin/audit') {
  render(
    <MemoryRouter initialEntries={[at]}>
      <AuditScreen client={api.client} />
    </MemoryRouter>,
  );
}

const auditCalls = (api: ReturnType<typeof fakeApi>) =>
  api.fetch.mock.calls.map(([url]) => url).filter((u) => u.startsWith('/admin/audit'));

describe('W14 Admin / audit', () => {
  it('healthy: banner and the five health tiles', async () => {
    renderScreen(fakeApi());
    expect(await screen.findByText(/^Healthy\./)).toBeInTheDocument();
    const tile = (name: string) => screen.getByRole('group', { name });
    expect(tile('PayPal token')).toHaveTextContent('Minted');
    expect(tile('PayPal token')).toHaveAttribute('data-tone', 'ok');
    expect(tile('Workflows')).toHaveTextContent('In-process');
    expect(tile('Last gate hit')).toHaveTextContent('2026-11-12 10:00:30 UTC');
    expect(tile('Last gate hit')).toHaveTextContent('http://localhost:4000 · 1 site');
    expect(tile('Open top-ups')).toHaveTextContent('1');
    expect(tile('Pending payouts')).toHaveTextContent('1 sent · 0 unclaimed');
  });

  it('degraded: names the failed checks and marks their tiles', async () => {
    const health: AdminHealth = {
      ...HEALTH,
      status: 'degraded',
      checks: {
        ...HEALTH.checks,
        paypal: { ok: false, ms: 5000, error: 'TIMEOUT' },
        workflows: {
          ok: false,
          mode: 'workflows',
          detail: 'Render Workflows keys missing',
          missing: ['RENDER_API_KEY'],
        },
      },
    };
    renderScreen(fakeApi({ health }));
    const alert = await screen.findByText(/^Degraded:/);
    expect(alert).toHaveTextContent('PayPal token (TIMEOUT)');
    expect(alert).toHaveTextContent('Workflows (Render Workflows keys missing: RENDER_API_KEY)');
    expect(screen.getByRole('group', { name: 'PayPal token' })).toHaveAttribute('data-tone', 'bad');
    expect(screen.getByRole('group', { name: 'Workflows' })).toHaveAttribute('data-tone', 'bad');
    expect(screen.queryByText(/^Healthy\./)).toBeNull();
  });

  it('degraded with the DB down: tiles say Unknown instead of zeros', async () => {
    const health: AdminHealth = {
      ...HEALTH,
      status: 'degraded',
      checks: {
        ...HEALTH.checks,
        db: { ok: false, ms: 5000, error: 'TIMEOUT' },
        facts: { ok: false, ms: 0, error: 'DB_UNAVAILABLE' },
      },
      gate: null,
      openTopups: null,
      pendingPayouts: null,
    };
    renderScreen(fakeApi({ health }));
    expect(await screen.findByText(/^Degraded:/)).toHaveTextContent('Database (TIMEOUT)');
    expect(screen.getByRole('group', { name: 'Open top-ups' })).toHaveTextContent('Unknown');
    expect(screen.getByRole('group', { name: 'Pending payouts' })).toHaveTextContent('Unknown');
  });

  it('lists the newest audit events with SIM chips on simulated rows', async () => {
    renderScreen(fakeApi());
    expect(await screen.findByText('5 events, newest first')).toBeInTheDocument();
    expect(screen.getByText('PAYOUT_SENT')).toBeInTheDocument();
    // Only the SIM-actor row carries the chip.
    expect(screen.getAllByTitle('Simulated demo data')).toHaveLength(1);
    const simRow = screen.getByTitle('FXSIMCAPTURE01').closest('[role="row"]') as HTMLElement;
    expect(within(simRow).getByTitle('Simulated demo data')).toHaveTextContent('SIM');
  });

  it('searching a capture id finds its rows (and only those)', async () => {
    const api = fakeApi();
    renderScreen(api);
    await screen.findByText('5 events, newest first');

    await userEvent.type(screen.getByRole('searchbox', { name: 'PayPal id' }), `  ${CAPTURE} `);
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByText('1 event, newest first')).toBeInTheDocument();
    expect(screen.getByText('TOPUP_COMPLETED')).toBeInTheDocument();
    expect(screen.getByTitle(CAPTURE)).toBeInTheDocument();
    expect(screen.queryByText('PAYOUT_SENT')).toBeNull();
    expect(auditCalls(api).at(-1)).toBe(`/admin/audit?paypalId=${CAPTURE}&limit=50`);
  });

  it('a linked search (?paypalId=…) prefills the box and runs on load', async () => {
    const api = fakeApi();
    renderScreen(api, `/app/admin/audit?paypalId=${CAPTURE}`);
    expect(await screen.findByText('1 event, newest first')).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'PayPal id' })).toHaveValue(CAPTURE);
    expect(auditCalls(api)).toEqual([`/admin/audit?paypalId=${CAPTURE}&limit=50`]);
  });

  it('searches by buyer (actorId) and publisher', async () => {
    const api = fakeApi();
    renderScreen(api);
    await screen.findByText('5 events, newest first');

    await userEvent.type(screen.getByRole('searchbox', { name: 'Buyer id' }), BUYER);
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('3 events, newest first')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await screen.findByText('5 events, newest first');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Publisher id' }), PUBLISHER);
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('2 events, newest first')).toBeInTheDocument();
    expect(auditCalls(api).at(-1)).toBe(`/admin/audit?publisherId=${PUBLISHER}&limit=50`);
  });

  it('a publisher id that is not a UUID is refused before any request', async () => {
    const api = fakeApi();
    renderScreen(api);
    await screen.findByText('5 events, newest first');
    const before = auditCalls(api).length;
    await userEvent.type(screen.getByRole('searchbox', { name: 'Publisher id' }), 'bluebonnet');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByText('Publisher id must be a UUID.')).toBeInTheDocument();
    expect(auditCalls(api)).toHaveLength(before);
  });

  it('no match: empty state whose one action clears the search', async () => {
    renderScreen(fakeApi());
    await screen.findByText('5 events, newest first');
    await userEvent.type(screen.getByRole('searchbox', { name: 'PayPal id' }), 'NOPE');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('No audit events match this search.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(await screen.findByText('5 events, newest first')).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'PayPal id' })).toHaveValue('');
  });

  it('pages older events with the keyset cursor', async () => {
    const many: AuditEvent[] = Array.from({ length: 60 }, (_, i) => ({
      ...EVENTS[1]!,
      id: String(2000 - i),
      entityId: `call-${i}`,
    }));
    const api = fakeApi({ events: many });
    renderScreen(api);
    expect(await screen.findByText('50 events shown, newest first')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Load older events' }));
    expect(await screen.findByText('60 events, newest first')).toBeInTheDocument();
    expect(auditCalls(api).at(-1)).toBe('/admin/audit?limit=50&cursor=1951');
    expect(screen.queryByRole('button', { name: 'Load older events' })).toBeNull();
  });

  it('ledger check shows sum = 0 and that the ledger balances', async () => {
    renderScreen(fakeApi());
    await userEvent.click(await screen.findByRole('button', { name: 'Ledger check' }));
    const result = await screen.findByText(/The ledger balances\./);
    expect(result).toHaveTextContent('Sum = 0 micros ($0.00) across 41 accounts.');
    expect(result.closest('[data-ledger]')).toHaveAttribute('data-ledger', 'balanced');
  });

  it('ledger check with a mismatch is an alert listing it', async () => {
    const ledger: LedgerCheckResult = {
      sumMicros: 1500,
      accountsChecked: 41,
      mismatches: [
        { check: 'GLOBAL_SUM', expectedMicros: 0, actualMicros: 1500 },
        { check: 'ACCOUNT_BALANCE', accountId: 'acct-9', expectedMicros: 10, actualMicros: 1510 },
      ],
    };
    renderScreen(fakeApi({ ledger }));
    await userEvent.click(await screen.findByRole('button', { name: 'Ledger check' }));
    const alert = (await screen.findByText(/2 mismatches\./)).closest('[role="alert"]')!;
    expect(alert).toHaveTextContent('Sum = 1,500 micros');
    expect(alert).toHaveTextContent('ACCOUNT_BALANCE acct-9: expected 10, found 1,510 micros');
  });

  it('run payout now: confirm, a double click sends one POST, then health and audit refresh', async () => {
    const api = fakeApi();
    renderScreen(api);
    await screen.findByText('5 events, newest first');
    const healthBefore = api.fetch.mock.calls.filter(([u]) => u === '/admin/health').length;

    await userEvent.click(screen.getByRole('button', { name: 'Run payout now' }));
    expect(screen.getByText(/PayPal sandbox payout batch now/)).toBeInTheDocument();
    await userEvent.dblClick(screen.getByRole('button', { name: 'Pay out via PayPal' }));

    const status = await screen.findByText(/Payout batch sent via PayPal: 1 item\./);
    expect(status.closest('[data-outcome]')).toHaveAttribute('data-outcome', 'PENDING');
    expect(screen.getByTitle('PPBATCHRUN01')).toBeInTheDocument();
    expect(screen.getByText('$412.75')).toBeInTheDocument();

    const posts = api.fetch.mock.calls.filter(
      ([u, init]) => init.method === 'POST' && u === '/admin/payouts/run',
    );
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]![1].body as string)).toEqual({ trigger: 'MANUAL_DEMO' });
    expect((posts[0]![1].headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
    await waitFor(() =>
      expect(api.fetch.mock.calls.filter(([u]) => u === '/admin/health').length).toBe(
        healthBefore + 1,
      ),
    );
  });

  it('run payout now with nothing payable says so', async () => {
    const api = fakeApi({
      run: () => ({
        demoControl: true,
        outcome: 'NO_ITEMS',
        batchId: null,
        resumed: false,
        items: [],
      }),
    });
    renderScreen(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Run payout now' }));
    await userEvent.click(screen.getByRole('button', { name: 'Pay out via PayPal' }));
    expect(await screen.findByText(/Nothing to pay out/)).toBeInTheDocument();
  });

  it('cancel closes the confirm without a request', async () => {
    const api = fakeApi();
    renderScreen(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Run payout now' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Pay out via PayPal' })).toBeNull();
    expect(api.fetch.mock.calls.some(([, init]) => init.method === 'POST')).toBe(false);
  });

  it('non-admin (403): says admins only, no tiles or grid', async () => {
    renderScreen(fakeApi({ status: 403 }));
    expect(await screen.findByText('Admins only.')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'PayPal token' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ledger check' })).toBeNull();
  });

  it('audit error: inline banner with retry', async () => {
    const api = fakeApi();
    const real = api.fetch.getMockImplementation()!;
    let auditHits = 0;
    api.fetch.mockImplementation(async (url, init) => {
      if (url.startsWith('/admin/audit') && ++auditHits === 1)
        return json(500, { error: { code: 'INTERNAL', message: 'Database is down.' } });
      return real(url, init);
    });
    renderScreen(api);
    expect(await screen.findByText('Database is down.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('5 events, newest first')).toBeInTheDocument();
  });
});

describe('W14 model', () => {
  it('auditUrl drops empty fields and trims', () => {
    expect(auditUrl({ paypalId: ' X1 ', publisherId: '' })).toBe(
      '/admin/audit?paypalId=X1&limit=50',
    );
    expect(auditUrl({}, '99', 10)).toBe('/admin/audit?limit=10&cursor=99');
  });

  it('isSimEvent: SIM actor or data.isSimulated', () => {
    expect(isSimEvent(EVENTS[4]!)).toBe(true);
    expect(isSimEvent({ ...EVENTS[1]!, data: { isSimulated: true } })).toBe(true);
    expect(isSimEvent(EVENTS[1]!)).toBe(false);
  });

  it('formatAt is UTC and tolerates nulls', () => {
    expect(formatAt('2026-11-12T10:04:05.123Z')).toBe('2026-11-12 10:04:05 UTC');
    expect(formatAt(null)).toBe('—');
  });

  it('dataSummary skips nulls', () => {
    expect(dataSummary({ a: 1, b: null, c: { d: 2 } })).toBe('a: 1 · c: {"d":2}');
    expect(dataSummary(null)).toBe('');
  });

  it('lastGateHit picks the newest signal across sites', () => {
    expect(lastGateHit(null)).toBeNull();
    expect(lastGateHit([])).toBeNull();
    const site = HEALTH.gate![0]!;
    expect(
      lastGateHit([
        site,
        { ...site, origin: 'https://b.example', lastHitAt: '2026-11-12T11:00:00.000Z' },
      ]),
    ).toEqual({ at: '2026-11-12T11:00:00.000Z', origin: 'https://b.example', sites: 2 });
    expect(lastGateHit([{ ...site, lastHitAt: null, lastGateSeenAt: null }])).toBeNull();
  });
});
