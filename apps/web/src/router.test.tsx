import { render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from './router';
import { buyerNav, href, paths, publisherNav } from './routes';

/** Every screen in SP-024a's list: path → the stub's `data-screen` and heading. */
const SCREENS: [path: string, screen: string, title: string][] = [
  ['/', 'W01', 'Spigot'],
  ['/app/login', 'Publisher login', 'Log in'],
  ['/app/signup', 'W02', 'Sign up'],
  ['/app/connect', 'W02', 'Connect your site'],
  ['/app/install', 'W03', 'Install the gate'],
  ['/app', 'W04', 'Overview'],
  ['/app/record-types', 'W05', 'Record types'],
  ['/app/datasets/ds_123', 'W06', 'Dataset editor'],
  ['/app/records', 'W07', 'Records'],
  ['/app/earnings', 'W08', 'Earnings'],
  ['/app/payouts', 'W09', 'Payouts'],
  ['/app/crawls', 'W10', 'Crawls'],
  ['/app/settings', 'W16', 'Settings'],
  ['/app/admin/audit', 'W14', 'Audit'],
  ['/buyers', 'W11', 'Balance and keys'],
  ['/buyers/topup/tp_1?ok=1', 'W11', 'Balance and keys'],
  ['/buyers/usage', 'W12', 'Usage and claims'],
  ['/buyers/login', 'Buyer login', 'Buyer log in'],
  ['/buyers/signup', 'W11', 'Buyer sign up'],
];

async function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return screen.findByRole('heading', { level: 1 });
}

describe('router', () => {
  it.each(SCREENS)('%s resolves to its stub (%s)', async (path, screenId, title) => {
    const h1 = await renderAt(path);
    expect(h1).toHaveTextContent(title);
    expect(h1.closest('[data-screen]')).toHaveAttribute('data-screen', screenId);
    expect(screen.getByText('Coming soon')).toBeInTheDocument();
  });

  it('covers every path in the paths table', () => {
    const tested = new Set(SCREENS.map(([p]) => p.split('?')[0]));
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
