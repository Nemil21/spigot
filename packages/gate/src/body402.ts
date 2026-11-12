// The 402 contract (api.md §The 402 contract). Built once per policy load; the middleware
// sends the prebuilt strings. The data API (SP-017a) returns the same body shape and
// asserts parity against `Payment402Body` / `build402`.

import type { Policy, PolicyPrice } from './policy.js';

export type Payment402Code = 'PAYMENT_REQUIRED' | 'INSUFFICIENT_BALANCE';

export interface Payment402Dataset {
  slug: string;
  /** Record type name, e.g. `Listing`; omitted when the policy doesn't carry it. */
  type?: string;
  /** Live record count; omitted when the policy doesn't carry it. */
  records?: number;
  perRecordMicros: number;
  endpoint: string;
}

/** The 402 JSON body shared by the gate and the data API. */
export interface Payment402Body {
  error: { code: Payment402Code; message: string };
  site: string;
  datasets: Payment402Dataset[];
  pay: { method: 'prepaid_balance'; provider: 'PayPal'; topUpUrl: string; mcp: string };
  terms: string;
  /** Data API only, with `INSUFFICIENT_BALANCE`. */
  quote?: { records: number; priceMicros: number };
  /** Data API only, with `INSUFFICIENT_BALANCE`. */
  balanceMicros?: number;
}

export interface Built402 {
  status: 402;
  body: Payment402Body;
  /** Serialized `body`. */
  json: string;
  /** D04 page: static, no JS, under 2 KB. */
  html: string;
  /** Headers common to both variants. `Link` is two header lines. */
  headers: { Link: string[]; 'Cache-Control': 'no-store'; 'Spigot-Price'?: string };
  contentType: { json: string; html: string };
}

export const D04_MAX_BYTES = 2048;
// Keeps D04 under the 2 KB budget whatever the policy holds.
const D04_MAX_DATASETS = 4;
const D04_MAX_NAME = 80;

/** Dollars per 1,000 records from micros per record: 1500 → "$1.50" (same as `@spigot/shared` `formatMicros(m * 1000)`). */
export function dollarsPer1000(perRecordMicros: number): string {
  // micros/record × 1000 records ÷ 1e6 micros/$ = micros ÷ 1000 dollars, so the micros
  // value is already the price per 1,000 in tenths of a cent.
  const tenthCents = perRecordMicros;
  const dollars = Math.floor(tenthCents / 1000);
  const frac = String(tenthCents % 1000).padStart(3, '0');
  const fracOut = frac.endsWith('0') ? frac.slice(0, 2) : frac;
  return `$${dollars.toLocaleString('en-US')}.${fracOut}`;
}

function siteSlug(apiBase: string): string {
  const segs = new URL(apiBase).pathname.split('/').filter(Boolean);
  return segs[segs.length - 1] ?? 'site';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function nounFor(p: PolicyPrice): string {
  return p.dataset.replace(/-/g, ' ');
}

export function build402(policy: Policy): Built402 {
  const w = policy.wire;
  const origin = new URL(w.apiBase).origin;
  const site = w.siteName ?? siteSlug(w.apiBase);

  // Key order follows api.md: slug, type, records, perRecordMicros, endpoint.
  const datasets: Payment402Dataset[] = w.prices.map((p) => ({
    slug: p.dataset,
    ...(p.type !== undefined && { type: p.type }),
    ...(p.records !== undefined && { records: p.records }),
    perRecordMicros: p.perRecordMicros,
    endpoint: `${w.apiBase}/datasets/${p.dataset}/records`,
  }));

  const first = w.prices[0];
  const message = first
    ? `This site sells its data as an API. Clean, typed, live records: ${dollarsPer1000(first.perRecordMicros)} per 1,000.`
    : 'This site sells its data as an API.';

  const body: Payment402Body = {
    error: { code: 'PAYMENT_REQUIRED', message },
    site,
    datasets,
    pay: {
      method: 'prepaid_balance',
      provider: 'PayPal',
      topUpUrl: `${origin}/buyers/topup`,
      mcp: `${origin}/mcp`,
    },
    terms: `${w.catalogUrl}/terms`,
  };

  const alternate = first ? `${w.apiBase}/datasets/${first.dataset}` : w.apiBase;
  const headers: Built402['headers'] = {
    Link: [
      `<${alternate}>; rel="alternate"; type="application/json"`,
      `<${w.catalogUrl}>; rel="payment"`,
    ],
    'Cache-Control': 'no-store',
  };
  if (w.prices.length > 0) {
    headers['Spigot-Price'] = w.prices
      .map((p) => `${p.dataset}; per-record-micros=${p.perRecordMicros}`)
      .join(', ');
  }

  return {
    status: 402,
    body,
    json: JSON.stringify(body),
    html: buildD04(site, w.prices, w.catalogUrl, body.pay.mcp),
    headers,
    contentType: { json: 'application/json; charset=utf-8', html: 'text/html; charset=utf-8' },
  };
}

function buildD04(
  site: string,
  prices: readonly PolicyPrice[],
  catalogUrl: string,
  mcpUrl: string,
): string {
  const name = escapeHtml(
    site.length > D04_MAX_NAME ? `${site.slice(0, D04_MAX_NAME - 1)}…` : site,
  );
  const shown = prices.slice(0, D04_MAX_DATASETS);
  const priceLine = shown.length
    ? ` ${shown.map((p) => `${dollarsPer1000(p.perRecordMicros)} per 1,000 ${escapeHtml(nounFor(p).slice(0, D04_MAX_NAME))}`).join('; ')}${prices.length > shown.length ? '; more in the catalog' : ''}, live, typed.`
    : '';
  const catalog = escapeHtml(catalogUrl);
  const mcp = escapeHtml(mcpUrl);
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>402 Payment Required: ${name}</title>` +
    '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a}a{color:#0b5cad}</style>' +
    '</head><body><h1>402 Payment Required</h1>' +
    `<p>${name} sells this data as an API.${priceLine} Pay with a PayPal-funded balance.</p>` +
    `<p><a href="${catalog}">See the catalog and prices</a></p>` +
    `<p>For AI agents: MCP endpoint <a href="${mcp}">${mcp}</a></p>` +
    '</body></html>'
  );
}
