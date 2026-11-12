import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient, type FetchLike } from '../api/client';
import type { CardFieldsSdk, CardSubmitResult, LoadCardFieldsSdk } from './buyer/cardFieldsSdk';
import { CardFieldsTopUp, PAY_BY_CARD } from './CardFieldsTopUp';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const ORDER_ID = '7K1234567A890123B';
const TOPUP_ID = '00000000-0000-4000-8000-0000000063aa';
const SANDBOX = { clientId: 'sb-client-id', environment: 'sandbox' as const };

/** A fake API for the card top-up: create → AWAITING_APPROVAL + order, capture → COMPLETED. */
function fakeApi(
  capture: () => Response = () =>
    json(200, {
      topupId: TOPUP_ID,
      status: 'COMPLETED',
      balanceMicros: 20_000_000,
      captureId: 'C1',
    }),
) {
  const fetch = vi.fn<FetchLike>(async (url, init) => {
    if (init.method === 'POST' && url === '/api/buyer/topups') {
      // Slow enough that a second click would land while the first is in flight.
      await new Promise((r) => setTimeout(r, 20));
      return json(201, { topupId: TOPUP_ID, status: 'AWAITING_APPROVAL', orderId: ORDER_ID });
    }
    if (init.method === 'POST' && url === `/api/buyer/topups/${TOPUP_ID}/capture`) return capture();
    return json(404, { error: { code: 'NOT_FOUND', message: url } });
  });
  return { fetch, client: createApiClient({ fetch, fixtures: false }) };
}

const posts = (fetch: ReturnType<typeof fakeApi>['fetch'], url: string) =>
  fetch.mock.calls.filter(([u, i]) => u === url && i.method === 'POST');

/** A fake JS SDK v6 card-fields instance; `submit` answers `result`. */
function fakeSdk(result: CardSubmitResult = { state: 'succeeded', data: { orderId: ORDER_ID } }) {
  const submitted: string[] = [];
  const destroy = vi.fn();
  const sdk: CardFieldsSdk = {
    isCardFieldsEligible: async () => true,
    createSession: () => ({
      createField: ({ type, placeholder }) => {
        const el = document.createElement('input');
        el.setAttribute('data-paypal-field', type);
        el.placeholder = placeholder;
        return el;
      },
      submit: async (orderId) => {
        submitted.push(orderId);
        return result;
      },
      destroy,
    }),
  };
  const loadSdk = vi.fn<LoadCardFieldsSdk>(async () => sdk);
  return { loadSdk, submitted, destroy };
}

const payButton = () => screen.findByRole('button', { name: /^Pay \$20 by card$/ });

