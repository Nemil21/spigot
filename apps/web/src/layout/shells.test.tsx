import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import publisherMe from '../fixtures/api/auth/me.json';
import buyerMe from '../fixtures/api/buyer/me.json';
import { buyerNav, publisherNav } from '../routes';
import { applyThemeMode } from '../theme/mode';
import BuyerShell from './BuyerShell';
import PublisherShell from './PublisherShell';
import { usePublisherSession } from './session';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
let handler: Handler;
const calls: [string, RequestInit][] = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push([url, init]);
    return handler(url, init);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
  localStorage.clear();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const unauthenticated = () =>
  json(401, { error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } });

function WhoAmI() {
  return <h1>Hello {usePublisherSession().name}</h1>;
}

function renderApp(entry: string) {
  const router = createMemoryRouter(
    [
      { path: '/app/login', element: <h1>Publisher login</h1> },
      { path: '/buyers/login', element: <h1>Buyer login</h1> },
      { element: <PublisherShell />, children: [{ path: '/app/*', element: <WhoAmI /> }] },
      {
        element: <BuyerShell />,
        children: [{ path: '/buyers/*', element: <h1>Portal</h1> }],
      },
    ],
    { initialEntries: [entry] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe('PublisherShell', () => {
  it('renders the W04 nav and the page once the session loads', async () => {
    handler = () => json(200, publisherMe);
    renderApp('/app/earnings');
    expect(await screen.findByRole('heading', { name: 'Hello Bluebonnet Rentals' })).toBeVisible();
    const nav = screen.getByRole('navigation', { name: 'Publisher' });
    expect([...nav.querySelectorAll('ul a')].map((a) => a.textContent)).toEqual(
      publisherNav.map((n) => n.label),
    );
    expect(screen.getByText('Demo account')).toBeInTheDocument();
    expect(calls[0]![0]).toBe('/api/auth/me');
  });

  it('shows skeletons, not the page, while the session loads', () => {
    handler = () => new Promise(() => {});
    renderApp('/app');
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true');
    expect(document.querySelector('[data-skeleton]')).toBeInTheDocument();
  });

  it('sends a signed-out visitor to login with ?next=', async () => {
    handler = unauthenticated;
    const router = renderApp('/app/payouts?batch=b1');
    expect(await screen.findByRole('heading', { name: 'Publisher login' })).toBeVisible();
    expect(router.state.location.search).toBe(
      `?next=${encodeURIComponent('/app/payouts?batch=b1')}`,
    );
  });

  it('treats a buyer-only session as signed out of the dashboard', async () => {
    handler = () => json(200, { publisher: null, buyer: buyerMe, isAdmin: false });
    renderApp('/app');
    expect(await screen.findByRole('heading', { name: 'Publisher login' })).toBeVisible();
  });

  it('shows an error banner with retry when the API is down', async () => {
    handler = () => json(503, { error: { code: 'INTERNAL_ERROR', message: 'Try again soon.' } });
    renderApp('/app');
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again soon.');
    handler = () => json(200, publisherMe);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Hello Bluebonnet Rentals' })).toBeVisible();
  });

  it('logs out through the API and lands on login', async () => {
    handler = (url) =>
      url === '/api/auth/logout' ? new Response(null, { status: 204 }) : json(200, publisherMe);
    renderApp('/app');
    await userEvent.click(await screen.findByRole('button', { name: 'Log out' }));
    expect(await screen.findByRole('heading', { name: 'Publisher login' })).toBeVisible();
    expect(calls.find(([u]) => u === '/api/auth/logout')?.[1].method).toBe('POST');
  });

  it('switches between light and dark and remembers the choice', async () => {
    handler = () => json(200, publisherMe);
    applyThemeMode('light');
    renderApp('/app');
    await userEvent.click(await screen.findByRole('button', { name: 'Switch to dark theme' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('spigot.theme')).toBe('dark');
    await userEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }));
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});

describe('BuyerShell', () => {
  it('renders the buyer nav once the buyer session loads', async () => {
    handler = () => json(200, buyerMe);
    renderApp('/buyers/usage');
    expect(await screen.findByRole('heading', { name: 'Portal' })).toBeVisible();
    const nav = screen.getByRole('navigation', { name: 'Buyer' });
    expect([...nav.querySelectorAll('ul a')].map((a) => a.textContent)).toEqual(
      buyerNav.map((n) => n.label),
    );
    expect(nav).toHaveTextContent('Acme Agents (demo)');
    expect(calls[0]![0]).toBe('/api/buyer/me');
  });

  it('sends a signed-out buyer to the buyer login', async () => {
    handler = unauthenticated;
    const router = renderApp('/buyers');
    expect(await screen.findByRole('heading', { name: 'Buyer login' })).toBeVisible();
    await waitFor(() => expect(router.state.location.search).toBe('?next=%2Fbuyers'));
  });
});
