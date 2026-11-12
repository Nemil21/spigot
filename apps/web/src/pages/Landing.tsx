import { Link } from 'react-router';
import { Money } from '../components';
import { claudeDesktopConfig, mcpUrl } from '../components/buyer/ClaudeConfig';
import { paths } from '../routes';

/**
 * W01 Landing (SP-057; screens.md §W01, features/16 §Landing): one static page for judges and
 * visitors. Hero, two CTAs (W02 sign up, W11 buyer portal), the sourced bot stat, how it works,
 * a mini proposal card, a "for agents" block. Responsive to 375 px.
 *
 * The proposal card is a static picture of W05's card, not `ProposalCard` itself, so the landing
 * chunk doesn't pull in AG Grid.
 */

/** TollBit's scraper index, Q4 2025 (docs/research/15-gstack-spigot.md). */
export const STAT_SOURCE_URL = 'https://tollbit.com/blog/scraper-index-and-audit/';

export const STEPS = [
  {
    title: 'Install',
    body: 'Add the Spigot gate to your site: one npm package, three lines of Express. It fails open, so if Spigot is down your site keeps working.',
  },
  {
    title: 'See your bots',
    body: "A live report of who's crawling you: GPTBot, ClaudeBot, scrapers, and how many hits each one costs you.",
  },
  {
    title: 'Approve the schema',
    body: 'Claude reads your pages once and proposes record types with an extractor. You pick the fields and the price; no AI runs per page after that.',
  },
  {
    title: 'Get paid via PayPal',
    body: 'Bots get a 402 pointing at your paid API. Agents top up with PayPal, every call is metered, and your earnings are paid out via PayPal Payouts.',
  },
] as const;


/** A paid read and its response (api.md §`GET /v1/:site/datasets/:dataset/records`). */
export function sampleRequest(origin: string = window.location.origin): string {
  return `curl -g -H "Authorization: Bearer sk_spg_…" \\
  "${origin.replace(/\/+$/, '')}/v1/bluebonnet/datasets/listings/records?city=Austin&bedrooms[gte]=3&limit=50"`;
}

export const SAMPLE_RESPONSE = JSON.stringify(
  {
    records: [
      {
        key: 'listings/2br-east-cesar-chavez-4471',
        data: {
          title: 'Bungalow near East Cesar Chavez',
          price_usd: 1850,
          bedrooms: 3,
          city: 'Austin',
          url: 'https://bluebonnet-rentals.onrender.com/listings/2br-east-cesar-chavez-4471',
        },
        version: 4,
        freshness: { crawledAt: '2026-11-12T09:14:00Z', staleSince: null },
      },
    ],
    next: 'eyJ…',
    charged: { records: 37, priceMicros: 55500 },
    balanceMicros: 19943000,
  },
  null,
  2,
);

const MINI_FIELDS = [
  ['title', 'Bungalow near East Cesar Chavez'],
  ['price_usd', '1850'],
  ['bedrooms', '3'],
  ['city', 'Austin'],
] as const;

const primaryCta =
  'inline-flex items-center justify-center rounded-md bg-accent px-4 py-2.5 font-medium text-on-accent hover:bg-accent-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';
const secondaryCta =
  'inline-flex items-center justify-center rounded-md border border-border bg-surface px-4 py-2.5 font-medium text-ink hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';
const navLink =
  'rounded-md px-2 py-1 text-sm font-medium text-body hover:text-ink focus-visible:outline-2 focus-visible:outline-focus';
const codeBlock =
  'mt-2 max-w-full overflow-x-auto rounded-md bg-surface-2 p-3 font-mono text-xs leading-relaxed text-ink focus-visible:outline-2 focus-visible:outline-focus';

