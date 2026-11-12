import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient, type FetchLike } from '../../api/client';
import { fixtureMapFromGlob, type FixtureLoader } from '../../api/fixtures';
import { ConnectSiteCard } from './ConnectSite';
import { expressSnippet, InstallVerify, W03_COPY } from './InstallVerify';
import { forgetSiteKeys, peekSiteKeys, rememberSiteKeys } from './kit';
import { PAYOUT_EMAIL_HINT, SignUpFlow } from './SignUp';

// ---------------------------------------------------------------------------------------------
// Helpers

/** This ticket's fixtures (src/fixtures/api/sites/fx-onboard-*), as fixture mode serves them. */
const fixtures = fixtureMapFromGlob(
  import.meta.glob<unknown>('../../fixtures/api/sites/fx-onboard-*/**/*.json', {
    import: 'default',
  }) as Record<string, FixtureLoader>,
);
Object.assign(
  fixtures,
  fixtureMapFromGlob(
    import.meta.glob<unknown>('../../fixtures/api/sites/fx-onboard-*.json', {
      import: 'default',
    }) as Record<string, FixtureLoader>,
  ),
);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const apiError = (status: number, code: string, message: string, details: object = {}) =>
  json(status, { error: { code, message, details } });

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{loc.pathname + loc.search}</p>;
}

