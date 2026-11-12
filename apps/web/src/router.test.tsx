import { render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import publisherMe from './fixtures/api/auth/me.json';
import buyerMe from './fixtures/api/buyer/me.json';
import { routes } from './router';
import { buyerNav, href, paths, publisherNav } from './routes';

/** Every screen in SP-024a's list: path → the stub's `data-screen` and heading. */
const SCREENS: [path: string, screen: string, title: string][] = [
  ['/', 'W01', 'Spigot'],
  ['/app/records', 'W07', 'Records'],
  ['/app/earnings', 'W08', 'Earnings'],
  ['/app/crawls', 'W10', 'Crawls'],
  ['/app/admin/audit', 'W14', 'Audit'],
  ['/buyers/usage', 'W12', 'Usage and claims'],
];

/** Real W11 pages (SP-032), no longer stubs. */
const BUYER_PAGES: [path: string, title: string][] = [
  ['/buyers', 'Balance and keys'],
  ['/buyers/topup/tp_1?ok=1', 'Balance and keys'],
  ['/buyers/signup', 'Create a buyer account'],
];

/** Screens that replaced their stub: path → `data-screen`, heading and a landmark of the real page. */
const BUILT: [path: string, screen: string, title: string, landmark: string][] = [
  ['/app/settings', 'W16', 'Settings', 'tablist'], // SP-034
  // SP-031; this test has no payouts API, so W09 shows its inline error banner.
  ['/app/payouts', 'W09', 'Payouts', 'alert'],
  ['/app/record-types', 'W05', 'Record types', 'alert'], // SP-028 (no API here: its error banner)
  // SP-027b. This test's fetch 404s `/api/sites`, so W04 settles on its error banner.
  ['/app', 'W04', 'Overview', 'alert'],
  // SP-029; no datasets API here either, so W06 shows its inline error banner.
  ['/app/datasets/ds_123', 'W06', 'Dataset editor', 'alert'],
];

/** The real login pages (SP-024b), no longer stubs. */
const LOGINS: [path: string, title: string][] = [
  ['/app/login', 'Log in'],
  ['/buyers/login', 'Log in for agents'],
];

/** W02 / W03 (SP-026), no longer stubs; their states are tested in pages/onboarding. */
const ONBOARDING: [path: string, title: string][] = [
  ['/app/signup', 'Create your account'],
  ['/app/connect', 'Connect your site'],
];

// The shells check the session first (SP-024b): answer as a signed-in publisher and buyer.
const SESSIONS: Record<string, unknown> = { '/api/auth/me': publisherMe, '/api/buyer/me': buyerMe };
beforeEach(() => {
  vi.stubGlobal('fetch', async (input: string) =>
    input in SESSIONS
      ? new Response(JSON.stringify(SESSIONS[input]), { status: 200 })
      : new Response('{}', { status: 404 }),
  );
});
afterEach(() => vi.unstubAllGlobals());

async function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return screen.findByRole('heading', { level: 1 });
}

describe('router', () => {
  // W04 (SP-027b) imports AG Grid + AG Charts; load the chunk once so `findBy`'s 1 s covers render only.
  beforeAll(() => import('./pages/Overview'), 30_000);

  it.each(SCREENS)('%s resolves to its stub (%s)', async (path, screenId, title) => {
    const h1 = await renderAt(path);
    expect(h1).toHaveTextContent(title);
    expect(h1.closest('[data-screen]')).toHaveAttribute('data-screen', screenId);
    expect(screen.getByText('Coming soon')).toBeInTheDocument();
  });

  it.each(BUILT)('%s renders its real screen (%s)', async (path, screenId, title, landmark) => {
    const h1 = await renderAt(path);
    expect(h1).toHaveTextContent(title);
    expect(h1.closest('[data-screen]')).toHaveAttribute('data-screen', screenId);
    expect(await screen.findByRole(landmark)).toBeInTheDocument();
    expect(screen.queryByText('Coming soon')).toBeNull();
  });

  it.each(LOGINS)('%s renders the login form', async (path, title) => {
    expect(await renderAt(path)).toHaveTextContent(title);
    expect(screen.getByRole('button', { name: 'Log in' })).toBeInTheDocument();
  });

  it.each(BUYER_PAGES)('%s renders the W11 page', async (path, title) => {
    expect(await renderAt(path)).toHaveTextContent(title);
    expect(screen.queryByText('Coming soon')).not.toBeInTheDocument();
  });

  it.each(ONBOARDING)('%s renders its onboarding step', async (path, title) => {
    expect(await renderAt(path)).toHaveTextContent(title);
  });

  it('/app/install with no site points back to W02', async () => {
    SESSIONS['/api/sites'] = { sites: [] };
    try {
      const router = createMemoryRouter(routes, { initialEntries: ['/app/install'] });
      render(<RouterProvider router={router} />);
      expect(await screen.findByRole('link', { name: 'Connect your site' })).toHaveAttribute(
        'href',
        '/app/connect',
      );
    } finally {
      delete SESSIONS['/api/sites'];
    }
  });

  it('covers every path in the paths table', () => {
    const tested = new Set(
      [...SCREENS, ...BUILT, ...LOGINS, ...BUYER_PAGES, ...ONBOARDING, ['/app/install']].map(
        ([p]) => p!.split('?')[0],
      ),
    );
    for (const [name, p] of Object.entries(paths)) {
      const concrete = p.replace(':datasetId', 'ds_123').replace(':topupId', 'tp_1');
      expect(tested, name).toContain(concrete);
    }
  });

  it.each(['/app/nope', '/buyers/nope', '/nope'])('%s renders the 404 page', async (path) => {
    expect(await renderAt(path)).toHaveTextContent('Page not found');
  });

  it('shell pages render inside their nav', async () => {
    await renderAt('/app/earnings');
    const nav = screen.getByRole('navigation', { name: 'Publisher' });
    expect(nav).toHaveTextContent(publisherNav.map((n) => n.label).join(''));
    expect(screen.getByRole('link', { name: 'Earnings' })).toHaveAttribute('aria-current', 'page');
  });

  it('buyer pages render inside the buyer nav', async () => {
    await renderAt('/buyers/usage');
    const nav = screen.getByRole('navigation', { name: 'Buyer' });
    expect(nav).toHaveTextContent(buyerNav.map((n) => n.label).join(''));
  });

  it('publisher nav matches W04', () => {
    expect(publisherNav.map((n) => n.label)).toEqual([
      'Overview',
      'Record types',
      'Earnings',
      'Payouts',
      'Crawls',
      'Settings',
    ]);
  });

  it('href fills and encodes params', () => {
    expect(href('datasetEditor', { datasetId: 'a/b' })).toBe('/app/datasets/a%2Fb');
    expect(() => href('buyerTopup')).toThrow(/topupId/);
  });

  it('every SPA path is one the API serves index.html for', () => {
    for (const p of Object.values(paths)) {
      expect(p === '/' || /^\/(app|buyers)(\/|$)/.test(p), p).toBe(true);
    }
  });
});
