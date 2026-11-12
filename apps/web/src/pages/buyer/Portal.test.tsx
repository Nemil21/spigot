import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient, type FetchLike } from '../../api/client';
import type { LoadCardFieldsSdk } from '../../components/buyer/cardFieldsSdk';
import { claudeDesktopConfig } from '../../components/buyer/ClaudeConfig';
import type {
  LoadPayPalSdk,
  OneTimeSessionOptions,
  PayPalSdk,
} from '../../components/buyer/paypalSdk';
import balanceFixture from '../../fixtures/api/buyer/balance.json';
import keysFixture from '../../fixtures/api/buyer/keys.json';
import topupsFixture from '../../fixtures/api/buyer/topups.json';
import { BuyerPortal } from './Portal';
import { BuyerSignUp } from './SignUp';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const ORDER_ID = '5O190127TN364715T';
const TOPUP_ID = '00000000-0000-4000-8000-0000000009aa';
const SANDBOX = { clientId: 'sb-client-id', environment: 'sandbox' as const };

interface ApiState {
  balanceMicros: number;
  topups: unknown[];
  keys: unknown[];
  paypal: { clientId: string | null; environment: 'sandbox' | 'production' };
  capture: () => Response;
  failLoad?: boolean;
  savedMethod?: { kind: 'CARD' | 'PAYPAL'; label: string } | null;
}

/** A fake API: answers the portal's endpoints from `state` and records every call. */
function fakeApi(over: Partial<ApiState> = {}) {
  const state: ApiState = {
    balanceMicros: 0,
    topups: [],
    keys: [],
    paypal: SANDBOX,
    capture: () => {
      state.balanceMicros += 20_000_000;
      return json(200, {
        topupId: TOPUP_ID,
        status: 'COMPLETED',
        balanceMicros: state.balanceMicros,
        captureId: 'CAP-1',
      });
    },
    ...over,
  };
  const fetch = vi.fn<FetchLike>(async (url, init) => {
    const method = init.method ?? 'GET';
    if (state.failLoad && method === 'GET') {
      return json(500, { error: { code: 'INTERNAL', message: 'Database is down.' } });
    }
    if (method === 'GET' && url === '/api/buyer/balance')
      return json(200, { balanceMicros: state.balanceMicros });
    if (method === 'GET' && url === '/api/buyer/topups') return json(200, { topups: state.topups });
    if (method === 'GET' && url === '/api/buyer/keys') return json(200, { keys: state.keys });
    if (method === 'GET' && url === '/api/buyer/paypal-config') return json(200, state.paypal);
    if (method === 'GET' && url === '/api/buyer/payment-method')
      return json(200, { savedMethod: state.savedMethod ?? null });
    if (method === 'POST' && url === '/api/buyer/topups') {
      return json(201, { topupId: TOPUP_ID, status: 'AWAITING_APPROVAL', orderId: ORDER_ID });
    }
    if (method === 'POST' && url === `/api/buyer/topups/${TOPUP_ID}/capture`)
      return state.capture();
    if (method === 'POST' && url === '/api/buyer/keys') {
      const k = {
        id: 'k-new',
        name: 'Claude Desktop',
        prefix: 'AbCd1234',
        scopes: ['read', 'topup'],
        lastUsedAt: null,
        revokedAt: null,
        createdAt: '2026-11-12T10:00:00.000Z',
      };
      state.keys = [k, ...state.keys];
      return json(201, { ...k, key: 'sk_spg_AbCd1234restOfTheSecretKeyBody0123' });
    }
    if (method === 'DELETE' && url.startsWith('/api/buyer/keys/')) {
      const id = decodeURIComponent(url.split('/').pop()!);
      state.keys = state.keys.map((k) =>
        (k as { id: string }).id === id
          ? { ...(k as object), revokedAt: '2026-11-12T10:05:00.000Z' }
          : k,
      );
      return json(200, { key: state.keys.find((k) => (k as { id: string }).id === id) });
    }
    return json(404, { error: { code: 'NOT_FOUND', message: `no route ${method} ${url}` } });
  });
  return { state, fetch, client: createApiClient({ fetch, fixtures: false }) };
}

/**
 * A fake JS SDK v6: `start()` awaits our order like PayPal does, then the "buyer" approves or
 * cancels in the (here imaginary) PayPal window.
 */