/** W05's proposal card, shrunk to a picture: what Claude found on the demo site. */
function MiniProposalCard() {
  return (
    <figure className="min-w-0">
      <div className="rounded-lg border border-line bg-surface p-5 shadow-card">
        <p className="text-sm font-medium text-accent-strong">
          I found 3 kinds of records on your site
        </p>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-lg font-semibold text-ink">Listing · 2,341</p>
            <code className="block text-sm text-muted">/listings/:slug</code>
          </div>
          <span className="rounded-full bg-info-tint px-2 py-0.5 text-xs font-medium text-info">
            JSON-LD
          </span>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          {MINI_FIELDS.map(([name, example]) => (
            <div key={name} className="min-w-0">
              <dt className="font-mono text-ink">{name}</dt>
              <dd className="truncate text-body">{example}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 inline-flex flex-wrap items-center gap-1 rounded-md border border-line px-2 py-0.5 text-xs">
          <span className="font-mono text-muted line-through">agent_phone</span>
          <span className="rounded-full bg-warning-tint px-2 py-0.5 font-medium text-warning">
            PII
          </span>
          <span className="text-muted">hidden</span>
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          <span className="text-sm text-muted">
            Suggested price{' '}
            <Money micros={1500} per1000="records" className="font-medium text-money" />
          </span>
          <span className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent">
            Review
          </span>
        </div>
      </div>
      <figcaption className="mt-2 text-sm text-muted">
        Claude wrote the extractor once. It now runs with no AI on each page.
      </figcaption>
    </figure>
  );
}

export default function LandingPage() {
  const mcpConfig = claudeDesktopConfig(mcpUrl(), 'sk_spg_…');

  return (
    <div className="min-h-screen bg-canvas text-body" data-screen="W01">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-ink"
      >
        Skip to content
      </a>
      <header className="border-b border-line bg-surface">
        <nav
          aria-label="Main"
          className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6"
        >
          <Link to={paths.landing} className="text-lg font-semibold text-accent">
            Spigot
          </Link>
          <ul className="flex flex-wrap items-center gap-1">
            <li className="hidden sm:block">
              <a href="#how" className={navLink}>
                How it works
              </a>
            </li>
            <li className="hidden sm:block">
              <a href="#agents" className={navLink}>
                For agents
              </a>
            </li>
            <li>
              <Link to={paths.login} className={navLink}>
                Publisher sign in
              </Link>
            </li>
          </ul>
        </nav>
      </header>

      <main id="main">
        <section
          aria-labelledby="hero-title"
          className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20"
        >
          <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
            <div className="min-w-0">
              <h1
                id="hero-title"
                className="text-3xl font-semibold tracking-tight text-ink sm:text-5xl"
              >
                Turn your site into a paid API for AI agents
              </h1>
              <p className="mt-4 text-lg text-body sm:text-xl">
                Scrapers pay Bright Data. Spigot makes them pay you.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Link to={paths.signUp} className={primaryCta}>
                  Connect your site
                </Link>
                <Link to={paths.buyerPortal} className={secondaryCta}>
                  I'm an agent builder
                </Link>
              </div>
              <p className="mt-8 rounded-md border border-accent/30 bg-accent-tint px-4 py-3 text-ink">
                <strong className="font-semibold">1 AI bot for every 31 human visits</strong>, up
                from 1 in 200.{' '}
                <a
                  href={STAT_SOURCE_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-accent-strong underline underline-offset-2"
                >
                  Source: TollBit, Q4 2025
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </p>
            </div>
            <MiniProposalCard />
          </div>
        </section>

        <section id="how" aria-labelledby="how-title" className="border-t border-line bg-surface">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
            <h2 id="how-title" className="text-2xl font-semibold text-ink">
              How it works
            </h2>
            <ol className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {STEPS.map((s, i) => (
                <li key={s.title} className="rounded-lg border border-line bg-canvas p-5">
                  <span
                    aria-hidden="true"
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-sm font-semibold text-on-accent"
                  >
                    {i + 1}
                  </span>
                  <h3 className="mt-3 font-semibold text-ink">{s.title}</h3>
                  <p className="mt-1 text-sm text-body">{s.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="agents" aria-labelledby="agents-title" className="border-t border-line">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
            <h2 id="agents-title" className="text-2xl font-semibold text-ink">
              For agents
            </h2>
            <p className="mt-2 max-w-3xl text-body">
              Typed records and a change feed instead of HTML. Pay per record from a balance you top
              up with PayPal; every response says what it charged. Use the MCP server from Claude
              Desktop or call the REST API.
            </p>
            <div className="mt-8 grid gap-6 lg:grid-cols-2">
              <div className="min-w-0">
                <h3 className="font-semibold text-ink">Claude Desktop (MCP)</h3>
                <p className="mt-1 text-sm text-muted">
                  Add to <code className="font-mono text-xs">claude_desktop_config.json</code> with
                  your API key.
                </p>
                <pre tabIndex={0} aria-label="MCP config" className={codeBlock}>
                  {mcpConfig}
                </pre>
              </div>
              <div className="min-w-0">
                <h3 className="font-semibold text-ink">REST API</h3>
                <p className="mt-1 text-sm text-muted">
                  37 records at <Money micros={1500} per1000="records" />:{' '}
                  <Money micros={55500} word="charged" />.
                </p>
                <pre tabIndex={0} aria-label="Sample request" className={codeBlock}>
                  {sampleRequest()}
                </pre>
                <pre tabIndex={0} aria-label="Sample JSON response" className={codeBlock}>
                  {SAMPLE_RESPONSE}
                </pre>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
