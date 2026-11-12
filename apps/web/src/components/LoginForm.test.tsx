import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient, type FetchLike } from '../api/client';
import { LoginForm, safeNext } from './LoginForm';

function setup(fetch: FetchLike, entry = '/app/login') {
  const client = createApiClient({ fetch, fixtures: false });
  const router = createMemoryRouter(
    [
      {
        path: '/app/login',
        element: (
          <LoginForm
            endpoint="/api/auth/login"
            home="/app"
            title="Log in"
            subtitle="Publisher"
            signUp={{ to: '/app/signup', label: 'Connect your site' }}
            client={client}
          />
        ),
      },
      { path: '/app/*', element: <h1>Dashboard</h1> },
      { path: '/app', element: <h1>Dashboard</h1> },
    ],
    { initialEntries: [entry] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

async function fillAndSubmit(email = 'Owner@Example.com ', password = 'correct horse') {
  await userEvent.type(screen.getByLabelText('Email'), email);
  await userEvent.type(screen.getByLabelText('Password'), password);
  await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('LoginForm', () => {
  it('posts the credentials and goes to the dashboard', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(json(200, { publisherId: 'p1' }));
    const router = setup(fetch);
    await fillAndSubmit();
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/app');
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/auth/login');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'Owner@Example.com',
      password: 'correct horse',
    });
  });

  it('returns to ?next= inside the app', async () => {
    const router = setup(
      vi.fn<FetchLike>().mockResolvedValue(json(200, { publisherId: 'p1' })),
      '/app/login?next=%2Fapp%2Fearnings%3Frange%3D7d',
    );
    await fillAndSubmit();
    await screen.findByRole('heading', { name: 'Dashboard' });
    expect(router.state.location.pathname).toBe('/app/earnings');
    expect(router.state.location.search).toBe('?range=7d');
  });

  it("shows the API's message on a wrong password and lets the user try again", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        json(401, {
          error: { code: 'UNAUTHENTICATED', message: 'Email or password is incorrect.' },
        }),
      )
      .mockResolvedValueOnce(json(200, { publisherId: 'p1' }));
    setup(fetch);
    await fillAndSubmit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect.');
    const button = screen.getByRole('button', { name: 'Log in' });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('asks for both fields on a validation error', async () => {
    setup(
      vi
        .fn<FetchLike>()
        .mockResolvedValue(
          json(400, { error: { code: 'VALIDATION_ERROR', message: 'login: email invalid' } }),
        ),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter your email and password.');
  });

  it('says so when Spigot is unreachable', async () => {
    setup(vi.fn<FetchLike>().mockRejectedValue(new TypeError('Failed to fetch')));
    await fillAndSubmit();
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't reach Spigot");
  });

  it('submits once while a login is in flight', async () => {
    let resolve!: (r: Response) => void;
    const fetch = vi.fn<FetchLike>().mockReturnValue(new Promise((r) => (resolve = r)));
    setup(fetch);
    await fillAndSubmit();
    const button = screen.getByRole('button', { name: 'Logging in…' });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(fetch).toHaveBeenCalledOnce();
    resolve(json(200, { publisherId: 'p1' }));
    await screen.findByRole('heading', { name: 'Dashboard' });
  });

  it('links to sign up', () => {
    setup(vi.fn<FetchLike>());
    expect(screen.getByRole('link', { name: 'Connect your site' })).toHaveAttribute(
      'href',
      '/app/signup',
    );
  });
});

describe('safeNext', () => {
  it.each([
    [null, '/app'],
    ['/app/earnings', '/app/earnings'],
    ['/app', '/app'],
    ['/app?x=1', '/app?x=1'],
    ['/appx', '/app'],
    ['/buyers', '/app'],
    ['//evil.example/app', '/app'],
    ['https://evil.example/app', '/app'],
    ['/\\evil.example', '/app'],
  ])('%s → %s', (next, want) => {
    expect(safeNext(next, '/app')).toBe(want);
  });
});
