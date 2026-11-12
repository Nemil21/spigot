import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { paths } from '../routes';
import LandingPage, { STAT_SOURCE_URL, STEPS, sampleRequest } from './Landing';

function setup() {
  const router = createMemoryRouter(
    [
      { path: paths.landing, element: <LandingPage /> },
      { path: paths.signUp, element: <h1>W02 sign up</h1> },
      { path: paths.buyerPortal, element: <h1>W11 buyer portal</h1> },
    ],
    { initialEntries: [paths.landing] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe('W01 Landing (SP-057)', () => {
  it('shows the hero, pitch line and sourced stat', () => {
    setup();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Make AI bots pay for your site.' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View demo' })).toHaveAttribute('href', paths.login);
    expect(screen.getByText('1 AI bot for every 31 human visits')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Source: TollBit/ })).toHaveAttribute(
      'href',
      STAT_SOURCE_URL,
    );
  });

  it('"Connect your site" goes to W02', async () => {
    const router = setup();
    const main = screen.getByRole('main');
    await userEvent.click(within(main).getByRole('link', { name: 'Connect your site' }));
    expect(router.state.location.pathname).toBe(paths.signUp);
    expect(await screen.findByRole('heading', { name: 'W02 sign up' })).toBeInTheDocument();
  });

  it('"I\'m an agent builder" goes to W11', async () => {
    const router = setup();
    const main = screen.getByRole('main');
    await userEvent.click(within(main).getByRole('link', { name: "I'm an agent builder" }));
    expect(router.state.location.pathname).toBe(paths.buyerPortal);
    expect(await screen.findByRole('heading', { name: 'W11 buyer portal' })).toBeInTheDocument();
  });

  it('lists the 4 how-it-works steps in order', () => {
    setup();
    const how = screen.getByRole('list', { name: 'How it works' });
    const steps = within(how)
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(steps).toEqual([
      'Install',
      'See your bots',
      'Approve the schema',
      'Get paid via PayPal',
    ]);
    expect(STEPS).toHaveLength(4);
  });

  it('shows a mini proposal card with a per-1,000 price', () => {
    setup();
    expect(screen.getByText('I found 3 kinds of records on your site')).toBeInTheDocument();
    expect(screen.getByText('Listing · 2,341')).toBeInTheDocument();
    expect(screen.getAllByText('$1.50 / 1,000 records').length).toBeGreaterThan(0);
  });

  it('shows agents a paid REST call and what it charged', () => {
    setup();
    const agents = screen.getByRole('region', { name: 'Typed records, not HTML.' });
    expect(within(agents).getByLabelText('Sample request').textContent).toBe(sampleRequest());
    expect(within(agents).getByText('$0.0555 charged')).toBeInTheDocument();
  });

  it('has pricing and a footer', () => {
    setup();
    const pricing = screen.getByRole('region', { name: 'You set the price. Spigot takes 20%.' });
    expect(within(pricing).getByText('20%')).toBeInTheDocument();
    expect(within(pricing).getByText('$5')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toHaveTextContent('© 2026 Spigot');
  });

  it('builds the sample request on this origin with bracket filters', () => {
    expect(sampleRequest('https://spigot.example/')).toContain(
      '"https://spigot.example/v1/bluebonnet/datasets/listings/records?city=Austin&bedrooms[gte]=3&limit=50"',
    );
    expect(sampleRequest('https://spigot.example')).toMatch(/^curl -g /);
  });
});
