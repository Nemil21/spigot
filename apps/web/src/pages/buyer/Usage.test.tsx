import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient, type FetchLike } from '../../api/client';
import callFixture from '../../fixtures/api/buyer/calls/_.json';
import claimsFixture from '../../fixtures/api/buyer/claims.json';
import refundsFixture from '../../fixtures/api/buyer/refunds.json';
import usageFixture from '../../fixtures/api/buyer/usage.json';
import { parseCents } from './RefundCard';
import { UsageScreen, W12_COPY } from './Usage';
import type { BuyerClaim, CallDetail, RefundView, RefundsResponse, UsagePage } from './usageModel';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const CALL = callFixture as CallDetail;
const NOW = Date.parse('2026-11-12T15:00:00.000Z');

interface State {
  usage: UsagePage;
  claims: BuyerClaim[];
  refunds: RefundsResponse;
  call: CallDetail;
  claim: (body: Record<string, unknown>) => Response;
  refund: (body: { amountCents: number }, key: string | null) => Response;
}

/** A fake API: answers W12's endpoints from `state` and records every call. */
function fakeApi(over: Partial<State> = {}) {
  const state: State = {
    usage: structuredClone(usageFixture) as UsagePage,
    claims: [],
    refunds: structuredClone(refundsFixture) as RefundsResponse,
    call: structuredClone(CALL),
    claim: () => json(200, { claimId: 'cl-new', status: 'OPEN', creditMicros: 0 }),
    refund: () => json(500, { error: { code: 'INTERNAL', message: 'not set' } }),
    ...over,
  };
  const fetch = vi.fn<FetchLike>(async (url, init) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (method === 'GET' && url.startsWith('/api/buyer/usage')) return json(200, state.usage);
    if (method === 'GET' && url === '/api/buyer/claims') return json(200, { claims: state.claims });
    if (method === 'GET' && url === '/api/buyer/refunds') return json(200, state.refunds);
    if (method === 'GET' && url.startsWith('/api/buyer/calls/')) return json(200, state.call);
    if (method === 'POST' && url === '/api/buyer/claims') return state.claim(body);
    if (method === 'POST' && url === '/api/buyer/refunds')
      return state.refund(body, headers['Idempotency-Key'] ?? null);
    return json(404, { error: { code: 'NOT_FOUND', message: `no route ${method} ${url}` } });
  });
  return { state, fetch, client: createApiClient({ fetch, fixtures: false }) };
}

const calls = (fetch: ReturnType<typeof fakeApi>['fetch'], method: string, url: string) =>
  fetch.mock.calls.filter(([u, i]) => u === url && (i.method ?? 'GET') === method);

function renderUsage(api: ReturnType<typeof fakeApi>, props: Record<string, unknown> = {}) {
  return render(
    <MemoryRouter>
      <UsageScreen
        client={api.client}
        now={() => NOW}
        refundPollMs={20}
        newIdempotencyKey={() => `key-${Math.random()}`}
        {...props}
      />
    </MemoryRouter>,
  );
}

const claim = (over: Partial<BuyerClaim>): BuyerClaim => ({
  ...(claimsFixture.claims[0] as BuyerClaim),
  ...over,
});

const refund = (over: Partial<RefundView>): RefundView => ({
  refundId: 'rf-1',
  topupId: 'tp-1',
  amountCents: 740,
  status: 'REQUESTED',
  paypalRefundId: null,
  errorCode: null,
  createdAt: '2026-11-12T14:30:00.000Z',
  updatedAt: '2026-11-12T14:30:00.000Z',
  ...over,
});

