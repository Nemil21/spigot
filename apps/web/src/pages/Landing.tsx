import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router';
import { Money } from '../components';
import { Logo } from '../components/Brand';
import { paths } from '../routes';

/**
 * W01 Landing (SP-057; Figma "Landing / Hero", "/ Features", "/ Pricing", "/ Footer"). The hero is
 * laid out in Figma's 1440-wide units (`--u`), so it scales with the viewport like the frame.
 * Static page: no API calls, so the landing chunk stays small.
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

/** Frosted pill used by every hero nav item. */
const glass =
  'flex items-center rounded-[calc(8*var(--u))] border border-white/10 bg-white/12 text-white backdrop-blur-md hover:bg-white/16';

/** "Scrape from" strip: sites people scrape (simple-icons paths, CC0). */
const SCRAPE_FROM: readonly (readonly [string, string])[] = [
  [
    'Swiggy',
    'M12.034 24c-.376-.411-2.075-2.584-3.95-5.513-.547-.916-.901-1.63-.833-1.814.178-.48 3.355-.743 4.333-.308.298.132.29.307.29.409 0 .44-.022 1.619-.022 1.619a.441.441 0 1 0 .883-.002l-.005-2.939c0-.255-.278-.319-.331-.329-.511-.002-1.548-.006-2.661-.006-2.457 0-3.006.101-3.423-.172-.904-.591-2.383-4.577-2.417-6.819C3.849 4.964 5.723 2.225 8.362.868A8.13 8.13 0 0 1 12.026 0c4.177 0 7.617 3.153 8.075 7.209l.001.011c.084.981-5.321 1.189-6.39.904-.164-.044-.206-.212-.206-.284L13.5 4.996a.442.442 0 0 0-.884.002l.009 3.866a.33.33 0 0 0 .268.32l3.354-.001c1.79 0 2.542.207 3.042.588.333.254.461.739.349 1.37C18.633 16.755 12.273 23.71 12.034 24z',
  ],
  [
    'Instacart',
    'M15.629 9.619c1.421 1.429 2.58 3.766 1.917 5.152-1.778 3.715-15.04 10.226-16.169 9.1C.252 22.746 6.768 9.476 10.481 7.697c1.388-.66 3.724.51 5.152 1.92l-.005.014v-.012zm7.028-1.566c-.231-.855-.821-1.717-1.7-1.82-1.61-.186-4.151 2.663-3.971 3.339.181.69 3.766 1.875 5.1.915.691-.494.781-1.56.556-2.414l.015-.02zM17.666.158c1.198.324 2.407 1.148 2.551 2.382.261 2.259-3.732 5.819-4.68 5.564-.948-.251-2.618-5.284-1.269-7.162.695-.972 2.201-1.106 3.399-.788v.004h-.001z',
  ],
  [
    'DoorDash',
    'M23.071 8.409a6.09 6.09 0 00-5.396-3.228H.584A.589.589 0 00.17 6.184L3.894 9.93a1.752 1.752 0 001.242.516h12.049a1.554 1.554 0 11.031 3.108H8.91a.589.589 0 00-.415 1.003l3.725 3.747a1.75 1.75 0 001.242.516h3.757c4.887 0 8.584-5.225 5.852-10.413',
  ],
  [
    'Flipkart',
    'M3.833 1.333a.993.993 0 0 0-.333.061V1c0-.551.449-1 1-1h14.667c.551 0 1 .449 1 1v.333H3.833zm17.334 2.334H2.833c-.551 0-1 .449-1 1V23c0 .551.449 1 1 1h7.3l1.098-5.645h-2.24c-.051 0-5.158-.241-5.158-.241l4.639-.327-.078-.366-1.978-.285 1.882-.158-.124-.449-3.075-.467s3.341-.373 3.392-.373h3.232l.247-1.331c.289-1.616.945-2.807 1.973-3.693 1.033-.892 2.344-1.332 3.937-1.332.643 0 1.053.151 1.231.463.118.186.201.516.279.859.074.352.14.671.095.903-.057.345-.461.465-1.197.465h-.253c-1.327 0-2.134.763-2.405 2.31l-.243 1.355h1.54c.574 0 .781.402.622 1.306-.17.941-.539 1.36-1.111 1.36H14.9L13.804 24h7.362c.551 0 1-.449 1-1V4.667a1 1 0 0 0-.999-1zM20.5 2.333A.334.334 0 0 0 20.167 2H3.833a.334.334 0 0 0-.333.333V3h17v-.667z',
  ],
  [
    'Airbnb',
    'M12.001 18.275c-1.353-1.697-2.148-3.184-2.413-4.457-.263-1.027-.16-1.848.291-2.465.477-.71 1.188-1.056 2.121-1.056s1.643.345 2.12 1.063c.446.61.558 1.432.286 2.465-.291 1.298-1.085 2.785-2.412 4.458zm9.601 1.14c-.185 1.246-1.034 2.28-2.2 2.783-2.253.98-4.483-.583-6.392-2.704 3.157-3.951 3.74-7.028 2.385-9.018-.795-1.14-1.933-1.695-3.394-1.695-2.944 0-4.563 2.49-3.927 5.382.37 1.565 1.352 3.343 2.917 5.332-.98 1.085-1.91 1.856-2.732 2.333-.636.344-1.245.558-1.828.609-2.679.399-4.778-2.2-3.825-4.88.132-.345.395-.98.845-1.961l.025-.053c1.464-3.178 3.242-6.79 5.285-10.795l.053-.132.58-1.116c.45-.822.635-1.19 1.351-1.643.346-.21.77-.315 1.246-.315.954 0 1.698.558 2.016 1.007.158.239.345.557.582.953l.558 1.089.08.159c2.041 4.004 3.821 7.608 5.279 10.794l.026.025.533 1.22.318.764c.243.613.294 1.222.213 1.858zm1.22-2.39c-.186-.583-.505-1.271-.9-2.094v-.03c-1.889-4.006-3.642-7.608-5.307-10.844l-.111-.163C15.317 1.461 14.468 0 12.001 0c-2.44 0-3.476 1.695-4.535 3.898l-.081.16c-1.669 3.236-3.421 6.843-5.303 10.847v.053l-.559 1.22c-.21.504-.317.768-.345.847C-.172 20.74 2.611 24 5.98 24c.027 0 .132 0 .265-.027h.372c1.75-.213 3.554-1.325 5.384-3.317 1.829 1.989 3.635 3.104 5.382 3.317h.372c.133.027.239.027.265.027 3.37.003 6.152-3.261 4.802-6.975z',
  ],
];