function renderAt(element: ReactNode, entry = '/start') {
  const router = createMemoryRouter(
    [
      { path: '/start', element },
      { path: '*', element: <Where /> },
    ],
    { initialEntries: [entry] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

/** Routes requests by "METHOD path"; unmatched → 500 so a stray call is loud. */
function routeFetch(routes: Record<string, (init: RequestInit) => Response | Promise<Response>>) {
  return vi.fn<FetchLike>(async (url, init) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    const handler = routes[key];
    if (!handler) return apiError(500, 'INTERNAL_ERROR', `unexpected ${key}`);
    return handler(init);
  });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Minimal EventSource so W03's crawl stream can be driven from the test. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  readyState = 0;
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  closed = false;
  private listeners = new Map<string, ((ev: MessageEvent) => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.last = this;
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.(new Event('open'));
    });
  }
  addEventListener(type: string, l: (ev: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
  }
  emit(type: string, data: unknown) {
    const ev = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
  close() {
    this.closed = true;
  }
}

beforeEach(() => {
  FakeEventSource.last = null;
  vi.stubGlobal('EventSource', FakeEventSource);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const id of ['s1', 'fx-onboard-pending', 'fx-onboard-verified']) forgetSiteKeys(id);
});

// ---------------------------------------------------------------------------------------------
// W02 step 1: account

async function fillAccount() {
  await userEvent.type(screen.getByLabelText('Name'), 'Maya Ortiz');
  await userEvent.type(screen.getByLabelText('Email'), 'maya@bluebonnet.test');
  await userEvent.type(screen.getByLabelText('Password'), 'correct horse');
  await userEvent.type(screen.getByLabelText('PayPal payout email'), 'payouts@bluebonnet.test');
}

describe('W02 sign up (step 1: account)', () => {
  it('default: four fields, and the payout email says where PayPal Payouts go', () => {
    renderAt(<SignUpFlow client={createApiClient({ fetch: vi.fn(), fixtures: false })} />);
    expect(screen.getByText('Step 1 of 2')).toBeInTheDocument();
    expect(screen.getByLabelText('PayPal payout email')).toHaveAccessibleDescription(
      PAYOUT_EMAIL_HINT,
    );
    for (const f of ['Name', 'Email', 'Password'])
      expect(screen.getByLabelText(f)).toBeInTheDocument();
  });

  it('validates locally before posting', async () => {
    const fetch = vi.fn<FetchLike>();
    renderAt(<SignUpFlow client={createApiClient({ fetch, fixtures: false })} />);
    await userEvent.type(screen.getByLabelText('Password'), 'short');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Use at least 8 characters.')).toBeInTheDocument();
    expect(screen.getByText('Enter the email of your PayPal account.')).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('posts the account (signed in by the API) and moves to step 2', async () => {
    const fetch = routeFetch({ 'POST /api/auth/signup': () => json(201, { publisherId: 'p1' }) });
    renderAt(<SignUpFlow client={createApiClient({ fetch, fixtures: false })} />);
    await fillAccount();
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Step 2 of 2')).toBeInTheDocument();
    expect(screen.getByLabelText('Site URL')).toBeInTheDocument();
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string)).toEqual({
      name: 'Maya Ortiz',
      email: 'maya@bluebonnet.test',
      password: 'correct horse',
      payoutEmail: 'payouts@bluebonnet.test',
    });
  });

  it('a taken email offers log in', async () => {
    const fetch = routeFetch({
      'POST /api/auth/signup': () =>
        apiError(409, 'STATE_CONFLICT', 'An account with that email already exists.'),
    });
    renderAt(<SignUpFlow client={createApiClient({ fetch, fixtures: false })} />);
    await fillAccount();
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('An account with that email already exists.');
    expect(within(alert).getByRole('link', { name: 'Log in instead' })).toHaveAttribute(
      'href',
      '/app/login',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// W02 step 2: connect site

const connected = {
  siteId: 's1',
  slug: 'bluebonnet',
  origin: 'http://localhost:4000',
  sitemapUrl: 'http://localhost:4000/sitemap.xml',
  status: 'PENDING_VERIFY',
  verify: { path: '/.well-known/spigot.txt', content: 'spigot-verify=abc' },
  gateKey: 'gk_test_gate',
  crawlKey: 'ck_test_crawl',
  install: '…',
};

async function submitSite(url = 'http://localhost:4000') {
  await userEvent.type(screen.getByLabelText('Site URL'), url);
  await userEvent.click(screen.getByRole('button', { name: 'Connect site' }));
}

describe('W02 connect site (step 2: live origin check)', () => {
  it('checking origin → success → W03, keys held in memory for W03 only', async () => {
    const gate = deferred<Response>();
    const fetch = routeFetch({ 'POST /api/sites': () => gate.promise });
    const router = renderAt(
      <ConnectSiteCard client={createApiClient({ fetch, fixtures: false })} />,
    );
    await submitSite();

    expect(screen.getByRole('button', { name: 'Checking your site…' })).toBeDisabled();
    expect(screen.getByText(/Checking that we can reach your site/)).toBeInTheDocument();
    // A second click while checking sends nothing.
    await userEvent.click(screen.getByRole('button', { name: 'Checking your site…' }));
    expect(fetch).toHaveBeenCalledTimes(1);

    gate.resolve(json(201, connected));
    expect(await screen.findByTestId('where')).toHaveTextContent('/app/install?site=s1');
    expect(router.state.location.state).toBeNull(); // no secrets in history state
    expect(peekSiteKeys('s1')).toEqual({ gateKey: 'gk_test_gate', crawlKey: 'ck_test_crawl' });
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string)).toEqual({
      origin: 'http://localhost:4000',
    });
  });

  it('origin unreachable', async () => {
    const fetch = routeFetch({
      'POST /api/sites': () =>
        apiError(502, 'ORIGIN_ERROR', "We couldn't reach that site", { reason: 'DNS_FAILED' }),
    });
    renderAt(<ConnectSiteCard client={createApiClient({ fetch, fixtures: false })} />);
    await submitSite('https://nope.invalid');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("We couldn't reach that site");
    expect(screen.getByRole('button', { name: 'Connect site' })).toBeEnabled();
  });

  it('no sitemap → editable sitemap URL, sent on the retry', async () => {
    const fetch = routeFetch({
      'POST /api/sites': (init) =>
        JSON.parse(init.body as string).sitemapUrl
          ? json(201, connected)
          : apiError(400, 'VALIDATION_ERROR', 'Add a sitemap.xml or enter one', {
              field: 'sitemapUrl',
              reason: 'NO_SITEMAP',
            }),
    });
    renderAt(<ConnectSiteCard client={createApiClient({ fetch, fixtures: false })} />);
    await submitSite();
    expect(await screen.findByRole('alert')).toHaveTextContent('Add a sitemap.xml or enter one');
    const sitemap = screen.getByLabelText('Sitemap URL');
    expect(sitemap).toHaveValue('http://localhost:4000/sitemap.xml');
    await userEvent.clear(sitemap);
    await userEvent.type(sitemap, 'http://localhost:4000/sitemap-index.xml');
    await userEvent.click(screen.getByRole('button', { name: 'Connect site' }));
    expect(await screen.findByTestId('where')).toHaveTextContent('/app/install?site=s1');
    expect(JSON.parse(fetch.mock.calls[1]![1].body as string)).toEqual({
      origin: 'http://localhost:4000',
      sitemapUrl: 'http://localhost:4000/sitemap-index.xml',
    });
  });

  it('a bad URL is a field error', async () => {
    const fetch = routeFetch({
      'POST /api/sites': () =>
        apiError(400, 'VALIDATION_ERROR', "That address isn't a public website", {
          field: 'origin',
        }),
    });
    renderAt(<ConnectSiteCard client={createApiClient({ fetch, fixtures: false })} />);
    await submitSite('http://10.0.0.1');
    expect(await screen.findByText("That address isn't a public website")).toBeInTheDocument();
    expect(screen.getByLabelText('Site URL')).toHaveAttribute('aria-invalid', 'true');
  });

  it('already connected by this publisher → continue to W03', async () => {
    const fetch = routeFetch({
      'POST /api/sites': () =>
        apiError(409, 'STATE_CONFLICT', 'That site is already connected to Spigot'),
      'GET /api/sites': () => json(200, { sites: [{ id: 's1', origin: 'http://localhost:4000' }] }),
    });
    renderAt(<ConnectSiteCard client={createApiClient({ fetch, fixtures: false })} />);
    await submitSite();
    expect(await screen.findByRole('link', { name: 'Continue setting it up' })).toHaveAttribute(
      'href',
      '/app/install?site=s1',
    );
  });

  it('signed out → login, back to connect after', async () => {
    const fetch = routeFetch({
      'POST /api/sites': () => apiError(401, 'UNAUTHENTICATED', 'Sign in to continue.'),
    });
    renderAt(<ConnectSiteCard client={createApiClient({ fetch, fixtures: false })} />);
    await submitSite();
    expect(await screen.findByTestId('where')).toHaveTextContent(
      '/app/login?next=%2Fapp%2Fconnect',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// W03 install + verify + first crawl (fixture mode for GETs, fetch mock for mutations)

function w03(
  siteId: string,
  extra: Parameters<typeof routeFetch>[0] = {},
  opts: { pollMs?: number } = {},
) {
  const fetch = routeFetch(extra);
  const client = createApiClient({ fetch, fixtures });
  renderAt(
    <InstallVerify
      siteId={siteId}
      client={client}
      pollMs={opts.pollMs ?? 60_000}
      apiBase="https://spigot.test"
    />,
  );
  return fetch;
}

const gateStatus = () => screen.getByLabelText(/^Gate status:/);

describe('W03 install + verify', () => {
  it('pending verify: file path + content to copy, Check now, gate not seen, crawl waits', async () => {
    w03('fx-onboard-pending');
    expect(await screen.findByText('Not verified yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy file path' })).toBeInTheDocument();
    expect(screen.getByText('spigot-verify=fixture0000000000000000')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check now' })).toBeInTheDocument();
    expect(await screen.findByLabelText(`Gate status: ${W03_COPY.waiting}`)).toBeInTheDocument();
    expect(screen.getByText(/Verify the site first/)).toBeInTheDocument();
    expect(screen.getByText(W03_COPY.failsOpen)).toBeInTheDocument();
    expect(screen.getByText('npm i @spigot/gate')).toBeInTheDocument();
    expect(
      screen.getByText(/process\.env\.SPIGOT_GATE_KEY, apiBase: 'https:\/\/spigot\.test'/),
    ).toBeInTheDocument();
    expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent('Verify');
  });

  it('copies the verify content', async () => {
    w03('fx-onboard-pending');
    await userEvent.click(await screen.findByRole('button', { name: 'Copy file content' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'spigot-verify=fixture0000000000000000',
    );
  });

  it('Check now: token missing → reason; then found → verified and the crawl step opens', async () => {
    let calls = 0;
    const fetch = w03('fx-onboard-pending', {
      'POST /api/sites/fx-onboard-pending/verify': () =>
        ++calls === 1
          ? apiError(409, 'STATE_CONFLICT', 'Token not found at /.well-known/spigot.txt')
          : json(200, { status: 'VERIFIED' }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Check now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Token not found at /.well-known/spigot.txt',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('Verified')).toBeInTheDocument();
    // Fixture has no run yet → the button is offered.
    expect(await screen.findByRole('button', { name: 'Start first crawl' })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keys are shown once: on screen right after connect, with copy', async () => {
    rememberSiteKeys('fx-onboard-pending', { gateKey: 'gk_once', crawlKey: 'ck_once' });
    w03('fx-onboard-pending');
    expect(await screen.findByText('SPIGOT_GATE_KEY=gk_once')).toBeInTheDocument();
    expect(screen.getByText('SPIGOT_CRAWL_KEY=ck_once')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Copy SPIGOT_GATE_KEY' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('gk_once');
  });

  it('a later visit has no keys and points to Settings to rotate', async () => {
    rememberSiteKeys('fx-onboard-pending', { gateKey: 'gk_once', crawlKey: 'ck_once' });
    const first = createMemoryRouter(
      [
        {
          path: '/start',
          element: (
            <InstallVerify
              siteId="fx-onboard-pending"
              client={createApiClient({ fetch: vi.fn(), fixtures })}
              pollMs={60_000}
            />
          ),
        },
      ],
      { initialEntries: ['/start'] },
    );
    const view = render(<RouterProvider router={first} />);
    expect(await screen.findByText('SPIGOT_GATE_KEY=gk_once')).toBeInTheDocument();
    view.unmount();
    expect(peekSiteKeys('fx-onboard-pending')).toBeNull();

    w03('fx-onboard-pending');
    expect(await screen.findByText(/Your keys were shown once/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Rotate in Settings' })).toHaveAttribute(
      'href',
      '/app/settings',
    );
    expect(screen.queryByText(/gk_once/)).not.toBeInTheDocument();
  });

  it('gate status polls: waiting → installed · last hit N s ago', async () => {
    let n = 0;
    const fetch = vi.fn<FetchLike>(async (url) => {
      if (url === '/api/sites/s1')
        return json(200, {
          ...connected,
          id: 's1',
          status: 'PENDING_VERIFY',
          lastGateSeenAt: null,
        });
      if (url === '/api/sites/s1/gate-status') {
        n += 1;
        return json(
          200,
          n === 1
            ? { installed: false, lastSeenAt: null, policyVersion: 1 }
            : {
                installed: true,
                lastSeenAt: new Date(Date.now() - 4_000).toISOString(),
                policyVersion: 1,
              },
        );
      }
      return apiError(500, 'INTERNAL_ERROR', url);
    });
    renderAt(
      <InstallVerify
        siteId="s1"
        client={createApiClient({ fetch, fixtures: false })}
        pollMs={30}
      />,
    );
    expect(await screen.findByLabelText(`Gate status: ${W03_COPY.waiting}`)).toBeInTheDocument();
    await waitFor(() =>
      expect(gateStatus()).toHaveTextContent(/^Installed · last hit [45] s ago$/),
    );
    expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent('Verify');
  });

  it('gate seen earlier but quiet for 10+ min', async () => {
    w03('fx-onboard-failed');
    await waitFor(() => expect(gateStatus()).toHaveTextContent(/^No recent hits · last hit/));
  });
});

describe('W03 first crawl', () => {
  it('verified, no run yet: Start first crawl posts once with an Idempotency-Key, then shows progress', async () => {
    const gate = deferred<Response>();
    const fetch = w03('fx-onboard-verified', {
      'POST /api/sites/fx-onboard-verified/crawl': () => gate.promise,
    });
    const start = await screen.findByRole('button', { name: 'Start first crawl' });
    await userEvent.click(start);
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Starting…' }));
    gate.resolve(json(202, { crawlRunId: 'r9', workflowRunId: 'inproc:r9' }));
    expect(await screen.findByText('Reading your sitemap…')).toBeInTheDocument();
    const posts = fetch.mock.calls.filter(([, init]) => init.method === 'POST');
    expect(posts).toHaveLength(1);
    expect((posts[0]![1].headers as Record<string, string>)['Idempotency-Key']).toMatch(
      /^w03-crawl-/,
    );
    expect(FakeEventSource.last?.url).toBe('/api/crawl-runs/r9/events');
  });

  it('a crawl already running (409 CRAWL_IN_PROGRESS) is joined, not duplicated', async () => {
    w03('fx-onboard-verified', {
      'POST /api/sites/fx-onboard-verified/crawl': () =>
        apiError(409, 'CRAWL_IN_PROGRESS', 'A crawl of this site is already running.', {
          crawlRunId: 'live-1',
          workflowRunId: 'inproc:live-1',
        }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Start first crawl' }));
    await waitFor(() => expect(FakeEventSource.last?.url).toBe('/api/crawl-runs/live-1/events'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a failed start keeps its own reason on screen (no run yet)', async () => {
    w03('fx-onboard-verified', {
      'POST /api/sites/fx-onboard-verified/crawl': () =>
        apiError(500, 'INTERNAL_ERROR', 'Spigot had a problem starting the crawl.'),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Start first crawl' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Spigot had a problem starting the crawl.');
    // Let any follow-up read settle: the reason must still be there, not the plain button.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole('alert')).toHaveTextContent('Spigot had a problem starting the crawl.');
    expect(screen.getByRole('button', { name: 'Retry crawl' })).toBeInTheDocument();
  });

  it('a failed retry shows the new reason, not the old run error', async () => {
    w03('fx-onboard-failed', {
      'POST /api/sites/fx-onboard-failed/crawl': () =>
        apiError(429, 'RATE_LIMITED', 'Too many crawl requests. Try again in a minute.'),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Retry crawl' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Too many crawl requests.'),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole('alert')).toHaveTextContent('Too many crawl requests.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('Your site returned 429');
  });

  it('crawling: progress bar from the run, then live SSE progress, then done → W05', async () => {
    w03('fx-onboard-crawling');
    const bar = await screen.findByRole('progressbar', { name: 'Crawl progress' });
    expect(bar).toHaveAttribute('aria-valuenow', '41');
    expect(screen.getByText(/2,469 pages found · 1,015 fetched · 3 failed/)).toBeInTheDocument();
    expect(gateStatus()).toHaveTextContent(/^Installed · last hit/);
    expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent('First crawl');

    await waitFor(() =>
      expect(FakeEventSource.last?.url).toBe('/api/crawl-runs/run-fx-onboard-crawling/events'),
    );
    const es = FakeEventSource.last!;
    const frame = (status: string, fetched: number) => ({
      crawlRunId: 'run-fx-onboard-crawling',
      status,
      pagesTotal: 2469,
      pagesFetched: fetched,
      pagesNotModified: 0,
      pagesFailed: 3,
    });
    act(() => es.emit('progress', frame('RUNNING', 2000)));
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '81');
    // An older frame never moves the bar back.
    act(() => es.emit('progress', frame('RUNNING', 1500)));
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '81');
    act(() => es.emit('done', frame('PARTIAL', 2466)));
    expect(await screen.findByRole('link', { name: 'See what we found' })).toHaveAttribute(
      'href',
      '/app/record-types',
    );
    expect(es.closed).toBe(true);
  });

  it('crawl failed: reason + retry', async () => {
    const fetch = w03('fx-onboard-failed', {
      'POST /api/sites/fx-onboard-failed/crawl': () =>
        json(202, { crawlRunId: 'r2', workflowRunId: 'inproc:r2' }),
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The crawl failed.');
    expect(alert).toHaveTextContent(
      'Your site returned 429. We paused and will retry after 10 min.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Retry crawl' }));
    await waitFor(() =>
      expect(fetch.mock.calls.some(([u, i]) => i.method === 'POST' && u.endsWith('/crawl'))).toBe(
        true,
      ),
    );
    await waitFor(() => expect(FakeEventSource.last?.url).toBe('/api/crawl-runs/r2/events'));
  });

  it('done: every step complete, link to W05', async () => {
    w03('fx-onboard-done');
    expect(await screen.findByRole('link', { name: 'See what we found' })).toBeInTheDocument();
    expect(screen.getByText('Done. We read 2,469 pages.')).toBeInTheDocument();
    expect(screen.queryByRole('listitem', { current: 'step' })).not.toBeInTheDocument();
  });

  it('site failed to load: banner with retry', async () => {
    let n = 0;
    const fetch = vi.fn<FetchLike>(async () =>
      ++n === 1
        ? apiError(503, 'INTERNAL_ERROR', 'Try again soon.')
        : json(200, { ...connected, id: 's1', lastGateSeenAt: null }),
    );
    renderAt(
      <InstallVerify
        siteId="s1"
        client={createApiClient({ fetch, fixtures: false })}
        streamEnabled={false}
      />,
    );
    expect(await screen.findByText("We couldn't load your site.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Not verified yet')).toBeInTheDocument();
  });
});

describe('expressSnippet', () => {
  it('is three lines and reads the key from the env', () => {
    const s = expressSnippet('https://spigot.onrender.com');
    expect(s.split('\n')).toHaveLength(3);
    expect(s).toContain("apiBase: 'https://spigot.onrender.com'");
    expect(s).not.toMatch(/gk_/);
  });
});