// AG Grid renders slowly in jsdom on a loaded machine.
describe('W12 Buyer usage & claims', { timeout: 30_000 }, () => {
  it('empty: no calls yet, one action to get a key; no claims', async () => {
    const api = fakeApi({ usage: { rows: [], nextCursor: null } });
    renderUsage(api);
    expect(await screen.findByText(W12_COPY.empty)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Get an API key' })).toHaveAttribute('href', '/buyers');
    expect(await screen.findByText(/No claims\./)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Usage and claims');
  });

  it('grid shows each call: dataset, endpoint, records, charged + credited, channel, replay flag', async () => {
    const api = fakeApi();
    renderUsage(api);
    const row = await screen.findByRole(
      'button',
      {
        name: `Open call ${usageFixture.rows[0]!.id}`,
      },
      { timeout: 10_000 },
    );
    const gridRow = row.closest('[role="row"]') as HTMLElement;
    expect(gridRow).toHaveTextContent('bluebonnet / listings');
    expect(gridRow).toHaveTextContent('records.search');
    expect(gridRow).toHaveTextContent('37');
    expect(gridRow).toHaveTextContent('$0.0555');
    expect(gridRow).toHaveTextContent('$0.0015 credited');
    expect(gridRow).toHaveTextContent('MCP');
    expect(gridRow).toHaveTextContent('Replayable');
    // A changes call shows changes; a zero-record call says it was not charged.
    expect(screen.getByText('28 changes')).toBeInTheDocument();
    expect(screen.getAllByText('Not charged').length).toBeGreaterThan(0);
  });

  it('claim auto-credited: report from the drawer → credited message; list and grid refresh', async () => {
    const api = fakeApi({
      claim: (body) => {
        api.state.claims = [
          claim({
            id: 'cl-auto',
            status: 'AUTO_CREDITED',
            reason: body.reason as BuyerClaim['reason'],
            recordKey: body.recordKey as string,
            creditMicros: 1500,
            decidedBy: 'AUTO',
            note: (body.note as string) ?? null,
          }),
        ];
        return json(200, { claimId: 'cl-auto', status: 'AUTO_CREDITED', creditMicros: 1500 });
      },
    });
    const user = userEvent.setup();
    renderUsage(api);
    await user.click(
      await screen.findByRole(
        'button',
        { name: `Open call ${usageFixture.rows[0]!.id}` },
        { timeout: 10_000 },
      ),
    );
    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('claude-desktop-7f3a')).toBeInTheDocument();
    await user.selectOptions(within(drawer).getByLabelText('Record'), 'listings/3br-mueller-2210');
    await user.selectOptions(
      within(drawer).getByLabelText("What's wrong"),
      'Out of date (the site has changed)',
    );
    await user.type(within(drawer).getByLabelText('Note (optional)'), 'Listing says leased');
    const before = calls(api.fetch, 'GET', '/api/buyer/claims').length;
    await user.click(within(drawer).getByRole('button', { name: 'Report record' }));

    expect(await within(drawer).findByRole('status')).toHaveTextContent(
      'Confirmed. $0.0015 credited to your balance.',
    );
    expect(JSON.parse(calls(api.fetch, 'POST', '/api/buyer/claims')[0]![1].body as string)).toEqual(
      {
        callId: CALL.id,
        recordKey: 'listings/3br-mueller-2210',
        reason: 'STALE',
        note: 'Listing says leased',
      },
    );
    await waitFor(() =>
      expect(calls(api.fetch, 'GET', '/api/buyer/claims').length).toBeGreaterThan(before),
    );
    const list = screen.getByRole('region', { name: 'Claims' });
    const row = await within(list).findByText('listings/3br-mueller-2210');
    const tr = row.closest('tr')!;
    expect(within(tr).getByText('Credited automatically')).toHaveAttribute(
      'data-status',
      'AUTO_CREDITED',
    );
    expect(tr).toHaveTextContent('$0.0015 credited');
    // The claimed record is no longer offered; its status shows in the drawer.
    expect(
      within(within(drawer).getByLabelText('Record')).queryByText('listings/3br-mueller-2210'),
    ).toBeNull();
    expect(within(drawer).getByRole('list', { name: 'Claims on this call' })).toHaveTextContent(
      'listings/3br-mueller-2210',
    );
  });

  it('claim pending publisher: OPEN result says it went to the publisher, list shows "Waiting"', async () => {
    const api = fakeApi({
      claims: [
        claim({
          id: 'cl-open',
          status: 'OPEN',
          creditMicros: 0,
          recordKey: 'listings/1br-zilker-0090',
        }),
      ],
      claim: () => json(200, { claimId: 'cl-2', status: 'OPEN', creditMicros: 0 }),
    });
    const user = userEvent.setup();
    renderUsage(api);
    const list = await screen.findByRole('region', { name: 'Claims' });
    const tr = (await within(list).findByText('listings/1br-zilker-0090')).closest('tr')!;
    expect(within(tr).getByText('Waiting for the publisher')).toHaveAttribute(
      'data-status',
      'OPEN',
    );
    expect(tr).toHaveTextContent('Up to $0.0015 if the publisher agrees');
    expect(tr).not.toHaveTextContent('credited');

    // Opening the call from the claims list; the already-claimed record is not offered again.
    await user.click(within(tr).getByRole('button', { name: /Open the call/ }));
    const drawer = await screen.findByRole('dialog');
    const select = await within(drawer).findByLabelText('Record');
    expect(within(select).queryByText('listings/1br-zilker-0090')).toBeNull();
    await user.click(within(drawer).getByRole('button', { name: 'Report record' }));
    expect(await within(drawer).findByRole('status')).toHaveTextContent(
      "with the publisher. We'll credit $0.0015 if they agree.",
    );
  });

  it('claims: rejected and publisher-credited states; an ineligible claim shows the API reason', async () => {
    const api = fakeApi({
      claims: [
        claim({
          id: 'a',
          status: 'REJECTED',
          recordKey: 'listings/a',
          creditMicros: 0,
          decidedBy: 'PUBLISHER',
        }),
        claim({
          id: 'b',
          status: 'CREDITED',
          recordKey: 'listings/b',
          creditMicros: 1500,
          decidedBy: 'PUBLISHER',
        }),
      ],
      claim: () =>
        json(422, {
          error: {
            code: 'CLAIM_NOT_ELIGIBLE',
            message: 'That record was not in the call’s response.',
          },
        }),
    });
    const user = userEvent.setup();
    renderUsage(api);
    const list = await screen.findByRole('region', { name: 'Claims' });
    expect(await within(list).findByText('Rejected by the publisher')).toBeInTheDocument();
    expect(within(list).getByText('Not credited')).toBeInTheDocument();
    expect(within(list).getByText('Credited by the publisher')).toBeInTheDocument();

    await user.click(
      await screen.findByRole(
        'button',
        { name: `Open call ${usageFixture.rows[0]!.id}` },
        { timeout: 10_000 },
      ),
    );
    const drawer = await screen.findByRole('dialog');
    await user.click(await within(drawer).findByRole('button', { name: 'Report record' }));
    expect(await within(drawer).findByRole('alert')).toHaveTextContent('not in the call');
  });

  it('a call older than 7 days, or not charged, cannot be reported', async () => {
    const api = fakeApi({ call: { ...structuredClone(CALL), time: '2026-11-01T00:00:00.000Z' } });
    const user = userEvent.setup();
    renderUsage(api);
    await user.click(
      await screen.findByRole(
        'button',
        { name: `Open call ${usageFixture.rows[0]!.id}` },
        { timeout: 10_000 },
      ),
    );
    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText(/within 7 days of the call/)).toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: 'Report record' })).toBeNull();
    await user.click(within(drawer).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    api.state.call = { ...structuredClone(CALL), status: 'NOT_CHARGED', chargedMicros: 0 };
    await user.click(screen.getByRole('button', { name: `Open call ${usageFixture.rows[0]!.id}` }));
    expect(
      await within(await screen.findByRole('dialog')).findByText(/was not charged/),
    ).toBeInTheDocument();
  });

  describe('Refund unused balance to PayPal', () => {
    it('shows the allowed amount and why it is below the balance', async () => {
      renderUsage(fakeApi());
      const card = await screen.findByRole('region', { name: 'Refund unused balance to PayPal' });
      expect(
        await within(card).findByText(/You can get \$15 back to the PayPal account/),
      ).toBeInTheDocument();
      expect(within(card).getByText(/Only \$15 of your \$19\.94 balance/)).toBeInTheDocument();
      expect(within(card).getByLabelText('Amount (USD)')).toHaveValue('15.00');
      // A past refund that completed is worded "refunded to PayPal" with its PayPal id.
      expect(within(card).getByText('$5 refunded to PayPal')).toBeInTheDocument();
    });

    it('nothing refundable (balance from credits): no form, the reason is explained', async () => {
      renderUsage(
        fakeApi({
          refunds: {
            refunds: [],
            available: { balanceCents: 3, refundableCents: 0, allowedCents: 0 },
          },
        }),
      );
      const card = await screen.findByRole('region', { name: 'Refund unused balance to PayPal' });
      expect(
        await within(card).findByText('Nothing to refund to PayPal right now.'),
      ).toBeInTheDocument();
      expect(within(card).getByText(/came from credits/)).toBeInTheDocument();
      expect(within(card).queryByRole('button', { name: 'Refund to PayPal' })).toBeNull();
    });

    it('refund requested → polls → completed: "refunded to PayPal" only once PayPal confirms', async () => {
      const keys: (string | null)[] = [];
      const api = fakeApi({
        refunds: {
          refunds: [],
          available: { balanceCents: 1994, refundableCents: 2000, allowedCents: 1994 },
        },
        refund: (body, key) => {
          keys.push(key);
          const r = refund({ amountCents: body.amountCents, status: 'PENDING' });
          api.state.refunds = {
            refunds: [r],
            available: {
              balanceCents: 1994 - body.amountCents,
              refundableCents: 2000 - body.amountCents,
              allowedCents: 1994 - body.amountCents,
            },
          };
          return json(201, {
            refunds: [r],
            totalCents: body.amountCents,
            balanceMicros: 12_540_000,
            autoTopupDisabled: false,
          });
        },
      });
      const user = userEvent.setup();
      renderUsage(api);
      const card = await screen.findByRole('region', { name: 'Refund unused balance to PayPal' });
      const input = await within(card).findByLabelText('Amount (USD)');
      await user.clear(input);
      await user.type(input, '7.40');
      await user.click(within(card).getByRole('button', { name: 'Refund to PayPal' }));

      expect(await within(card).findByRole('status')).toHaveTextContent(
        'Refund of $7.40 requested.',
      );
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatch(/^key-/);
      const item = await within(card).findByText('$7.40 refund requested; waiting for PayPal');
      expect(within(card).queryByText('$7.40 refunded to PayPal')).toBeNull();
      expect(item.closest('li')!.querySelector('[data-status]')).toHaveAttribute(
        'data-status',
        'PENDING',
      );

      // PayPal settles it (webhook / poll on the server); the card's poll picks it up.
      const usageReads = calls(api.fetch, 'GET', '/api/buyer/usage').length;
      act(() => {
        api.state.refunds = {
          ...api.state.refunds,
          refunds: [refund({ status: 'COMPLETED', paypalRefundId: '1JU0REFUND' })],
        };
      });
      expect(await within(card).findByText('$7.40 refunded to PayPal')).toBeInTheDocument();
      expect(within(card).getByText('Refunded to PayPal')).toHaveAttribute(
        'data-status',
        'COMPLETED',
      );
      await waitFor(() =>
        expect(calls(api.fetch, 'GET', '/api/buyer/usage').length).toBeGreaterThan(usageReads),
      );
    });

    it('full cash-out completes at once and says auto top-up is off', async () => {
      const api = fakeApi({
        refunds: {
          refunds: [],
          available: { balanceCents: 1500, refundableCents: 1500, allowedCents: 1500 },
        },
        refund: (body) => {
          const r = refund({
            amountCents: body.amountCents,
            status: 'COMPLETED',
            paypalRefundId: 'RF-9',
          });
          api.state.refunds = {
            refunds: [r],
            available: { balanceCents: 0, refundableCents: 0, allowedCents: 0 },
          };
          return json(201, {
            refunds: [r],
            totalCents: 1500,
            balanceMicros: 0,
            autoTopupDisabled: true,
          });
        },
      });
      const user = userEvent.setup();
      renderUsage(api);
      const card = await screen.findByRole('region', { name: 'Refund unused balance to PayPal' });
      await user.click(await within(card).findByRole('button', { name: 'Refund to PayPal' }));
      expect(await within(card).findByRole('status')).toHaveTextContent(
        '$15 refunded to PayPal. Auto top-up is now off.',
      );
      expect(
        await within(card).findByText('Nothing to refund to PayPal right now.'),
      ).toBeInTheDocument();
    });

    it('a retried click after a timeout reuses its Idempotency-Key (never refunds twice)', async () => {
      const keys: (string | null)[] = [];
      let n = 0;
      const api = fakeApi({
        refund: (body, key) => {
          keys.push(key);
          if (++n === 1)
            return json(503, { error: { code: 'INTERNAL', message: 'PayPal timed out.' } });
          const r = refund({ amountCents: body.amountCents, status: 'COMPLETED' });
          return json(201, {
            refunds: [r],
            totalCents: body.amountCents,
            balanceMicros: 0,
            autoTopupDisabled: false,
          });
        },
      });
      const user = userEvent.setup();
      let seq = 0;
      renderUsage(api, { newIdempotencyKey: () => `k${++seq}` });
      const card = await screen.findByRole('region', { name: 'Refund unused balance to PayPal' });
      await user.click(await within(card).findByRole('button', { name: 'Refund to PayPal' }));
      expect(await within(card).findByRole('alert')).toHaveTextContent('PayPal timed out.');
      await user.click(within(card).getByRole('button', { name: 'Refund to PayPal' }));
      expect(await within(card).findByRole('status')).toHaveTextContent('refunded to PayPal');
      expect(keys).toEqual(['k1', 'k1']);
    });

    it('rejects an amount above the allowed one before calling PayPal; maps REFUND_EXCEEDS_UNUSED', async () => {
      const api = fakeApi({
        refund: () =>
          json(422, {
            error: {
              code: 'REFUND_EXCEEDS_UNUSED',
              message: 'You can refund up to $10 to PayPal.',
            },
          }),
      });
      const user = userEvent.setup();
      renderUsage(api);
      const card = await screen.findByRole('region', { name: 'Refund unused balance to PayPal' });
      const input = await within(card).findByLabelText('Amount (USD)');
      await user.clear(input);
      await user.type(input, '99');
      await user.click(within(card).getByRole('button', { name: 'Refund to PayPal' }));
      expect(await within(card).findByRole('alert')).toHaveTextContent('up to $15');
      expect(calls(api.fetch, 'POST', '/api/buyer/refunds')).toHaveLength(0);

      await user.clear(input);
      await user.type(input, '12');
      await user.click(within(card).getByRole('button', { name: 'Refund to PayPal' }));
      expect(await within(card).findByRole('alert')).toHaveTextContent('up to $10');
    });
  });

  it('parseCents', () => {
    expect(parseCents('7.4')).toBe(740);
    expect(parseCents('$7.40')).toBe(740);
    expect(parseCents('12')).toBe(1200);
    expect(parseCents('0.05')).toBe(5);
    expect(parseCents('7.405')).toBeNull();
    expect(parseCents('abc')).toBeNull();
  });
});
