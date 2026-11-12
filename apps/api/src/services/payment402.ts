// The data API's 402 bodies (api.md §The 402 contract, features/06 §402 shapes). The base body
// is the gate's (`@spigot/gate` `build402`) field for field; `payment402.test.ts` asserts parity.
// The API can't import the gate at runtime (it's the publisher-side package), so the algorithm
// is mirrored here and pinned by that test.
import {
  errorEnvelope,
  formatMicros,
  insufficientBalanceMessage,
  priceAboveMaxMessage,
  type ErrorCode,
} from '@spigot/shared';

/** One dataset a site sells, as the 402 body lists it. */
export interface SiteDataset402 {
  slug: string;
  type: string;
  records: number;
  perRecordMicros: number;
}

export interface Site402 {
  slug: string;
  /** Display name ("Bluebonnet Rentals"); falls back to the slug. */
  name: string | null;
  /** The site's LIVE / LIVE_STALE datasets, in catalog order. */
  datasets: readonly SiteDataset402[];
}

export interface Links402 {
  /** `<base>/v1/<site>` */
  apiBase: string;
  /** `<base>/c/<site>` (W13) */
  catalogUrl: string;
  topUpUrl: string;
  mcp: string;
}

/** The shared body. Key order follows api.md (and the gate's `Payment402Body`). */
export interface Payment402Base {
  error: { code: ErrorCode; message: string };
  site: string;
  datasets: {
    slug: string;
    type: string;
    records: number;
    perRecordMicros: number;
    endpoint: string;
  }[];
  pay: { method: 'prepaid_balance'; provider: 'PayPal'; topUpUrl: string; mcp: string };
  terms: string;
}

export interface Quote402 {
  /** `records` for records / record calls, `changes` for the changes feed. */
  unit: 'records' | 'changes';
  count: number;
  priceMicros: number;
}

export interface InsufficientBalance402 extends Payment402Base {
  quote: { records?: number; changes?: number; priceMicros: number };
  balanceMicros: number;
  topUpUrl: string;
  /** MCP only: the tool call that fixes it. */
  top_up?: { tool: 'top_up'; amountCents: number };
}

export interface PriceAboveMax402 extends Payment402Base {
  quote: { records?: number; changes?: number; priceMicros: number };
  maxPriceMicros: number;
}

/** Headers sent with every data-API 402 (same as the gate's). */
export interface Headers402 {
  Link: string[];
  'Cache-Control': 'no-store';
  'Spigot-Price'?: string;
}

export function links402(baseUrl: string, siteSlug: string): Links402 {
  const base = baseUrl.replace(/\/+$/, '');
  // The gate derives these from its `apiBase` origin; do the same so the URLs match exactly.
  const origin = new URL(base).origin;
  return {
    apiBase: `${base}/v1/${siteSlug}`,
    catalogUrl: `${base}/c/${siteSlug}`,
    topUpUrl: `${origin}/buyers/topup`,
    mcp: `${origin}/mcp`,
  };
}

/** "$1.50" for 1,500 micros per record (the gate's `dollarsPer1000`). */
function per1000(perRecordMicros: number): string {
  return formatMicros(perRecordMicros * 1000);
}

/** `PAYMENT_REQUIRED`: an unauthenticated (or unpaid) call to a paid endpoint. */
export function paymentRequiredBody(site: Site402, links: Links402): Payment402Base {
  const first = site.datasets[0];
  const message = first
    ? `This site sells its data as an API. Clean, typed, live records: ${per1000(first.perRecordMicros)} per 1,000.`
    : 'This site sells its data as an API.';
  return {
    error: { code: 'PAYMENT_REQUIRED', message },
    site: site.name ?? site.slug,
    datasets: site.datasets.map((d) => ({
      slug: d.slug,
      type: d.type,
      records: d.records,
      perRecordMicros: d.perRecordMicros,
      endpoint: `${links.apiBase}/datasets/${d.slug}/records`,
    })),
    pay: {
      method: 'prepaid_balance',
      provider: 'PayPal',
      topUpUrl: links.topUpUrl,
      mcp: links.mcp,
    },
    terms: `${links.catalogUrl}/terms`,
  };
}

function quoteField(q: Quote402): InsufficientBalance402['quote'] {
  return { [q.unit]: q.count, priceMicros: q.priceMicros };
}

/** Smallest top-up that covers the shortfall: whole dollars, at least PayPal's $5 minimum. */
export function suggestedTopUpCents(priceMicros: number, balanceMicros: number): number {
  const shortCents = Math.ceil(Math.max(0, priceMicros - balanceMicros) / 10_000);
  return Math.max(500, Math.ceil(shortCents / 100) * 100);
}

export function insufficientBalanceBody(
  site: Site402,
  links: Links402,
  args: { quote: Quote402; balanceMicros: number; channel: 'REST' | 'MCP' },
): InsufficientBalance402 {
  const base = paymentRequiredBody(site, links);
  const body: InsufficientBalance402 = {
    ...base,
    ...errorEnvelope(
      'INSUFFICIENT_BALANCE',
      insufficientBalanceMessage({
        priceMicros: args.quote.priceMicros,
        balanceMicros: args.balanceMicros,
        topUpUrl: links.topUpUrl,
      }),
    ),
    quote: quoteField(args.quote),
    balanceMicros: args.balanceMicros,
    topUpUrl: links.topUpUrl,
  } as InsufficientBalance402;
  if (args.channel === 'MCP') {
    body.top_up = {
      tool: 'top_up',
      amountCents: suggestedTopUpCents(args.quote.priceMicros, args.balanceMicros),
    };
  }
  return body;
}

export function priceAboveMaxBody(
  site: Site402,
  links: Links402,
  args: { quote: Quote402; maxPriceMicros: number },
): PriceAboveMax402 {
  const base = paymentRequiredBody(site, links);
  return {
    ...base,
    ...errorEnvelope(
      'PRICE_ABOVE_MAX',
      priceAboveMaxMessage({
        records: args.quote.count,
        priceMicros: args.quote.priceMicros,
        maxPriceMicros: args.maxPriceMicros,
      }),
    ),
    quote: quoteField(args.quote),
    maxPriceMicros: args.maxPriceMicros,
  } as PriceAboveMax402;
}

/** `Link` / `Cache-Control` / `Spigot-Price`, as the gate sends them. */
export function headers402(site: Site402, links: Links402): Headers402 {
  const first = site.datasets[0];
  const alternate = first ? `${links.apiBase}/datasets/${first.slug}` : links.apiBase;
  const headers: Headers402 = {
    Link: [
      `<${alternate}>; rel="alternate"; type="application/json"`,
      `<${links.catalogUrl}>; rel="payment"`,
    ],
    'Cache-Control': 'no-store',
  };
  if (site.datasets.length > 0) {
    headers['Spigot-Price'] = site.datasets
      .map((d) => `${d.slug}; per-record-micros=${d.perRecordMicros}`)
      .join(', ');
  }
  return headers;
}
