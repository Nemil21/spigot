import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient, type FetchLike } from '../../api/client';
import type { EventSourceLike } from '../../api/sse';
import payoutsFixture from '../../fixtures/api/publishers/me/payouts.json';
import statementsFixture from '../../fixtures/api/publishers/me/payouts/statements.json';
import { PayoutsScreen } from '../Payouts';
import type {
  PayoutBatch,
  PayoutItem,
  PayoutStatements,
  PublisherPayouts,
  Statement,
} from './model';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const EMAIL = 'publisher@spigot-demo.example';
const BATCH = 'aaaaaaaa-0000-4000-8000-000000000001';
const ITEM = 'bbbbbbbb-0000-4000-8000-000000000001';

const NEXT = {
  payableMicros: 412_754_321,
  payableCents: 41_275,
  thresholdCents: 1000,
  nextPayoutDate: '2026-11-16',
  inFlightCents: 0,
  eligible: true,
};

function item(over: Partial<PayoutItem> = {}): PayoutItem {
  return {
    id: ITEM,
    paypalItemId: 'PPITEM0001',
    status: 'PENDING',
    netCents: 41_275,
    feeCents: null,
    grossMicros: 515_942_901,
    commissionMicros: 103_188_580,
    receiverEmail: EMAIL,
    errorCode: null,
    updatedAt: '2026-11-12T10:00:00.000Z',
    ...over,
  };
}

function batch(i: PayoutItem, over: Partial<PayoutBatch> = {}): PayoutBatch {
  return {
    id: BATCH,
    paypalBatchId: 'PPBATCH0001',
    status: 'PENDING',
    trigger: 'MANUAL_DEMO',
    needsReconcile: false,
    periodStart: '2026-11-04T00:00:00.000Z',
    periodEnd: '2026-11-12T10:00:00.000Z',
    createdAt: '2026-11-12T10:00:01.000Z',
    items: [i],
    ...over,
  };
}

const STATEMENT: Statement = {
  periodStart: '2026-11-04T00:00:00.000Z',
  periodEnd: '2026-11-12T10:00:00.000Z',
  recordsSold: 8112,
  grossMicros: 515_942_901,
  commissionMicros: 103_188_580,
  simGrossMicros: 0,
  simRecords: 0,
  roundingCarriedMicros: 4321,
};

interface State {
  payouts: PublisherPayouts;
  statements: PayoutStatements;
  run: () => Response;
}

/** A fake API: answers W09's endpoints from `state` and records every call. */
function fakeApi(over: Partial<State> = {}) {
  const state: State = {
    payouts: { isDemo: true, next: NEXT, batches: [] },
    statements: { next: { ...STATEMENT, roundingCarriedMicros: null }, items: {} },
    run: () => {
      // Like SP-021: the payable moves to an in-flight PENDING item with PayPal ids.
      state.payouts = {
        ...state.payouts,
        next: {
          ...NEXT,
          payableMicros: 4321,
          payableCents: 0,
          inFlightCents: 41_275,
          eligible: false,
        },
        batches: [batch(item())],
      };
      state.statements = { ...state.statements, items: { [ITEM]: STATEMENT } };
      return json(200, {
        demoControl: true,
        outcome: 'PENDING',
        batchId: BATCH,
        paypalBatchId: 'PPBATCH0001',
        resumed: false,
        items: [{ id: ITEM, netCents: 41_275 }],
      });
    },
    ...over,
  };
  const fetch = vi.fn<FetchLike>(async (url, init) => {
    const method = init.method ?? 'GET';
    if (method === 'GET' && url === '/api/publishers/me/payouts') return json(200, state.payouts);
    if (method === 'GET' && url === '/api/publishers/me/payouts/statements')
      return json(200, state.statements);
    if (method === 'POST' && url === '/api/publishers/me/payouts/run') {
      await new Promise((r) => setTimeout(r, 20)); // a click lands while the request is open
      return state.run();
    }
    return json(404, { error: { code: 'NOT_FOUND', message: `no route ${method} ${url}` } });
  });
  return { state, fetch, client: createApiClient({ fetch, fixtures: false }) };
}

