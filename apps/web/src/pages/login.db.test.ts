import '../test/jsdom-in-node';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FastifyInstance } from 'fastify';
import { Writable } from 'node:stream';
import { createElement } from 'react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from '@spigot/db/testing.mjs';
import { REQUIRED_ENV } from '../../../api/src/test/env.js';
import { routes } from '../router';

/**
 * SP-024b acceptance: publisher and buyer login against SP-007a's real routes, fixture-free. The
 * web app's `fetch` goes through `app.inject` with a cookie jar and the browser's same-origin
 * `Origin`, so the CSRF check, session cookies and `/me` guards are the real ones. Lives in the
 * `db` project (it needs Postgres); `.ts` because that project only collects `*.db.test.ts`.
 */
const ORIGIN = REQUIRED_ENV.APP_BASE_URL!;
const PUBLISHER = {
  name: 'Bluebonnet Rentals',
  email: 'owner@bluebonnet.test',
  password: 'correct horse battery',
};
const BUYER = { name: 'Acme Agents', email: 'agents@acme.test', password: 'staple battery horse' };

describe.skipIf(!testDatabaseUrl)('SP-024b login pages against the real API (Postgres)', () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  const jar = new Map<string, string>();
  const requests: { method: string; url: string; status: number }[] = [];

  async function injectFetch(input: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    const method = (init.method ?? 'GET').toUpperCase();
    // What a browser adds on a same-origin call: Origin on mutations, and the cookies.
    if (method !== 'GET') headers.origin = ORIGIN;
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await app.inject({
      method: method as 'GET',
      url: input,
      headers,
      payload: init.body as string | undefined,
    });
    for (const c of res.cookies) {
      const cleared =
        c.value === '' || c.maxAge === 0 || (c.expires && c.expires.getTime() < Date.now());
      if (cleared) jar.delete(c.name);
      else jar.set(c.name, c.value);
    }
    requests.push({ method, url: input, status: res.statusCode });
    return new Response(res.statusCode === 204 ? null : res.body, {
      status: res.statusCode,
      headers: { 'content-type': String(res.headers['content-type'] ?? 'application/json') },
    });
  }

  beforeAll(async () => {
    const { loadConfig } = await import('../../../api/src/config.js');
    const { buildServer } = await import('../../../api/src/server.js');
    db = await createTestDatabase();
    app = await buildServer(loadConfig({ ...REQUIRED_ENV, DATABASE_URL: db.url }), {
      logStream: new Writable({ write: (_chunk, _enc, cb) => cb() }),
    });
    await app.ready();
    const signups = [
      ['/api/auth/signup', { ...PUBLISHER, payoutEmail: 'payouts@bluebonnet.test' }],
      ['/api/buyer/signup', BUYER],
    ] as const;
    for (const [url, payload] of signups) {
      const res = await app.inject({ method: 'POST', url, headers: { origin: ORIGIN }, payload });
      expect(res.statusCode, url).toBe(201);
    }
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });
  beforeEach(() => {
    jar.clear();
    requests.length = 0;
    app.rateLimiter.reset();
    vi.stubGlobal('fetch', injectFetch);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function openApp(path: string) {
    const router = createMemoryRouter(routes, { initialEntries: [path] });
    render(createElement(RouterProvider, { router }));
    return router;
  }

  async function logIn(email: string, password: string) {
    await userEvent.type(await screen.findByLabelText('Email'), email);
    await userEvent.type(screen.getByLabelText('Password'), password);
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
  }

  it('publisher: deep link → login → back to the page inside the shell; log out again', async () => {
    const router = openApp('/app/earnings');
    // Signed out: the shell's /api/auth/me is a real 401, so we land on login with ?next=.
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeVisible();
    expect(router.state.location.pathname).toBe('/app/login');

    await logIn(PUBLISHER.email.toUpperCase(), PUBLISHER.password);

    expect(await screen.findByRole('heading', { name: 'Earnings' })).toBeVisible();
    expect(router.state.location.pathname).toBe('/app/earnings');
    const nav = screen.getByRole('navigation', { name: 'Publisher' });
    expect(nav).toHaveTextContent(PUBLISHER.name);
    expect(requests).toContainEqual({ method: 'POST', url: '/api/auth/login', status: 200 });
    expect(jar.size).toBe(1);

    await userEvent.click(screen.getByRole('button', { name: 'Log out' }));
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeVisible();
    expect(jar.size).toBe(0);
    expect((await injectFetch('/api/auth/me')).status).toBe(401);
  });

  it('publisher: a wrong password shows the API message and stays on login', async () => {
    const router = openApp('/app/login');
    await logIn(PUBLISHER.email, 'wrong password');
    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect.');
    expect(router.state.location.pathname).toBe('/app/login');
    expect(jar.size).toBe(0);
  });

  it('buyer: login → /buyers portal inside the buyer shell', async () => {
    const router = openApp('/buyers/login');
    expect(await screen.findByRole('heading', { name: 'Log in for agents' })).toBeVisible();
    await logIn(BUYER.email, BUYER.password);
    expect(await screen.findByRole('heading', { name: 'Balance and keys' })).toBeVisible();
    expect(router.state.location.pathname).toBe('/buyers');
    expect(screen.getByRole('navigation', { name: 'Buyer' })).toHaveTextContent(BUYER.name);
    expect(requests).toContainEqual({ method: 'POST', url: '/api/buyer/login', status: 200 });
  });

  it("buyer credentials don't open the publisher dashboard", async () => {
    const router = openApp('/buyers/login?next=%2Fapp');
    await logIn(BUYER.email, BUYER.password);
    // `next` outside the buyer area is ignored.
    await screen.findByRole('heading', { name: 'Balance and keys' });
    expect(router.state.location.pathname).toBe('/buyers');
    await router.navigate('/app');
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/login'));
  });
});
