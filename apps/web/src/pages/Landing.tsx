import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Money, buttonClass } from '../components';
import { IconArrowRight, SpigotMark } from '../components/icons';
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

const navLink =
  'rounded-md px-2.5 py-1.5 text-sm font-medium text-body transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-focus';
const codeBlock =
  'max-w-full overflow-x-auto p-4 font-mono text-xs leading-relaxed text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus';

/** A code sample in a titled panel. */
function CodePanel({
  title,
  file,
  caption,
  children,
}: {
  title: string;
  /** The file or endpoint the sample belongs to, shown beside the title. */
  file?: string;
  /** One line telling the visitor what to do with the sample. */
  caption?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-line bg-surface shadow-card">
      <div className="border-b border-line bg-surface-2 px-4 py-2.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          {file && <span className="font-mono text-2xs text-muted">{file}</span>}
        </div>
        {caption && <p className="mt-0.5 text-xs text-muted">{caption}</p>}
      </div>
      {children}
    </div>
  );
}

/** W05's proposal card, shrunk to a picture: what Claude found on the demo site. */
function MiniProposalCard() {
  return (
    <figure className="relative min-w-0 lg:pl-6">
      <div className="rounded-xl border border-line bg-surface p-5 shadow-overlay sm:p-6">
        <p className="text-sm font-medium text-accent">I found 3 kinds of records on your site</p>
        <div className="mt-4 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-lg font-semibold text-ink">Listing · 2,341</p>
            <code className="mt-0.5 block font-mono text-xs text-muted">/listings/:slug</code>
          </div>
          <span className="inline-flex h-5 items-center rounded-full bg-info-tint px-2 text-xs font-medium text-info">
            JSON-LD
          </span>
        </div>
        <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          {MINI_FIELDS.map(([name, example]) => (
            <div key={name} className="min-w-0">
              <dt className="font-mono text-xs text-muted">{name}</dt>
              <dd className="truncate text-ink">{example}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 inline-flex flex-wrap items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs">
          <span className="font-mono text-muted line-through">agent_phone</span>
          <span className="inline-flex h-4 items-center rounded-full bg-warning-tint px-1.5 text-2xs font-medium text-warning">
            PII
          </span>
          <span className="text-muted">hidden</span>
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <span className="text-sm text-muted">
            Suggested price{' '}
            <Money micros={1500} per1000="records" className="font-semibold text-money" />
          </span>
          <span className={buttonClass({ size: 'sm', className: 'pointer-events-none' })}>
            Review
          </span>
        </div>
      </div>
      <figcaption className="mt-3 text-sm text-muted lg:pl-1">
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
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-ink focus:shadow-overlay"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b border-line bg-canvas/90 backdrop-blur-md">
        <nav
          aria-label="Main"
          className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-2 px-4 sm:px-6"
        >
          <Link
            to={paths.landing}
            className="flex items-center gap-2 rounded-md text-md font-semibold tracking-tight text-ink"
          >
            <SpigotMark size={22} className="text-accent" />
            Spigot
          </Link>
          <ul className="flex items-center gap-1">
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
              <Link to={paths.login} className={buttonClass({ variant: 'secondary', size: 'sm' })}>
                Publisher sign in
              </Link>
            </li>
          </ul>
        </nav>
      </header>

      <main id="main">
        <section
          aria-labelledby="hero-title"
          className="mx-auto max-w-6xl px-4 pt-14 pb-16 sm:px-6 sm:pt-20 lg:pt-24 lg:pb-24"
        >
          <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-10">
            <div className="min-w-0">
              <h1
                id="hero-title"
                className="max-w-[14ch] text-4xl font-semibold text-ink sm:text-5xl lg:text-[4.25rem] lg:leading-[1]"
              >
                Turn your site into a paid API for AI agents
              </h1>
              <p className="mt-6 max-w-xl text-lg text-body sm:text-xl sm:leading-8">
                Scrapers pay Bright Data. Spigot makes them pay you.
              </p>
              <div className="mt-9 flex flex-col gap-3 sm:flex-row">
                <Link to={paths.signUp} className={buttonClass({ size: 'lg' })}>
                  Connect your site
                  <IconArrowRight size={15} />
                </Link>
                <Link
                  to={paths.buyerPortal}
                  className={buttonClass({ variant: 'secondary', size: 'lg' })}
                >
                  I'm an agent builder
                </Link>
              </div>
              <p className="mt-12 max-w-xl border-t border-line pt-5 text-base text-body">
                <strong className="block text-xl font-semibold text-ink sm:text-2xl">
                  1 AI bot for every 31 human visits
                </strong>
                <span className="mt-1 inline-block">Up from 1 in 200.</span>{' '}
                <a
                  href={STAT_SOURCE_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-muted underline decoration-border hover:text-ink hover:decoration-current"
                >
                  Source: TollBit, Q4 2025
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </p>
            </div>
            <MiniProposalCard />
          </div>
        </section>

        <section
          id="how"
          aria-labelledby="how-title"
          className="scroll-mt-14 border-t border-line bg-surface"
        >
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-24">
            <div className="max-w-2xl">
              <h2 id="how-title" className="text-3xl font-semibold text-ink">
                How it works
              </h2>
              <p className="mt-3 text-md text-body">
                From your first bot hit to your first PayPal payout, in four steps.
              </p>
            </div>
            <ol className="mt-12 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
              {STEPS.map((s, i) => (
                <li key={s.title} className="relative border-t border-border pt-5">
                  <span
                    aria-hidden="true"
                    className={`absolute -top-px left-0 h-px w-10 ${i === STEPS.length - 1 ? 'bg-money' : 'bg-accent'}`}
                  />
                  <span aria-hidden="true" className="font-mono text-xs text-muted tabular-nums">
                    Step {i + 1}
                  </span>
                  <h3 className="mt-2 text-lg font-semibold text-ink">{s.title}</h3>
                  <p className="mt-2 text-base text-body">{s.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section
          id="agents"
          aria-labelledby="agents-title"
          className="scroll-mt-14 border-t border-line"
        >
          <div className="mx-auto grid max-w-6xl gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:py-24">
            <div className="min-w-0 lg:sticky lg:top-24 lg:self-start">
              <h2 id="agents-title" className="text-3xl font-semibold text-ink">
                For agents
              </h2>
              <p className="mt-3 text-md text-body">
                Typed records and a change feed instead of HTML. Pay per record from a balance you
                top up with PayPal; every response says what it charged. Use the MCP server from
                Claude Desktop or call the REST API.
              </p>
              <dl className="mt-8 divide-y divide-line border-y border-line text-base">
                <div className="flex items-baseline justify-between gap-4 py-3">
                  <dt className="text-muted">Price</dt>
                  <dd className="text-ink">
                    <Money micros={1500} per1000="records" />
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-4 py-3">
                  <dt className="text-muted">37 records</dt>
                  <dd className="font-medium text-money">
                    <Money micros={55500} word="charged" />
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-4 py-3">
                  <dt className="text-muted">Balance</dt>
                  <dd className="text-ink">Top up with PayPal</dd>
                </div>
              </dl>
            </div>
            <div className="min-w-0 space-y-4">
              <CodePanel
                title="Claude Desktop (MCP)"
                file="claude_desktop_config.json"
                caption={
                  <>
                    Add to <code className="font-mono">claude_desktop_config.json</code> with your
                    API key.
                  </>
                }
              >
                <pre tabIndex={0} aria-label="MCP config" className={codeBlock}>
                  {mcpConfig}
                </pre>
              </CodePanel>
              <CodePanel title="REST API" file="GET /v1/:site/datasets/:dataset/records">
                <pre tabIndex={0} aria-label="Sample request" className={codeBlock}>
                  {sampleRequest()}
                </pre>
                <pre
                  tabIndex={0}
                  aria-label="Sample JSON response"
                  className={`${codeBlock} max-h-80 border-t border-line`}
                >
                  {SAMPLE_RESPONSE}
                </pre>
              </CodePanel>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
