import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient, type FetchLike } from '../api/client';
import me from '../fixtures/api/auth/me.json';
import sitesFixture from '../fixtures/api/sites.json';
import SettingsPage, { gatedPathErrors } from './Settings';

const SITE = sitesFixture.sites[0]!;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

/** A fetch that answers the two loads from fixtures and hands every mutation to `mutate`. */
function api(mutate: Handler = () => json(500, {}), sites: unknown = sitesFixture) {
  return vi.fn<FetchLike>(async (url, init) => {
    if (init.method === 'GET' && url === '/api/auth/me') return json(200, me);
    if (init.method === 'GET' && url === '/api/sites') return json(200, sites);
    return mutate(url, init);
  });
}

function setup(fetch: FetchLike, tab?: string) {
  const client = createApiClient({ fetch, fixtures: false });
  const router = createMemoryRouter(
    [{ path: '/app/settings', element: <SettingsPage client={client} /> }],
    { initialEntries: [tab ? `/app/settings?tab=${tab}` : '/app/settings'] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const bodyOf = (init: RequestInit) => JSON.parse(init.body as string);
const validation = (issues: { path: string; message: string }[]) =>
  json(400, {
    error: { code: 'VALIDATION_ERROR', message: 'Invalid request.', details: { issues } },
  });

afterEach(() => vi.useRealTimers());

describe('W16 Settings', () => {
  it('shows skeletons, then the account tab; tabs switch through ?tab=', async () => {
    const router = setup(api());
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(await screen.findByLabelText('Name')).toHaveValue('Bluebonnet Rentals');
    expect(screen.getByText(me.publisher.email)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Gate policy' }));
    expect(router.state.location.search).toBe('?tab=policy');
    expect(screen.getByRole('tab', { name: 'Gate policy' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await screen.findByLabelText('Gated paths')).toHaveValue('^/listings/');
  });

  it('shows an error banner with retry when loading fails', async () => {
    let fail = true;
    const fetch = vi.fn<FetchLike>(async (url) => {
      if (fail)
        return json(500, {
          error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side.' },
        });
      return url === '/api/auth/me' ? json(200, me) : json(200, sitesFixture);
    });
    setup(fetch);
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our side.');
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Name')).toBeInTheDocument();
  });

  describe('Account', () => {
    it('saves the name and shows the saved toast, which goes away', async () => {
      const fetch = api((url, init) => {
        expect([url, init.method]).toEqual(['/api/publishers/me', 'PATCH']);
        return json(200, { ...me.publisher, name: bodyOf(init).name });
      });
      setup(fetch);
      const name = await screen.findByLabelText('Name');
      await userEvent.clear(name);
      await userEvent.type(name, '  Bluebonnet Realty ');
      vi.useFakeTimers({ shouldAdvanceTime: true });
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
      expect(bodyOf(fetch.mock.calls.at(-1)![1])).toEqual({ name: 'Bluebonnet Realty' });
      expect(name).toHaveValue('Bluebonnet Realty');
      await act(() => vi.advanceTimersByTimeAsync(5000));
      expect(screen.queryByRole('status')).toBeNull();
    });

    it("an empty name is caught before it's sent", async () => {
      const fetch = api();
      setup(fetch);
      await userEvent.clear(await screen.findByLabelText('Name'));
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(screen.getByText('Enter a name.')).toBeInTheDocument();
      expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
      expect(fetch.mock.calls.filter(([, i]) => i.method !== 'GET')).toHaveLength(0);
    });
  });

  describe('Payout', () => {
    it('saves the PayPal email; says it applies to the next batch; links Connect with PayPal', async () => {
      const fetch = api((_url, init) =>
        json(200, { ...me.publisher, payoutEmail: bodyOf(init).payoutEmail.toLowerCase() }),
      );
      setup(fetch, 'payout');
      const email = await screen.findByLabelText('PayPal email');
      expect(email).toHaveValue(me.publisher.payoutEmail);
      expect(screen.getByText(/applies to the next batch/)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /Connect with PayPal/ })).toHaveAttribute(
        'href',
        '/api/auth/paypal/start',
      );

      await userEvent.clear(email);
      await userEvent.type(email, 'New@Example.com');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(await screen.findByRole('status')).toHaveTextContent(
        'Your next payout goes to this PayPal account.',
      );
      expect(bodyOf(fetch.mock.calls.at(-1)![1])).toEqual({ payoutEmail: 'New@Example.com' });
      expect(email).toHaveValue('new@example.com');
    });

    it('after Connect with PayPal: Connected, Reconnect, and the callback’s notice', async () => {
      const connectedMe = { ...me, publisher: { ...me.publisher, paypalConnected: true } };
      const fetch = vi.fn<FetchLike>(async (url) =>
        url === '/api/auth/me' ? json(200, connectedMe) : json(200, sitesFixture),
      );
      setup(fetch, 'payout&paypal=connected');
      expect(await screen.findByText('Connected')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /Reconnect PayPal/ })).toHaveAttribute(
        'href',
        '/api/auth/paypal/start',
      );
      expect(screen.getByRole('status')).toHaveTextContent('PayPal connected.');
    });

    it('shows why Connect with PayPal failed (taken)', async () => {
      setup(api(), 'payout&paypal=taken');
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'already connected to another Spigot account',
      );
    });

    it('shows a client-side and a server-side validation error', async () => {
      const fetch = api(() =>
        validation([{ path: 'payoutEmail', message: 'Invalid email address' }]),
      );
      setup(fetch, 'payout');
      const email = await screen.findByLabelText('PayPal email');
      await userEvent.clear(email);
      await userEvent.type(email, 'nope');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument();
      expect(fetch.mock.calls.filter(([, i]) => i.method === 'PATCH')).toHaveLength(0);

      await userEvent.clear(email);
      await userEvent.type(email, 'a@b.co');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(await screen.findByText('Invalid email address')).toBeInTheDocument();
      expect(screen.queryByRole('status')).toBeNull();
    });
  });

  describe('Gate policy', () => {
    it('switches AI agents to Pass and saves decisions + paths; Search stays locked', async () => {
      const fetch = api((url, init) => {
        expect([url, init.method]).toEqual([`/api/sites/${SITE.id}/policy`, 'PATCH']);
        const b = bodyOf(init);
        return json(200, {
          siteId: SITE.id,
          decisions: { SEARCH: 'PASS', ...b.decisions },
          gatedPaths: b.gatedPaths,
          policyVersion: 4,
        });
      });
      setup(fetch, 'policy');
      const agents = within(await screen.findByRole('group', { name: 'AI agents' }));
      expect(agents.getByRole('radio', { name: 'Send to API' })).toBeChecked();
      const search = within(screen.getByRole('group', { name: 'Search engines' }));
      expect(search.getByRole('radio', { name: 'Pass' })).toBeChecked();
      expect(search.getByRole('radio', { name: 'Send to API' })).toBeDisabled();

      await userEvent.click(agents.getByRole('radio', { name: 'Pass' }));
      const paths = screen.getByLabelText('Gated paths');
      await userEvent.type(paths, '{enter}  ^/blog/  {enter}{enter}');
      await userEvent.click(screen.getByRole('button', { name: 'Save policy' }));

      expect(await screen.findByRole('status')).toHaveTextContent('within 60 seconds');
      expect(bodyOf(fetch.mock.calls.at(-1)![1])).toEqual({
        decisions: {
          AI_TRAINING: 'QUOTE',
          AI_AGENT: 'PASS',
          SCRAPER_TOOL: 'QUOTE',
          UNKNOWN: 'PASS',
        },
        gatedPaths: ['^/listings/', '^/blog/'],
      });
      expect(agents.getByRole('radio', { name: 'Pass' })).toBeChecked();
      expect(paths).toHaveValue('^/listings/\n^/blog/');
    });

    it('flags an invalid regex before saving, and maps server issues to lines', async () => {
      const fetch = api(() =>
        validation([{ path: 'gatedPaths.1', message: 'must be a valid regular expression' }]),
      );
      setup(fetch, 'policy');
      const paths = await screen.findByLabelText('Gated paths');
      await userEvent.clear(paths);
      await userEvent.type(paths, '^/ok/{enter}^/broken/(');
      await userEvent.click(screen.getByRole('button', { name: 'Save policy' }));
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Line “^/broken/(”: Not a valid regular expression.',
      );
      expect(paths).toHaveAttribute('aria-invalid', 'true');
      expect(fetch.mock.calls.filter(([, i]) => i.method === 'PATCH')).toHaveLength(0);

      await userEvent.clear(paths);
      await userEvent.type(paths, '^/ok/{enter}^/also-ok/');
      await userEvent.click(screen.getByRole('button', { name: 'Save policy' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Line “^/also-ok/”: must be a valid regular expression',
      );
    });

    it('no site yet → connect a site', async () => {
      setup(api(undefined, { sites: [] }), 'policy');
      expect(await screen.findByRole('link', { name: 'Connect your site' })).toHaveAttribute(
        'href',
        '/app/connect',
      );
    });

    it('gatedPathErrors', () => {
      expect(gatedPathErrors(['^/a/', '(', 'x'.repeat(501)])).toEqual([
        null,
        'Not a valid regular expression.',
        'Keep it under 500 characters.',
      ]);
    });
  });

  describe('Keys', () => {
    it('rotates the crawl key after a confirm and shows the new key once, with copy', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      const fetch = api((url, init) => {
        expect([url, init.method, bodyOf(init)]).toEqual([
          `/api/sites/${SITE.id}/keys/rotate`,
          'POST',
          { kind: 'crawl' },
        ]);
        return json(200, {
          siteId: SITE.id,
          kind: 'crawl',
          key: 'ck_new_secret',
          envVar: 'SPIGOT_CRAWL_KEY',
          policyVersion: 4,
        });
      });
      setup(fetch, 'keys');
      const card = within(await screen.findByRole('region', { name: 'Crawl key' }));
      await userEvent.click(card.getByRole('button', { name: 'Rotate…' }));
      expect(card.getByRole('alertdialog')).toHaveTextContent('within 60 seconds');
      expect(fetch.mock.calls.filter(([, i]) => i.method === 'POST')).toHaveLength(0);

      await userEvent.click(card.getByRole('button', { name: 'Rotate crawl key' }));
      expect(await card.findByTestId('key-crawl-value')).toHaveTextContent('ck_new_secret');
      expect(card.getByText(/Nothing to change on your server/)).toBeInTheDocument();
      await userEvent.click(card.getByRole('button', { name: 'Copy' }));
      expect(writeText).toHaveBeenCalledWith('ck_new_secret');
      expect(card.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
      // The gate key card is untouched.
      expect(screen.queryByTestId('key-gate-value')).toBeNull();
    });

    it('cancel does nothing; a failed gate rotation shows the error', async () => {
      const fetch = api(() => json(404, { error: { code: 'NOT_FOUND', message: 'Not found.' } }));
      setup(fetch, 'keys');
      const card = within(await screen.findByRole('region', { name: 'Gate key' }));
      await userEvent.click(card.getByRole('button', { name: 'Rotate…' }));
      expect(card.getByRole('alertdialog')).toHaveTextContent('lets every request through');
      await userEvent.click(card.getByRole('button', { name: 'Cancel' }));
      expect(card.queryByRole('alertdialog')).toBeNull();
      expect(fetch.mock.calls.filter(([, i]) => i.method === 'POST')).toHaveLength(0);

      await userEvent.click(card.getByRole('button', { name: 'Rotate…' }));
      await userEvent.click(card.getByRole('button', { name: 'Rotate gate key' }));
      expect(await card.findByRole('alert')).toHaveTextContent('Not found.');
      expect(screen.queryByTestId('key-gate-value')).toBeNull();
    });
  });
});
