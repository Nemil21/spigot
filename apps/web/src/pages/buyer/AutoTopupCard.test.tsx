import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient, type FetchLike } from '../../api/client';
import fixture from '../../fixtures/api/buyer/auto-topup.json';
import { AutoTopupCard, dollarsToCents, type AutoTopupSettings } from './AutoTopupCard';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const SETTINGS = fixture as AutoTopupSettings;

/** A fake API for `GET` / `PUT /api/buyer/auto-topup`. */
function fakeApi(
  initial: Partial<AutoTopupSettings> = {},
  put: (body: Record<string, unknown>, s: AutoTopupSettings) => Response = (body, s) =>
    json(200, { ...s, ...body, declinedAt: null }),
) {
  let state: AutoTopupSettings = { ...SETTINGS, ...initial };
  const puts: Record<string, unknown>[] = [];
  const fetch = vi.fn<FetchLike>(async (url, init) => {
    if (url !== '/api/buyer/auto-topup')
      return json(404, { error: { code: 'NOT_FOUND', message: 'x' } });
    if ((init.method ?? 'GET') === 'GET') return json(200, state);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    puts.push(body);
    const res = put(body, state);
    if (res.ok) state = (await res.clone().json()) as AutoTopupSettings;
    return res;
  });
  return { puts, client: createApiClient({ fetch, fixtures: false }) };
}

describe('W11 auto top-up card (SP-047b)', () => {
  it('shows the settings, saved method and what is left this month', async () => {
    const { client } = fakeApi();
    render(<AutoTopupCard client={client} />);
    expect(await screen.findByText('Visa ••1111')).toBeInTheDocument();
    expect(screen.getByText('$80 left of $100')).toBeInTheDocument();
    expect(screen.getByLabelText('Top up automatically')).toBeChecked();
    expect(screen.getByLabelText('Amount ($)')).toHaveValue('20');
    expect(screen.getByLabelText('When below ($)')).toHaveValue('2');
    expect(screen.getByLabelText('Monthly cap ($)')).toHaveValue('100');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('declined banner (W15 copy) for a declined saved card; PayPal wording for a vaulted wallet', async () => {
    const { client } = fakeApi({ enabled: false, declinedAt: '2026-11-12T10:00:00.000Z' });
    const { unmount } = render(<AutoTopupCard client={client} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'PayPal declined the saved card. Auto top-up is off until you update it.',
    );
    unmount();

    const paypal = fakeApi({
      enabled: false,
      declinedAt: '2026-11-12T10:00:00.000Z',
      savedMethod: { kind: 'PAYPAL', label: 'PayPal · sb-buyer@example.com' },
    });
    render(<AutoTopupCard client={paypal.client} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'PayPal declined the saved PayPal account. Auto top-up is off until you update it.',
    );
  });

  it('cap-reached banner (W15 copy)', async () => {
    const { client } = fakeApi({
      usedThisMonthCents: 10_000,
      remainingThisMonthCents: 0,
      capReached: true,
    });
    render(<AutoTopupCard client={client} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Auto top-up is at its $100 monthly cap. Top up by hand or raise the cap.',
    );
  });

  it('saves "$20 when below $2, max $100/month" as cents and micros; re-enabling clears the declined banner', async () => {
    const user = userEvent.setup();
    const { client, puts } = fakeApi({ enabled: false, declinedAt: '2026-11-12T10:00:00.000Z' });
    render(<AutoTopupCard client={client} />);
    await screen.findByRole('alert');

    await user.click(screen.getByLabelText('Top up automatically'));
    await user.clear(screen.getByLabelText('Amount ($)'));
    await user.type(screen.getByLabelText('Amount ($)'), '25');
    await user.clear(screen.getByLabelText('When below ($)'));
    await user.type(screen.getByLabelText('When below ($)'), '1.50');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(puts).toEqual([
      { enabled: true, amountCents: 2500, thresholdMicros: 1_500_000, monthlyCapCents: 10_000 },
    ]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('enabling without a saved method shows the API explanation (422 NO_SAVED_METHOD)', async () => {
    const user = userEvent.setup();
    const message =
      'Auto top-up needs a saved payment method. Top up once with "Save for auto top-up" ticked, then turn auto top-up on.';
    const { client } = fakeApi({ enabled: false, savedMethod: null }, () =>
      json(422, { error: { code: 'NO_SAVED_METHOD', message } }),
    );
    render(<AutoTopupCard client={client} />);
    expect(await screen.findByText(/None yet/)).toBeInTheDocument();
    await user.click(screen.getByLabelText('Top up automatically'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Auto top-up needs a saved method.');
    expect(alert).toHaveTextContent(message);
  });

  it('validates before sending: amount $5–$500, cap ≥ amount', async () => {
    const user = userEvent.setup();
    const { client, puts } = fakeApi();
    render(<AutoTopupCard client={client} />);
    await screen.findByText('Visa ••1111');

    await user.clear(screen.getByLabelText('Amount ($)'));
    await user.type(screen.getByLabelText('Amount ($)'), '4');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Enter an amount from $5 to $500.')).toBeInTheDocument();
    expect(screen.getByLabelText('Amount ($)')).toHaveAttribute('aria-invalid', 'true');

    await user.clear(screen.getByLabelText('Amount ($)'));
    await user.type(screen.getByLabelText('Amount ($)'), '200');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      screen.getByText('The monthly cap must be at least the top-up amount.'),
    ).toBeInTheDocument();
    expect(puts).toEqual([]);
  });

  it('re-reads when the portal bumps reloadToken (a top-up just saved a method)', async () => {
    const { client } = fakeApi({ savedMethod: null });
    const { rerender } = render(<AutoTopupCard client={client} reloadToken={0} />);
    await screen.findByText(/None yet/);
    const get = vi.spyOn(client, 'get');
    rerender(<AutoTopupCard client={client} reloadToken={1} />);
    await waitFor(() => expect(get).toHaveBeenCalledWith('/api/buyer/auto-topup'));
  });

  it('parses dollar input', () => {
    expect(dollarsToCents('20')).toBe(2000);
    expect(dollarsToCents('$1.5')).toBe(150);
    expect(dollarsToCents(' 0.05 ')).toBe(5);
    expect(dollarsToCents('1.234')).toBeNull();
    expect(dollarsToCents('-1')).toBeNull();
    expect(dollarsToCents('')).toBeNull();
  });
});