function PayPalMark() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M7.016 19.198h-4.2a.562.562 0 0 1-.555-.65L5.093.584A.692.692 0 0 1 5.776 0h7.222c3.417 0 5.904 2.488 5.846 5.5-.006.25-.027.5-.066.747A6.794 6.794 0 0 1 12.071 12H8.743a.69.69 0 0 0-.682.583l-.325 2.056-.013.083-.692 4.39-.015.087zM19.79 6.142c-.01.087-.01.175-.023.261a7.76 7.76 0 0 1-7.695 6.598H9.007l-.283 1.795-.013.083-.692 4.39-.134.843-.014.088H6.86l-.497 3.15a.562.562 0 0 0 .555.65h3.612c.34 0 .63-.249.683-.585l.952-6.031a.692.692 0 0 1 .683-.584h2.126a6.793 6.793 0 0 0 6.707-5.752c.306-1.95-.466-3.744-1.89-4.906z" />
    </svg>
  );
}

const STEP_ICONS = [
  'M12 3v12M7 10l5 5 5-5M5 21h14',
  'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  'm12 2 9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 17l9 5 9-5',
  'M20 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h15v13H5a2 2 0 0 1-2-2V5',
];
const STEP_TONES = [
  'text-accent bg-accent/14',
  'text-info bg-info/14',
  'text-sim bg-sim/14',
  'text-positive bg-positive/14',
];

