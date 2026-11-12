import { useId, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { Accent, Money, buttonClass } from '../components';
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
    chip: 'Fails open',
    body: 'Add the Spigot gate to your site: one npm package, three lines of Express. It fails open, so if Spigot is down your site keeps working.',
  },
  {
    title: 'See your bots',
    chip: 'Live report',
    body: "A live report of who's crawling you: GPTBot, ClaudeBot, scrapers, and how many hits each one costs you.",
  },
  {
    title: 'Approve the schema',
    chip: 'No AI per page',
    body: 'Claude reads your pages once and proposes record types with an extractor. You pick the fields and the price; no AI runs per page after that.',
  },
  {
    title: 'Get paid via PayPal',
    chip: 'PayPal Payouts',
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
  'label rounded-sm px-2.5 py-1.5 text-xs text-body transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-focus';
const codeBlock =
  'max-w-full overflow-x-auto p-4 font-mono text-xs leading-relaxed text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus';
const column = 'mx-auto w-full max-w-[1120px] px-4 sm:px-6 lg:px-0';

/** "Get paid via PayPal" → "Get paid via " + accent "PayPal". */
function AccentLast({ text }: { text: string }) {
  const i = text.lastIndexOf(' ');
  if (i < 0) return <Accent>{text}</Accent>;
  return (
    <>
      {text.slice(0, i + 1)}
      <Accent>{text.slice(i + 1)}</Accent>
    </>
  );
}

/** W05's proposal card, shrunk to a picture: what Claude found on the demo site. */
function MiniProposalCard() {
  return (
    <figure className="min-w-0">
      <div className="rounded-lg border border-line bg-surface p-5 shadow-raised sm:p-6">
        <p className="label text-2xs text-accent">I found 3 kinds of records on your site</p>
        <div className="mt-4 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-lg font-semibold text-ink">Listing · 2,341</p>
            <code className="mt-0.5 block font-mono text-xs text-muted">/listings/:slug</code>
          </div>
          <span className="label inline-flex h-5 items-center rounded-xs bg-info-tint px-1.5 text-2xs text-info">
            JSON-LD
          </span>
        </div>
        <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line pt-4 text-sm">
          {MINI_FIELDS.map(([name, example]) => (
            <div key={name} className="min-w-0">
              <dt className="font-mono text-xs text-muted">{name}</dt>
              <dd className="truncate text-ink">{example}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 inline-flex flex-wrap items-center gap-1.5 rounded-sm border border-line px-2 py-1 text-xs">
          <span className="font-mono text-muted line-through">agent_phone</span>
          <span className="label inline-flex h-4 items-center rounded-xs bg-warning-tint px-1 text-2xs text-warning">
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
      <figcaption className="mt-3 text-sm text-muted">
        Claude wrote the extractor once. It now runs with no AI on each page.
      </figcaption>
    </figure>
  );
}

/** Code card with tabs (MCP / REST). Every panel stays in the DOM; inactive ones are `hidden`. */
function AgentCode({ mcpConfig }: { mcpConfig: string }) {
  const id = useId();
  const tabs = ['mcp', 'rest'] as const;
  const [tab, setTab] = useState<(typeof tabs)[number]>('mcp');
  const labels = { mcp: 'Claude Desktop (MCP)', rest: 'REST API' } as const;

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = tabs[(tabs.indexOf(tab) + 1) % tabs.length]!;
    setTab(next);
    document.getElementById(`${id}-tab-${next}`)?.focus();
  }

  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-line bg-surface">
      <div
        role="tablist"
        aria-label="Connect an agent"
        className="flex gap-1 border-b border-line bg-surface-2 px-2 pt-2"
      >
        {tabs.map((t) => (
          <button
            key={t}
            id={`${id}-tab-${t}`}
            type="button"
            role="tab"
            aria-selected={tab === t}
            aria-controls={`${id}-panel-${t}`}
            tabIndex={tab === t ? 0 : -1}
            onClick={() => setTab(t)}
            onKeyDown={onKeyDown}
            className={`label -mb-px rounded-t-sm border px-3 py-2 text-2xs transition-colors ${
              tab === t
                ? 'border-line border-b-surface bg-surface text-ink'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {labels[t]}
          </button>
        ))}
      </div>

      <div
        id={`${id}-panel-mcp`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-mcp`}
        hidden={tab !== 'mcp'}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-4 pt-4">
          <h3 className="text-sm font-semibold text-ink">{labels.mcp}</h3>
          <span className="font-mono text-2xs text-muted">claude_desktop_config.json</span>
        </div>
        <p className="mt-0.5 px-4 text-xs text-muted">
          Add to <code className="font-mono">claude_desktop_config.json</code> with your API key.
        </p>
        <pre tabIndex={0} aria-label="MCP config" className={codeBlock}>
          {mcpConfig}
        </pre>
      </div>

      <div
        id={`${id}-panel-rest`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-rest`}
        hidden={tab !== 'rest'}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-4 pt-4">
          <h3 className="text-sm font-semibold text-ink">{labels.rest}</h3>
          <span className="font-mono text-2xs text-muted">
            GET /v1/:site/datasets/:dataset/records
          </span>
        </div>
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
      </div>
    </div>
  );
}

export default function LandingPage() {
  const mcpConfig = claudeDesktopConfig(mcpUrl(), 'sk_spg_…');

  return (
    <div className="min-h-screen bg-canvas text-body" data-screen="W01">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:rounded-sm focus:bg-surface focus:px-3 focus:py-2 focus:text-ink focus:shadow-overlay"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b border-line bg-canvas/90 backdrop-blur-md">
        <nav aria-label="Main" className={`${column} flex h-16 items-center justify-between gap-2`}>
          <Link
            to={paths.landing}
            className="flex items-center gap-2 rounded-sm text-lg font-semibold tracking-tight text-ink"
          >
            <SpigotMark size={24} className="text-accent" />
            Spigot
          </Link>
          <ul className="flex items-center gap-1 sm:gap-2">
            <li className="hidden md:block">
              <a href="#how" className={navLink}>
                How it works
              </a>
            </li>
            <li className="hidden md:block">
              <a href="#agents" className={navLink}>
                For agents
              </a>
            </li>
            <li>
              <Link to={paths.login} className={buttonClass({ variant: 'secondary' })}>
                Publisher sign in
              </Link>
            </li>
          </ul>
        </nav>
      </header>

      <main id="main">
        <section
          aria-labelledby="hero-title"
          className={`${column} pt-14 pb-16 sm:pt-20 lg:pt-28 lg:pb-28`}
        >
          <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-16">
            <div className="min-w-0">
              <h1
                id="hero-title"
                className="max-w-[15ch] text-4xl font-semibold text-ink sm:text-5xl lg:text-[4.25rem] lg:leading-[1.02]"
              >
                Turn your site into a paid API for AI <Accent>agents</Accent>
              </h1>
              <p className="mt-6 max-w-xl text-lg text-body sm:text-xl sm:leading-8">
                Scrapers pay Bright Data. Spigot makes them pay you.
              </p>
              <div className="mt-9 flex flex-col gap-3 sm:flex-row">
                <Link to={paths.signUp} className={buttonClass({ size: 'lg' })}>
                  Connect your site
                  <IconArrowRight size={14} />
                </Link>
                <Link
                  to={paths.buyerPortal}
                  className={buttonClass({ variant: 'secondary', size: 'lg' })}
                >
                  I'm an agent builder
                </Link>
              </div>
              <p className="mt-12 max-w-xl border-t border-line pt-5 text-base text-body">
                <strong className="marker text-xl font-semibold text-ink sm:text-2xl">
                  1 AI bot for every 31 human visits
                </strong>
                <span className="mt-2 block">
                  Up from 1 in 200.{' '}
                  <a
                    href={STAT_SOURCE_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-xs text-muted underline decoration-border hover:text-ink hover:decoration-current"
                  >
                    Source: TollBit, Q4 2025
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                </span>
              </p>
            </div>
            <MiniProposalCard />
          </div>
        </section>

        <section
          id="how"
          aria-labelledby="how-title"
          className="scroll-mt-16 border-t border-line bg-surface"
        >
          <div className={`${column} py-16 lg:py-24`}>
            <div className="max-w-2xl">
              <h2 id="how-title" className="text-3xl font-semibold text-ink sm:text-4xl">
                How it <Accent>works</Accent>
              </h2>
              <p className="mt-3 text-md text-body">
                From your first bot hit to your first PayPal payout, in four steps.
              </p>
            </div>
            <ol className="mt-14 grid gap-x-10 gap-y-12 sm:grid-cols-2 lg:grid-cols-4">
              {STEPS.map((s, i) => (
                <li key={s.title} className="relative border-t border-ink pt-5">
                  {i < STEPS.length - 1 && (
                    <IconArrowRight
                      size={14}
                      className="absolute top-5 -right-7 hidden text-accent lg:block"
                    />
                  )}
                  <span aria-hidden="true" className="font-mono text-xs text-muted tabular-nums">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <h3 className="mt-3 text-xl font-semibold text-ink">
                    <AccentLast text={s.title} />
                  </h3>
                  <p className="mt-2 text-base text-body">{s.body}</p>
                  <span className="label mt-4 inline-flex h-5 items-center rounded-xs bg-accent-tint px-1.5 text-2xs text-accent-strong">
                    {s.chip}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section
          id="agents"
          aria-labelledby="agents-title"
          className="scroll-mt-16 border-t border-line"
        >
          <div
            className={`${column} grid gap-12 py-16 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-16 lg:py-24`}
          >
            <div className="min-w-0 lg:sticky lg:top-28 lg:self-start">
              <h2 id="agents-title" className="text-3xl font-semibold text-ink sm:text-4xl">
                For <Accent>agents</Accent>
              </h2>
              <p className="mt-3 text-md text-body">
                Typed records and a change feed instead of HTML. Pay per record from a balance you
                top up with PayPal; every response says what it charged. Use the MCP server from
                Claude Desktop or call the REST API.
              </p>
              <dl className="mt-8 divide-y divide-line border-y border-line text-base">
                <div className="flex items-baseline justify-between gap-4 py-3">
                  <dt className="label text-2xs text-muted">Price</dt>
                  <dd className="text-ink">
                    <Money micros={1500} per1000="records" />
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-4 py-3">
                  <dt className="label text-2xs text-muted">37 records</dt>
                  <dd className="font-medium text-money">
                    <Money micros={55500} word="charged" />
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-4 py-3">
                  <dt className="label text-2xs text-muted">Balance</dt>
                  <dd className="text-ink">Top up with PayPal</dd>
                </div>
              </dl>
              <Link
                to={paths.buyerPortal}
                className={buttonClass({ variant: 'dark', className: 'mt-8' })}
              >
                Get an API key
                <IconArrowRight size={14} />
              </Link>
            </div>
            <AgentCode mcpConfig={mcpConfig} />
          </div>
        </section>
      </main>
    </div>
  );
}