function fakeSdk(outcome: 'approve' | 'cancel' | 'manual' = 'approve') {
  const started: string[] = [];
  let options: OneTimeSessionOptions | null = null;
  const sdk: PayPalSdk = {
    isPayPalEligible: async () => true,
    createSession(o) {
      options = o;
      return {
        async start(_mode, order) {
          const { orderId } = await order;
          started.push(orderId);
          if (outcome === 'approve') await o.onApprove({ orderId });
          if (outcome === 'cancel') o.onCancel?.({ orderId });
        },
      };
    },
  };
  const loadSdk = vi.fn<LoadPayPalSdk>(async () => sdk);
  return { loadSdk, started, approve: (orderId: string) => options!.onApprove({ orderId }) };
}

/** SP-063's card fields, not offered here: these tests drive the PayPal button. */
const noCardFields: LoadCardFieldsSdk = async () => ({
  isCardFieldsEligible: async () => false,
  createSession: () => {
    throw new Error('not eligible');
  },
});

function renderPortal(
  client: ReturnType<typeof fakeApi>['client'],
  loadSdk: LoadPayPalSdk,
  entry = '/buyers',
) {
  const element = (
    <BuyerPortal
      client={client}
      loadSdk={loadSdk}
      loadCardSdk={noCardFields}
      origin="https://spigot.example"
    />
  );
  const router = createMemoryRouter(
    [
      { path: '/buyers', element },
      { path: '/buyers/topup/:topupId', element },
    ],
    { initialEntries: [entry] },
  );
  return render(<RouterProvider router={router} />);
}

const balanceText = () => screen.getByTestId('balance-amount');
const paypalButton = () => screen.findByTestId('paypal-button');
const postsTo = (fetch: ReturnType<typeof fakeApi>['fetch'], url: string) =>
  fetch.mock.calls.filter(([u, i]) => u === url && i.method === 'POST');