const PUBLISHER_PLAN = [
  'You set the price: $0.10–$100 per 1,000 records, and per 1,000 changes',
  "You keep 80% of every call; Spigot's 20% is taken at sale",
  'Paid out via PayPal every Monday once you have $10 payable',
  'Search engines always pass, so your SEO is safe',
  'Fails open: if Spigot is down, your site keeps working',
];
const AGENT_PLAN = [
  'Prepaid balance, funded with PayPal or a card through PayPal',
  'Every response says exactly what it charged',
  'Auto top-up with a monthly cap, so agents keep working',
  'Report a wrong or stale record and get credited',
  'Refund unused balance back to PayPal',
];

const eyebrow = 'text-xs font-medium tracking-[0.12em] uppercase';
const h2 =
  'mt-3 max-w-3xl font-[family-name:var(--font-display)] text-4xl font-light tracking-[-0.035em] text-ink sm:text-[52px] sm:leading-[58px]';
const card = 'rounded-[20px] border border-white/9 bg-white/4';

function Check({ tone }: { tone: string }) {
  return (
    <span
      aria-hidden="true"
      className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full ${tone}`}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M20 6 9 17l-5-5" />
      </svg>
    </span>
  );
}

function Plan({
  label,
  title,
  price,
  unit,
  lines,
  cta,
  featured,
}: {
  label: string;
  title: string;
  price: string;
  unit: string;
  lines: readonly string[];
  cta: ReactNode;
  featured?: boolean;
}) {
  const tone = featured ? 'text-accent bg-accent/16' : 'text-positive bg-positive/16';
  return (
    <div
      className={`flex flex-col gap-5 rounded-[20px] border p-9 ${featured ? 'border-accent/40 bg-gradient-to-br from-accent/16 to-accent/3' : 'border-white/9 bg-white/3'}`}
    >
      <p className={`${eyebrow} ${featured ? 'text-accent' : 'text-positive'}`}>{label}</p>
      <h3 className="font-[family-name:var(--font-display)] text-3xl font-light tracking-tight text-ink">
        {title}
      </h3>
      <p className="flex items-end gap-2">
        <span className="font-[family-name:var(--font-display)] text-[56px] leading-[60px] font-light tracking-[-0.05em] text-ink">
          {price}
        </span>
        <span className="pb-2 text-[15px] text-muted">{unit}</span>
      </p>
      <hr className="border-white/10" />
      <ul className="space-y-3.5">
        {lines.map((l) => (
          <li key={l} className="flex gap-3 text-[15px] text-body">
            <Check tone={tone} />
            {l}
          </li>
        ))}
      </ul>
      <div className="mt-auto pt-4">{cta}</div>
    </div>
  );
}

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-canvas text-body" data-screen="W01" data-theme="dark">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-10 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-ink"
      >
        Skip to content
      </a>
      <main id="main">
        <section
          aria-labelledby="hero-title"
          data-theme="dark"
          style={{ '--u': 'clamp(0.62px, calc(100vw / 1440), 1px)' } as CSSProperties}
          className="page-in relative flex min-h-[620px] flex-col overflow-hidden bg-[#070b23] bg-[url('/hero-bg.webp')] bg-cover bg-center text-white sm:h-[max(calc(900*var(--u)),100svh)]"
        >
          <nav
            aria-label="Main"
            className="flex items-center justify-between gap-3 px-[max(16px,calc(72*var(--u)))] pt-[max(20px,calc(32*var(--u)))]"
          >
            <div className="flex items-center gap-[calc(12*var(--u))]">
              <Link
                to={paths.landing}
                className={`${glass} h-[max(40px,calc(44*var(--u)))] px-[calc(16*var(--u))] [&_svg]:size-[max(20px,calc(24*var(--u)))] [&_span]:text-[max(18px,calc(20*var(--u)))]`}
              >
                <Logo />
              </Link>
              <ul
                className={`${glass} hidden h-[calc(44*var(--u))] gap-[calc(4*var(--u))] p-[calc(6*var(--u))] text-[calc(14*var(--u))] sm:flex`}
              >
                <li>
                  <a
                    href="#pricing"
                    className="block rounded-[calc(6*var(--u))] px-[calc(16*var(--u))] py-[calc(7*var(--u))] hover:bg-white/10"
                  >
                    Pricing
                  </a>
                </li>
                <li>
                  <a
                    href="#features"
                    className="block rounded-[calc(6*var(--u))] px-[calc(16*var(--u))] py-[calc(7*var(--u))] hover:bg-white/10"
                  >
                    Features
                  </a>
                </li>
              </ul>
            </div>
            <Link
              to={paths.login}
              className={`${glass} h-[max(40px,calc(44*var(--u)))] px-[max(16px,calc(18*var(--u)))] text-[max(14px,calc(14*var(--u)))]`}
            >
              Sign in
            </Link>
          </nav>

          <div className="grid gap-8 px-[max(16px,calc(72*var(--u)))] pt-24 sm:grid-cols-[1fr_calc(460*var(--u))] sm:gap-0 sm:pt-[calc(176*var(--u))]">
            <div>
              <p className="flex items-center gap-[calc(8*var(--u))] text-[max(14px,calc(15*var(--u)))] text-white/75 [&_svg]:size-[max(16px,calc(18*var(--u)))]">
                Built on <PayPalMark /> <span className="font-semibold text-white">PayPal</span>
              </p>
              <h1
                id="hero-title"
                className="mt-[max(12px,calc(16*var(--u)))] text-[max(44px,calc(72*var(--u)))] leading-[1.11] text-white"
              >
                Make AI bots pay <br />
                for your site.
              </h1>
            </div>
            <div className="sm:pt-[calc(52*var(--u))]">
              <p className="text-[max(17px,calc(20*var(--u)))] leading-[1.5] text-white/80">
                Turn your site into a paid API for AI agents. PayPal pays you.
              </p>
              <Link
                to={paths.login}
                className="mt-[max(20px,calc(24*var(--u)))] inline-flex items-center rounded-[calc(8*var(--u))] bg-white px-[max(18px,calc(22*var(--u)))] py-[max(10px,calc(12*var(--u)))] text-[max(16px,calc(18*var(--u)))] font-medium text-[#0a1230] hover:bg-white/90"
              >
                View demo
              </Link>
            </div>
          </div>

          <div className="mt-auto border-t border-white/10 bg-white/10 backdrop-blur-xl">
            <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3 px-[max(16px,calc(72*var(--u)))] py-[max(18px,calc(36*var(--u)))]">
              <span className="text-[max(14px,calc(15*var(--u)))] font-medium text-white/60">
                Scrape from
              </span>
              {SCRAPE_FROM.map(([name, d]) => (
                <span
                  key={name}
                  className="flex items-center gap-[calc(10*var(--u))] text-[max(15px,calc(17*var(--u)))] font-medium text-white/90"
                >
                  <svg
                    aria-hidden="true"
                    className="size-[max(20px,calc(24*var(--u)))]"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <path d={d} />
                  </svg>
                  {name}
                </span>
              ))}
            </div>
          </div>
        </section>

        <section
          id="features"
          aria-labelledby="features-title"
          className="px-4 py-24 sm:px-[5vw] sm:py-[120px]"
        >
          <p className={`${eyebrow} text-accent`}>Features</p>
          <h2 id="features-title" className={h2}>
            From scraped to paid in four steps.
          </h2>
          <p className="mt-4 max-w-2xl text-lg leading-7 text-muted">
            Bots stop scraping your HTML and buy clean, live records instead. You stay in control of
            what's sold and for how much.
          </p>

          <ol aria-label="How it works" className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s, i) => (
              <li key={s.title} className={`${card} flex flex-col p-7`}>
                <span className="flex items-center justify-between">
                  <span
                    aria-hidden="true"
                    className={`grid size-11 place-items-center rounded-xl ${STEP_TONES[i]}`}
                  >
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.9"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d={STEP_ICONS[i]} />
                    </svg>
                  </span>
                  <span aria-hidden="true" className="font-mono text-[13px] text-muted">
                    0{i + 1}
                  </span>
                </span>
                <h3 className="mt-10 font-[family-name:var(--font-display)] text-[22px] tracking-tight text-ink">
                  {s.title}
                </h3>
                <p className="mt-3 text-[14.5px] leading-[22px] text-muted">{s.body}</p>
              </li>
            ))}
          </ol>

          <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_560px]">
            <figure className="rounded-[20px] border border-accent/25 bg-gradient-to-br from-accent/18 to-sim/4 p-8">
              <p className={`${eyebrow} text-accent`}>What Claude found on a demo site</p>
              <p className="mt-4 font-[family-name:var(--font-display)] text-[28px] font-light tracking-tight text-ink">
                I found 3 kinds of records on your site
              </p>
              <div className="mt-5 rounded-[14px] border border-white/10 bg-canvas/60 p-5">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="font-[family-name:var(--font-display)] text-xl tracking-tight text-ink">
                      Listing · 2,341
                    </p>
                    <code className="text-[12.5px] text-muted">/listings/:slug</code>
                  </div>
                  <span className="rounded-full bg-info-tint px-2.5 py-0.5 text-xs font-medium text-info">
                    JSON-LD
                  </span>
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                  {[
                    ['title', 'Sunny 3BR near Zilker'],
                    ['price_usd', '1850'],
                    ['bedrooms', '3'],
                    ['city', 'Austin'],
                  ].map(([k, v]) => (
                    <div
                      key={k}
                      className="min-w-0 rounded-[9px] border border-white/8 bg-white/4 p-2.5"
                    >
                      <dt className="font-mono text-[11.5px] text-accent">{k}</dt>
                      <dd className="truncate text-[13px] text-body">{v}</dd>
                    </div>
                  ))}
                </dl>
                <div className="mt-4 flex items-center justify-between">
                  <Money
                    micros={1500}
                    per1000="records"
                    className="text-[15px] font-medium text-money"
                  />
                  <span className="rounded-md bg-white px-3.5 py-2 text-[13.5px] font-medium text-[#0a1230]">
                    Review
                  </span>
                </div>
              </div>
              <figcaption className="mt-4 text-sm text-muted">
                Claude wrote the extractor once. It now runs with no AI on each page.
              </figcaption>
            </figure>

            <section aria-labelledby="agents-title" className={`${card} p-8`}>
              <p className={`${eyebrow} text-positive`}>For agents</p>
              <h3
                id="agents-title"
                className="mt-4 font-[family-name:var(--font-display)] text-[28px] font-light tracking-tight text-ink"
              >
                Typed records, not HTML.
              </h3>
              <p className="mt-4 text-[14.5px] leading-[22px] text-muted">
                Pay per record from a balance you top up with PayPal; every response says what it
                charged. Use the MCP server from Claude Desktop or call the REST API.
              </p>
              <pre
                tabIndex={0}
                aria-label="Sample request"
                className="mt-5 overflow-x-auto rounded-xl border border-white/8 bg-[#02050f]/75 p-4 font-mono text-[12.5px] leading-5 text-ink"
              >
                {sampleRequest()}
              </pre>
              <p className="mt-2 font-mono text-[12.5px] text-money">
                → 37 records · <Money micros={55500} word="charged" />
              </p>
            </section>
          </div>

          <p className="mt-4 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-white/8 bg-white/3 px-7 py-5">
            <span className="flex flex-wrap items-baseline gap-3.5">
              <strong className="font-[family-name:var(--font-display)] text-2xl font-normal tracking-tight text-ink">
                1 AI bot for every 31 human visits
              </strong>
              <span className="text-muted">up from 1 in 200.</span>
            </span>
            <a
              href={STAT_SOURCE_URL}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-accent hover:underline"
            >
              Source: TollBit, Q4 2025 ↗<span className="sr-only"> (opens in a new tab)</span>
            </a>
          </p>
        </section>

        <section
          id="pricing"
          aria-labelledby="pricing-title"
          className="px-4 pb-24 sm:px-[5vw] sm:pt-10 sm:pb-[120px]"
        >
          <p className={`${eyebrow} text-accent`}>Pricing</p>
          <h2 id="pricing-title" className={h2}>
            You set the price. Spigot takes 20%.
          </h2>
          <p className="mt-4 text-lg text-muted">
            No monthly fee. Spigot earns only when your records sell.
          </p>
          <div className="mt-14 grid gap-4 lg:grid-cols-2">
            <Plan
              featured
              label="For publishers"
              title="Free to connect"
              price="20%"
              unit="commission on each sale"
              lines={PUBLISHER_PLAN}
              cta={
                <Link
                  to={paths.signUp}
                  className="inline-flex rounded-lg bg-white px-5 py-3 text-[15px] font-medium text-[#0a1230] hover:bg-white/90"
                >
                  Connect your site
                </Link>
              }
            />
            <Plan
              label="For agents"
              title="Pay per record"
              price="$5"
              unit="minimum top-up"
              lines={AGENT_PLAN}
              cta={
                <Link
                  to={paths.buyerPortal}
                  className="inline-flex rounded-lg border border-white/16 bg-white/6 px-5 py-3 text-[15px] font-medium text-ink hover:bg-white/10"
                >
                  I'm an agent builder
                </Link>
              }
            />
          </div>
          <p className="mt-4 flex flex-wrap items-center gap-3.5 rounded-[14px] border border-positive/22 bg-positive/7 px-6 py-4 text-[15.5px] text-body">
            <span className={`${eyebrow} text-positive`}>Example</span>A buyer pulling all 2,341
            listings at $1.50 / 1,000 pays $3.51; you get $2.81 after Spigot's 20%.
          </p>
        </section>
      </main>

      <footer className="border-t border-white/8 px-4 pt-16 pb-10 sm:px-[5vw]">
        <div className="flex flex-wrap justify-between gap-10">
          <div>
            <Logo />
            <p className="mt-3.5 text-[15px] text-muted">Make AI bots pay for your site.</p>
          </div>
          <div className="flex gap-24">
            <FooterCol
              title="Product"
              links={[
                ['Features', '#features'],
                ['Pricing', '#pricing'],
                ['For agents', '#features'],
              ]}
            />
            <FooterCol
              title="Get started"
              links={[
                ['Connect your site', paths.signUp],
                ['Publisher sign in', paths.login],
                ['Buyer sign in', paths.buyerLogin],
              ]}
            />
          </div>
        </div>
        <div className="mt-12 flex flex-wrap items-center justify-between gap-4 border-t border-white/8 pt-6 text-[13px] text-muted">
          <span>© 2026 Spigot · MIT licence</span>
          <span className="flex items-center gap-1.5 [&_svg]:size-3.5">
            Built on <PayPalMark /> <span className="font-medium text-body">PayPal</span>
          </span>
        </div>
      </footer>
    </div>
  );
}

function FooterCol({
  title,
  links,
}: {
  title: string;
  links: readonly (readonly [string, string])[];
}) {
  return (
    <nav aria-label={title}>
      <p className={`${eyebrow} text-muted`}>{title}</p>
      <ul className="mt-3 space-y-3 text-[15px] text-body">
        {links.map(([l, to]) => (
          <li key={l}>
            {to.startsWith('#') ? (
              <a href={to} className="hover:text-ink">
                {l}
              </a>
            ) : (
              <Link to={to} className="hover:text-ink">
                {l}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