describe('CardFieldsTopUp (SP-063)', () => {
  it('mounts PayPal-hosted fields, then create (CARD, save on) → submit(orderId) → capture → completed', async () => {
    const api = fakeApi();
    const sdk = fakeSdk();
    const onCompleted = vi.fn();
    render(
      <CardFieldsTopUp
        config={SANDBOX}
        client={api.client}
        loadSdk={sdk.loadSdk}
        onCompleted={onCompleted}
      />,
    );
    expect(screen.getByRole('heading', { name: PAY_BY_CARD })).toBeInTheDocument();
    await waitFor(() => expect(document.querySelectorAll('[data-paypal-field]')).toHaveLength(4));
    expect(sdk.loadSdk).toHaveBeenCalledWith(SANDBOX);

    await userEvent.click(await payButton());
    await screen.findByText('$20 added by card via PayPal.');

    const [create] = posts(api.fetch, '/api/buyer/topups');
    expect(JSON.parse(create![1].body as string)).toEqual({
      amountCents: 2000,
      method: 'CARD',
      saveForAutoTopup: true,
    });
    expect((create![1].headers as Record<string, string>)['Idempotency-Key']).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    // The card never goes to our API: only the amount, method and the save choice.
    expect(create![1].body as string).not.toMatch(/4111|number|cvv/i);
    expect(sdk.submitted).toEqual([ORDER_ID]);
    expect(posts(api.fetch, `/api/buyer/topups/${TOPUP_ID}/capture`)).toHaveLength(1);
    expect(onCompleted).toHaveBeenCalledWith({
      topupId: TOPUP_ID,
      balanceMicros: 20_000_000,
      amountCents: 2000,
    });
  });

  it('double click → one top-up, one submit, one capture', async () => {
    const api = fakeApi();
    const sdk = fakeSdk();
    render(
      <CardFieldsTopUp
        config={SANDBOX}
        client={api.client}
        loadSdk={sdk.loadSdk}
        onCompleted={vi.fn()}
      />,
    );
    const button = await payButton();
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.dblClick(button);
    await screen.findByText('$20 added by card via PayPal.');
    expect(posts(api.fetch, '/api/buyer/topups')).toHaveLength(1);
    expect(sdk.submitted).toHaveLength(1);
    expect(posts(api.fetch, `/api/buyer/topups/${TOPUP_ID}/capture`)).toHaveLength(1);
  });

  it('unticked "save" → saveForAutoTopup false; other amount chips', async () => {
    const api = fakeApi();
    const sdk = fakeSdk();
    render(
      <CardFieldsTopUp
        config={SANDBOX}
        client={api.client}
        loadSdk={sdk.loadSdk}
        onCompleted={vi.fn()}
      />,
    );
    await payButton();
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeEnabled());
    await userEvent.click(screen.getByRole('checkbox', { name: /save this card/i }));
    await userEvent.click(screen.getByRole('button', { name: '$5 by card' }));
    await userEvent.click(screen.getByRole('button', { name: 'Pay $5 by card' }));
    await screen.findByText(/added by card/);
    expect(JSON.parse(posts(api.fetch, '/api/buyer/topups')[0]![1].body as string)).toEqual({
      amountCents: 500,
      method: 'CARD',
      saveForAutoTopup: false,
    });
  });

  it('a failed submit (declined / invalid card) → declined copy, never captured', async () => {
    const api = fakeApi();
    const sdk = fakeSdk({ state: 'failed', data: { message: 'Card declined' } });
    const onCompleted = vi.fn();
    render(
      <CardFieldsTopUp
        config={SANDBOX}
        client={api.client}
        loadSdk={sdk.loadSdk}
        onCompleted={onCompleted}
      />,
    );
    await userEvent.click(await payButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(/Card declined/);
    expect(posts(api.fetch, `/api/buyer/topups/${TOPUP_ID}/capture`)).toHaveLength(0);
    expect(onCompleted).not.toHaveBeenCalled();
    // The button is usable again for a corrected card.
    await waitFor(async () => expect(await payButton()).toBeEnabled());
  });

  it('a cancelled 3DS → "nothing was taken", never captured', async () => {
    const api = fakeApi();
    const sdk = fakeSdk({ state: 'canceled' });
    render(
      <CardFieldsTopUp
        config={SANDBOX}
        client={api.client}
        loadSdk={sdk.loadSdk}
        onCompleted={vi.fn()}
      />,
    );
    await userEvent.click(await payButton());
    expect(await screen.findByText(/Nothing was taken/)).toBeInTheDocument();
    expect(posts(api.fetch, `/api/buyer/topups/${TOPUP_ID}/capture`)).toHaveLength(0);
  });

  it('capture declined by PayPal (422 TOPUP_FAILED) → declined copy', async () => {
    const api = fakeApi(() =>
      json(422, { error: { code: 'TOPUP_FAILED', message: 'PayPal declined this payment.' } }),
    );
    const sdk = fakeSdk();
    render(
      <CardFieldsTopUp
        config={SANDBOX}
        client={api.client}
        loadSdk={sdk.loadSdk}
        onCompleted={vi.fn()}
      />,
    );
    await userEvent.click(await payButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(/try another card/);
  });

  it('stub mode (no client id) → explains the sandbox is needed; SDK never loaded', async () => {
    const sdk = fakeSdk();
    render(
      <CardFieldsTopUp
        config={{ clientId: null, environment: 'sandbox' }}
        loadSdk={sdk.loadSdk}
        onCompleted={vi.fn()}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(/PayPal sandbox/);
    expect(screen.getByRole('button', { name: 'Pay $20 by card' })).toBeDisabled();
    expect(sdk.loadSdk).not.toHaveBeenCalled();
  });

  it('not eligible for advanced cards → unavailable; the saved method still shows', async () => {
    const loadSdk = vi.fn<LoadCardFieldsSdk>(async () => ({
      isCardFieldsEligible: async () => false,
      createSession: () => {
        throw new Error('unreachable');
      },
    }));
    render(
      <CardFieldsTopUp
        config={SANDBOX}
        loadSdk={loadSdk}
        savedMethod={{ kind: 'CARD', label: 'Visa ••1111' }}
        onCompleted={vi.fn()}
      />,
    );
    expect(await screen.findByRole('status')).toHaveTextContent(/not available/);
    expect(screen.getByTestId('saved-method')).toHaveTextContent(
      'Saved for auto top-up: Visa ••1111',
    );
  });

  it('destroys the card-fields session on unmount', async () => {
    const sdk = fakeSdk();
    const { unmount } = render(
      <CardFieldsTopUp config={SANDBOX} loadSdk={sdk.loadSdk} onCompleted={vi.fn()} />,
    );
    await waitFor(() => expect(document.querySelectorAll('[data-paypal-field]')).toHaveLength(4));
    unmount();
    expect(sdk.destroy).toHaveBeenCalled();
  });
});