describe('W11 buyer portal', () => {
  it('shows the balance with micros tooltip, top-ups, keys and the Claude Desktop config', async () => {
    const api = fakeApi({
      balanceMicros: balanceFixture.balanceMicros,
      topups: topupsFixture.topups,
      keys: keysFixture.keys,
    });
    renderPortal(api.client, fakeSdk().loadSdk);

    await waitFor(() => expect(balanceText()).toHaveTextContent('$19.94'));
    expect(balanceText()).toHaveAttribute('title', '19,940,000 micros');
    expect(screen.getByText('$19.94 balance')).toBeInTheDocument(); // screen-reader line

    const topups = within(screen.getByRole('region', { name: 'Top-ups' }));
    for (const trigger of ['MANUAL', 'MCP', 'SIM'])
      expect(topups.getByText(trigger)).toBeInTheDocument();
    expect(topups.getByTitle('5O190127TN364715T')).toBeInTheDocument();
    expect(topups.getByTitle('3C679366HH908993F')).toBeInTheDocument();
    expect(topups.getAllByText('Added via PayPal')).toHaveLength(2);
    expect(topups.getByText('Not approved in PayPal')).toBeInTheDocument();

    const keys = within(screen.getByRole('region', { name: 'API keys' }));
    expect(keys.getByText('sk_spg_4kQ9xT2m…')).toBeInTheDocument();
    expect(keys.getByText(/^Revoked/)).toBeInTheDocument();

    const config = screen.getByTestId('claude-config').textContent!;
    expect(JSON.parse(config.replace('sk_spg_4kQ9xT2m…', 'KEY'))).toEqual({
      mcpServers: {
        spigot: {
          command: 'npx',
          args: [
            '-y',
            'mcp-remote',
            'https://spigot.example/mcp',
            '--header',
            'Authorization: Bearer KEY',
          ],
        },
      },
    });
    expect(screen.queryByText(/Your balance is empty/)).not.toBeInTheDocument();
  });

  it('no balance: CTA; Top up $20 with PayPal → approve → $20.00 without a reload', async () => {
    const api = fakeApi();
    const sdk = fakeSdk('approve');
    renderPortal(api.client, sdk.loadSdk);

    expect(await screen.findByText(/Your balance is empty/)).toBeInTheDocument();
    expect(balanceText()).toHaveTextContent('$0.00');
    // The SDK loads from an effect that can run after the empty-balance copy renders.
    await waitFor(() => expect(sdk.loadSdk).toHaveBeenCalledWith(SANDBOX));
    expect(screen.getByRole('button', { name: '$20' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByLabelText('Save for auto top-up'));

    await userEvent.click(await paypalButton());

    await waitFor(() => expect(balanceText()).toHaveTextContent('$20.00'));
    expect(balanceText()).toHaveAttribute('data-micros', '20000000');
    expect(screen.getByText('$20 added via PayPal.')).toBeInTheDocument();
    expect(sdk.started).toEqual([ORDER_ID]);

    const [create] = postsTo(api.fetch, '/api/buyer/topups');
    expect(JSON.parse(create![1].body as string)).toEqual({
      amountCents: 2000,
      method: 'PAYPAL_WALLET',
      saveForAutoTopup: true,
    });
    expect((create![1].headers as Record<string, string>)['Idempotency-Key']).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    expect(postsTo(api.fetch, `/api/buyer/topups/${TOPUP_ID}/capture`)).toHaveLength(1);
    // The fetched balance is now what the API says, and the empty-state CTA is gone.
    expect(screen.queryByText(/Your balance is empty/)).not.toBeInTheDocument();
  });

  it('picks another amount chip', async () => {
    const api = fakeApi();
    const sdk = fakeSdk('approve');
    renderPortal(api.client, sdk.loadSdk);
    await userEvent.click(await screen.findByRole('button', { name: '$50' }));
    await userEvent.click(await paypalButton());
    await waitFor(() => expect(postsTo(api.fetch, '/api/buyer/topups')).toHaveLength(1));
    expect(JSON.parse(postsTo(api.fetch, '/api/buyer/topups')[0]![1].body as string)).toMatchObject(
      {
        amountCents: 5000,
        saveForAutoTopup: false,
      },
    );
  });

  it('approving: tells the buyer to approve in PayPal; a second click creates no second order', async () => {
    const api = fakeApi();
    const sdk = fakeSdk('manual');
    renderPortal(api.client, sdk.loadSdk);
    const button = await paypalButton();
    await userEvent.click(button);
    await userEvent.click(button);
    expect(await screen.findByText('Approve $20 in the PayPal window.')).toBeInTheDocument();
    await waitFor(() => expect(sdk.started).toEqual([ORDER_ID]));
    expect(postsTo(api.fetch, '/api/buyer/topups')).toHaveLength(1);

    await sdk.approve(ORDER_ID);
    await waitFor(() => expect(balanceText()).toHaveTextContent('$20.00'));
  });

  it('declined: "PayPal couldn\'t complete this payment"; balance unchanged', async () => {
    const api = fakeApi({
      capture: () =>
        json(422, {
          error: { code: 'TOPUP_FAILED', message: 'PayPal declined this payment.', details: {} },
        }),
    });
    renderPortal(api.client, fakeSdk('approve').loadSdk);
    await userEvent.click(await paypalButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "PayPal couldn't complete this payment",
    );
    expect(balanceText()).toHaveTextContent('$0.00');
    expect(await paypalButton()).not.toHaveAttribute('disabled');
  });

  it('cancelled in PayPal: nothing taken, the button works again', async () => {
    const api = fakeApi();
    renderPortal(api.client, fakeSdk('cancel').loadSdk);
    await userEvent.click(await paypalButton());
    expect(
      await screen.findByText('Not approved in PayPal. Nothing was taken.'),
    ).toBeInTheDocument();
    expect(postsTo(api.fetch, `/api/buyer/topups/${TOPUP_ID}/capture`)).toHaveLength(0);
  });

  it('capture still PENDING at PayPal: no credit, says so', async () => {
    const api = fakeApi({
      capture: () =>
        json(200, { topupId: TOPUP_ID, status: 'AWAITING_APPROVAL', pendingReason: 'OTHER' }),
    });
    renderPortal(api.client, fakeSdk('approve').loadSdk);
    await userEvent.click(await paypalButton());
    expect(await screen.findByText(/PayPal is still processing this payment/)).toBeInTheDocument();
    expect(balanceText()).toHaveTextContent('$0.00');
  });

  it('PayPal stubbed on the server (no client id): no SDK load, explains why', async () => {
    const api = fakeApi({ paypal: { clientId: null, environment: 'sandbox' } });
    const sdk = fakeSdk();
    renderPortal(api.client, sdk.loadSdk);
    expect(await screen.findByText(/needs the PayPal sandbox/)).toBeInTheDocument();
    expect(sdk.loadSdk).not.toHaveBeenCalled();
    expect(screen.queryByTestId('paypal-button')).not.toBeInTheDocument();
  });

  it('API key: shown once (and in the Claude config), then only its prefix; revoke', async () => {
    const api = fakeApi();
    renderPortal(api.client, fakeSdk().loadSdk);
    await userEvent.click(await screen.findByRole('button', { name: 'Create key' }));

    const secret = 'sk_spg_AbCd1234restOfTheSecretKeyBody0123';
    expect(await screen.findByTestId('revealed-key')).toHaveTextContent(secret);
    expect(screen.getByText('Copy this key now. We only show it once.')).toBeInTheDocument();
    expect(screen.getByTestId('claude-config')).toHaveTextContent(
      `Authorization: Bearer ${secret}`,
    );
    expect(JSON.parse(postsTo(api.fetch, '/api/buyer/keys')[0]![1].body as string)).toEqual({
      name: 'Claude Desktop',
      scopes: ['read', 'topup'],
    });

    await userEvent.click(screen.getByRole('button', { name: 'I saved it' }));
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
    expect(screen.getByTestId('claude-config')).toHaveTextContent(
      'Authorization: Bearer sk_spg_AbCd1234…',
    );
    expect(document.body.textContent).not.toContain(secret);

    await userEvent.click(screen.getByRole('button', { name: /^Revoke Claude Desktop/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes, revoke' }));
    expect(await screen.findByText(/^Revoked/)).toBeInTheDocument();
    expect(
      api.fetch.mock.calls.some(([u, i]) => u === '/api/buyer/keys/k-new' && i.method === 'DELETE'),
    ).toBe(true);
  });

  it('return from an approval link (/buyers/topup/:id?ok=1) confirms the top-up', async () => {
    const api = fakeApi({ balanceMicros: 20_000_000, topups: [topupsFixture.topups[0]] });
    renderPortal(
      api.client,
      fakeSdk().loadSdk,
      '/buyers/topup/00000000-0000-4000-8000-000000000301?ok=1',
    );
    expect(await screen.findByText('$20 added via PayPal.')).toBeInTheDocument();
  });

  it('load error: inline banner with retry', async () => {
    const api = fakeApi({ failLoad: true });
    renderPortal(api.client, fakeSdk().loadSdk);
    expect(await screen.findByText('Database is down.')).toBeInTheDocument();
    api.state.failLoad = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(balanceText()).toHaveTextContent('$0.00'));
  });
  it('shows the saved card from /api/buyer/payment-method next to the card top-up (SP-063)', async () => {
    const api = fakeApi({ savedMethod: { kind: 'CARD', label: 'Visa ••1111' } });
    renderPortal(api.client, fakeSdk('approve').loadSdk);
    expect(await screen.findByRole('heading', { name: 'Top up with a card' })).toBeInTheDocument();
    expect(await screen.findByTestId('saved-method')).toHaveTextContent(
      'Saved for auto top-up: Visa ••1111',
    );
  });
});

describe('claudeDesktopConfig', () => {
  it('is the features/11 §Logic 8 shape', () => {
    expect(JSON.parse(claudeDesktopConfig('https://spigot.onrender.com/mcp', 'sk_spg_x'))).toEqual({
      mcpServers: {
        spigot: {
          command: 'npx',
          args: [
            '-y',
            'mcp-remote',
            'https://spigot.onrender.com/mcp',
            '--header',
            'Authorization: Bearer sk_spg_x',
          ],
        },
      },
    });
  });
});

describe('buyer sign up', () => {
  it('creates the account and opens the portal', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(json(201, { buyerId: 'b1' }));
    const client = createApiClient({ fetch, fixtures: false });
    const router = createMemoryRouter(
      [
        { path: '/buyers/signup', element: <BuyerSignUp client={client} /> },
        { path: '/buyers', element: <h1>Portal</h1> },
      ],
      { initialEntries: ['/buyers/signup'] },
    );
    render(<RouterProvider router={router} />);
    await userEvent.type(screen.getByLabelText('Name'), 'Acme Agents');
    await userEvent.type(screen.getByLabelText('Email'), 'agents@acme.example');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('heading', { name: 'Portal' })).toBeInTheDocument();
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string)).toEqual({
      name: 'Acme Agents',
      email: 'agents@acme.example',
      password: 'correct horse',
    });
  });

  it('says so when the email is taken, and checks the password length first', async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(json(409, { error: { code: 'STATE_CONFLICT', message: 'taken' } }));
    const client = createApiClient({ fetch, fixtures: false });
    const router = createMemoryRouter([{ path: '/', element: <BuyerSignUp client={client} /> }]);
    render(<RouterProvider router={router} />);
    await userEvent.type(screen.getByLabelText('Name'), 'A');
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.example');
    await userEvent.type(screen.getByLabelText('Password'), 'short');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(screen.getByRole('alert')).toHaveTextContent('at least 8 characters');
    expect(fetch).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('Password'), ' enough');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(
      await screen.findByText('That email already has an account. Log in instead.'),
    ).toBeInTheDocument();
  });
});