/** A fake EventSource the test drives: `emit('payout.updated')`. */
function fakeSse() {
  const listeners = new Map<string, ((ev: MessageEvent) => void)[]>();
  const source: EventSourceLike = {
    readyState: 1,
    onopen: null,
    onerror: null,
    addEventListener(type, l) {
      listeners.set(type, [...(listeners.get(type) ?? []), l]);
    },
    close() {},
  };
  return {
    createSource: () => source,
    emit(type: string, data: unknown = {}) {
      for (const l of listeners.get(type) ?? [])
        l(new MessageEvent(type, { data: JSON.stringify(data) }));
    },
  };
}

function renderScreen(api: ReturnType<typeof fakeApi>, sse = fakeSse(), pollMs = 60_000) {
  render(
    <MemoryRouter>
      <PayoutsScreen
        client={api.client}
        sse={{ enabled: true, createSource: sse.createSource }}
        pollMs={pollMs}
      />
    </MemoryRouter>,
  );
  return sse;
}

const withBatch = (i: PayoutItem, isDemo = false): Partial<State> => ({
  payouts: { isDemo, next: NEXT, batches: [batch(i)] },
  statements: { next: STATEMENT, items: { [i.id]: STATEMENT } },
});

describe('W09 Payouts', () => {
  it('next payout card follows the copy exactly', async () => {
    renderScreen(fakeApi());
    expect(
      await screen.findByText('Next PayPal payout Monday · $412.75 payable · threshold $10'),
    ).toBeInTheDocument();
  });

  it('none yet: empty state with one action', async () => {
    renderScreen(fakeApi());
    expect(await screen.findByText(/No payouts yet\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See earnings' })).toBeInTheDocument();
  });

  it('error: inline banner with retry', async () => {
    const api = fakeApi();
    api.fetch.mockImplementationOnce(async () =>
      json(500, { error: { code: 'INTERNAL', message: 'Database is down.' } }),
    );
    renderScreen(api);
    expect(await screen.findByRole('alert')).toHaveTextContent('Database is down.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/No payouts yet\./)).toBeInTheDocument();
  });

  it('"Run payout now" is a demo control for the demo publisher only', async () => {
    renderScreen(fakeApi({ payouts: { isDemo: false, next: NEXT, batches: [] } }));
    await screen.findByText(/Next PayPal payout Monday/);
    expect(screen.queryByRole('button', { name: 'Run payout now' })).toBeNull();
    expect(screen.queryByText('Demo control')).toBeNull();
  });

  it('sent (PENDING): "Sent" pill, PayPal ids, the sent line', async () => {
    renderScreen(fakeApi(withBatch(item({ status: 'PENDING' }))));
    expect(await screen.findAllByText('Sent')).not.toHaveLength(0);
    expect(screen.getByRole('status')).toHaveTextContent('$412.75 sent via PayPal');
    expect(screen.getAllByTitle('PPBATCH0001').length).toBeGreaterThan(0);
  });

  it('paid out (SUCCESS): "Paid out" pill and no banner', async () => {
    renderScreen(fakeApi(withBatch(item({ status: 'SUCCESS', feeCents: 25 }))));
    expect(await screen.findAllByText('Paid out')).not.toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/sent via PayPal/)).toBeNull();
  });

  it('unclaimed: "Waiting for you to claim" and the claim warning', async () => {
    renderScreen(fakeApi(withBatch(item({ status: 'UNCLAIMED' }))));
    expect(await screen.findAllByText('Waiting for you to claim')).not.toHaveLength(0);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(
      `PayPal sent $412.75 to ${EMAIL}, which has no PayPal account yet.`,
    );
    expect(alert).toHaveTextContent(`Log in to PayPal with ${EMAIL} to claim it.`);
  });

  it('failed: "Failed → retrying next batch" with the reason', async () => {
    renderScreen(fakeApi(withBatch(item({ status: 'FAILED', errorCode: 'SELF_PAY_NOT_ALLOWED' }))));
    expect(await screen.findAllByText('Failed → retrying next batch')).not.toHaveLength(0);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('PayPal won’t pay the platform’s own account');
    expect(alert).toHaveTextContent('back in your payable balance; retrying next batch');
    expect(alert).not.toHaveTextContent(/paid out|sent via/i);
  });

  it('failed with INSUFFICIENT_FUNDS: SP-020 alert copy', async () => {
    renderScreen(fakeApi(withBatch(item({ status: 'FAILED', errorCode: 'INSUFFICIENT_FUNDS' }))));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Fund the sandbox merchant or lower the demo threshold',
    );
  });

  it('run now → confirm modal numbers → row appears as Sent → SSE flips it to Paid out without reload', async () => {
    const api = fakeApi();
    const sse = renderScreen(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Run payout now' }));

    const dialog = screen.getByRole('dialog', { name: 'Run payout now?' });
    expect(within(dialog).getByText('Demo control')).toBeInTheDocument();
    expect(within(dialog).getByText('Payable').nextSibling).toHaveTextContent('$412.754321');
    expect(within(dialog).getByText('Commission already taken').nextSibling).toHaveTextContent(
      '$103.18858',
    );
    expect(within(dialog).getByText('Net via PayPal').nextSibling).toHaveTextContent('$412.75');
    expect(within(dialog).getByText('Threshold').nextSibling).toHaveTextContent('$1 demo');

    // A double click sends one request with an Idempotency-Key.
    const confirm = within(dialog).getByRole('button', { name: 'Pay out $412.75 via PayPal' });
    await userEvent.dblClick(confirm);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const posts = api.fetch.mock.calls.filter(([, init]) => init.method === 'POST');
    expect(posts).toHaveLength(1);
    expect((posts[0]![1].headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();

    expect(await screen.findAllByText('Sent')).not.toHaveLength(0);
    expect(screen.getAllByTitle('PPBATCH0001').length).toBeGreaterThan(0);
    const getsBefore = api.fetch.mock.calls.length;

    // PayPal settles; SP-021's poller emits payout.updated.
    api.state.payouts = {
      ...api.state.payouts,
      next: { ...api.state.payouts.next, inFlightCents: 0 },
      batches: [batch(item({ status: 'SUCCESS', feeCents: 25 }), { status: 'SUCCESS' })],
    };
    act(() => sse.emit('payout.updated', { ids: [BATCH] }));
    expect(await screen.findAllByText('Paid out')).not.toHaveLength(0);
    expect(screen.queryByText('Sent')).toBeNull();
    expect(api.fetch.mock.calls.length).toBeGreaterThan(getsBefore);
  });

  it('an open statement drawer follows a refetch: Sent → Paid out with the new PayPal ids', async () => {
    const api = fakeApi(withBatch(item({ status: 'PENDING', paypalItemId: null })));
    const sse = renderScreen(api);
    await screen.findAllByText('Sent');
    await userEvent.click(screen.getAllByRole('button', { name: 'Statement' })[0]!);
    const drawer = screen.getByRole('dialog', { name: 'Statement' });
    expect(drawer).toHaveTextContent('$412.75 sent via PayPal');

    api.state.payouts = {
      ...api.state.payouts,
      batches: [
        batch(item({ status: 'SUCCESS', paypalItemId: 'PPITEM0001', feeCents: 25 }), {
          status: 'SUCCESS',
        }),
      ],
    };
    act(() => sse.emit('payout.updated', { ids: [BATCH] }));
    await waitFor(() => expect(drawer).toHaveTextContent('$412.75 paid out via PayPal'));
    expect(within(drawer).getByText('Paid out')).toBeInTheDocument();
    expect(drawer).not.toHaveTextContent('sent via PayPal');
    expect(within(drawer).getByTitle('PPITEM0001')).toBeInTheDocument();
    expect(within(drawer).getByText('PayPal fee (paid by Spigot)')).toBeInTheDocument();
  });

  it('the statement drawer closes when a refetch no longer lists its item', async () => {
    const api = fakeApi(withBatch(item({ status: 'PENDING' })));
    const sse = renderScreen(api);
    await screen.findAllByText('Sent');
    await userEvent.click(screen.getAllByRole('button', { name: 'Statement' })[0]!);
    expect(screen.getByRole('dialog', { name: 'Statement' })).toBeInTheDocument();
    api.state.payouts = { ...api.state.payouts, batches: [] };
    act(() => sse.emit('payout.updated', { ids: [BATCH] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('sent rows are re-read on a poll even if an SSE event is missed', async () => {
    const api = fakeApi(withBatch(item({ status: 'PENDING' })));
    renderScreen(api, fakeSse(), 50);
    await screen.findAllByText('Sent');
    api.state.payouts = { ...api.state.payouts, batches: [batch(item({ status: 'SUCCESS' }))] };
    expect(await screen.findAllByText('Paid out', {}, { timeout: 2000 })).not.toHaveLength(0);
  });

  it('run now refused with INSUFFICIENT_FUNDS: alert copy, money back in payable', async () => {
    const api = fakeApi({
      run: () =>
        json(200, {
          demoControl: true,
          outcome: 'FAILED',
          errorCode: 'INSUFFICIENT_FUNDS',
          batchId: BATCH,
          resumed: false,
          items: [{ id: ITEM, netCents: 41_275 }],
        }),
    });
    renderScreen(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Run payout now' }));
    await userEvent.click(screen.getByRole('button', { name: 'Pay out $412.75 via PayPal' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Fund the sandbox merchant or lower the demo threshold');
    expect(alert).toHaveTextContent('back in your payable balance');
  });

  it('run now with nothing to pay keeps the modal open and says so', async () => {
    const api = fakeApi({
      run: () =>
        json(200, {
          demoControl: true,
          outcome: 'NO_ITEMS',
          batchId: null,
          resumed: false,
          items: [],
        }),
    });
    renderScreen(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Run payout now' }));
    await userEvent.click(screen.getByRole('button', { name: 'Pay out $412.75 via PayPal' }));
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent(
      'Nothing to pay out right now',
    );
  });

  it('run now is blocked while a payout is in flight', async () => {
    renderScreen(
      fakeApi({
        payouts: {
          isDemo: true,
          next: { ...NEXT, payableCents: 0, payableMicros: 0, inFlightCents: 41_275 },
          batches: [batch(item())],
        },
      }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Run payout now' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('status')).toHaveTextContent('already on its way via PayPal');
    expect(within(dialog).getByRole('button', { name: /via PayPal$/ })).toBeDisabled();
  });

  it('a payout covering SIM charges shows the SIM chip and the SIM share in its statement', async () => {
    const sim: Statement = { ...STATEMENT, simGrossMicros: 480_000_000, simRecords: 7600 };
    renderScreen(
      fakeApi({
        payouts: { isDemo: true, next: NEXT, batches: [batch(item({ status: 'SUCCESS' }))] },
        statements: { next: STATEMENT, items: { [ITEM]: sim } },
      }),
    );
    const chip = await waitFor(() => {
      const el = document.querySelector('[data-sim-chip]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(chip).toHaveTextContent('SIM');
    expect(chip.getAttribute('title')).toMatch(/incl\. \$480(\.00)? \/ 7,600 records simulated/);
    expect(chip.getAttribute('title')).toMatch(/real money sent via PayPal/);

    await userEvent.click(screen.getAllByRole('button', { name: 'Statement' })[0]!);
    const drawer = screen.getByRole('dialog', { name: 'Statement' });
    expect(within(drawer).getByText('Records sold').nextSibling).toHaveTextContent('8,112');
    expect(within(drawer).getByText('Rounding carried forward').nextSibling).toHaveTextContent(
      '$0.004321',
    );
    expect(within(drawer).getByText(/7,600 records simulated/)).toHaveTextContent(
      /incl\. \$480(\.00)? \/ 7,600 records simulated/,
    );
    expect(drawer).toHaveTextContent('$412.75 paid out via PayPal');
  });

  it('a payout without SIM charges has no chip', async () => {
    renderScreen(fakeApi(withBatch(item({ status: 'SUCCESS' }))));
    await screen.findAllByText('Paid out');
    expect(document.querySelector('[data-sim-chip]')).toBeNull();
  });

  it('the bundled fixtures render (fixture mode shape check)', async () => {
    renderScreen(
      fakeApi({
        payouts: payoutsFixture as PublisherPayouts,
        statements: statementsFixture as PayoutStatements,
      }),
    );
    expect(await screen.findAllByText('Paid out')).not.toHaveLength(0);
    expect(document.querySelector('[data-sim-chip]')).not.toBeNull();
  });
});
