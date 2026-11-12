// W13 public catalog page `/c/:site` (screens.md §W13, features/16 §Catalog page; SP-033). Every
// 402 (gate and data API) points here: it tells a scraper author exactly how to buy the data.
// Server-rendered, no JS (the quick-start tabs are CSS radios), no login, under 50 KB.
import {
  DATASET_UNPUBLISHED_MESSAGE,
  SITE_PAUSED_MESSAGE,
  formatAge,
  formatCount,
  formatPer1000,
  staleDataMessage,
} from '@spigot/shared';
import type { CatalogPageDataset, CatalogPageSite } from '../services/catalogPage.js';
import type { Links402 } from '../services/payment402.js';
import { clip, html, page, raw, type Raw } from './layout.js';

/** The page budget (features/16: "< 50 KB"). `catalog.html.test.ts` holds the page to it. */
export const CATALOG_PAGE_MAX_BYTES = 50 * 1024;
/**
 * Fields listed per card, tried in order until the page fits the budget; the rest are summarised
 * ("+ 12 more"). If it still doesn't fit with no field lists, fewer cards are shown.
 */
const FIELDS_SHOWN_STEPS = [24, 8, 0] as const;

export interface CatalogPageLinks extends Links402 {
  /** `<base>/c/<site>/terms` (the 402 body's `terms`). */
  terms: string;
  /** `<base>/v1/openapi.yaml` (SP-023). */
  openapi: string;
  /** `<base>/v1/catalog` (SP-017b): every site and dataset, JSON. */
  v1Catalog: string;
  /** `<base>/`: the Spigot landing page, for the page header's brand link. */
  home: string;
}

export function catalogPageLinks(links: Links402): CatalogPageLinks {
  const base = links.apiBase.replace(/\/v1\/[^/]+$/, '');
  return {
    ...links,
    terms: `${links.catalogUrl}/terms`,
    openapi: `${base}/v1/openapi.yaml`,
    v1Catalog: `${base}/v1/catalog`,
    home: `${base}/`,
  };
}

function freshness(d: CatalogPageDataset, now: Date): Raw {
  const updated = d.lastCrawlAt
    ? `Crawled ${formatAge(now.getTime() - d.lastCrawlAt.getTime())} ago`
    : 'Not crawled yet';
  // `stale_since` stands in for the last good extract (no separate column); floored, like the
  // badge copy, so the data never reads fresher than it is.
  const stale = d.staleSince
    ? html`<br /><small
          >${staleDataMessage({ lastGoodExtractAgeMs: now.getTime() - d.staleSince.getTime() })}</small
        >`
    : null;
  return html`${updated}${stale}`;
}

function card(d: CatalogPageDataset, links: CatalogPageLinks, now: Date, maxFields: number): Raw {
  const shown = d.fields.slice(0, maxFields);
  const more = d.fields.length - shown.length;
  return html`<section class="card" id="dataset-${d.slug}">
    <h2>${clip(d.type)}${d.staleSince ? raw(' <span class="badge">Stale</span>') : null}</h2>
    <code>${d.slug}</code>
    <dl>
      <dt>Records</dt>
      <dd>${formatCount(d.records)}</dd>
      <dt>Price</dt>
      <dd>${formatPer1000(d.perRecordMicros)}</dd>
      <dt>Changes</dt>
      <dd>${formatPer1000(d.perChangeMicros, 'changes')}</dd>
      <dt>Freshness</dt>
      <dd>${freshness(d, now)}</dd>
    </dl>
    <div class="fields">
      <strong>Fields:</strong> ${
        shown.length
          ? html`${shown.map((f, i) => html`${i ? ', ' : ''}<code>${f.name}</code> (${f.type})`)}${more > 0 ? ` + ${more} more` : ''}`
          : `${formatCount(d.fields.length)}, listed in the schema`
      }
    </div>
    <p><a href="${links.apiBase}/datasets/${d.slug}">Schema (JSON, free)</a></p>
  </section>`;
}

function quickStart(site: CatalogPageSite, links: CatalogPageLinks): Raw | null {
  const d = site.datasets[0];
  if (!d) return null;
  const records = `${links.apiBase}/datasets/${d.slug}/records`;
  const curl = [
    '# Free: the schema and a price quote',
    `curl ${links.apiBase}/datasets/${d.slug}`,
    `curl -H "Authorization: Bearer sk_spg_…" "${links.apiBase}/datasets/${d.slug}/quote?limit=100"`,
    '',
    '# Paid from your PayPal-funded balance; Idempotency-Key makes retries free',
    `curl -H "Authorization: Bearer sk_spg_…" \\`,
    `     -H "Idempotency-Key: $(uuidgen)" \\`,
    `     "${records}?limit=10&max_price_micros=100000"`,
  ].join('\n');
  const mcp = JSON.stringify(
    {
      mcpServers: {
        spigot: {
          command: 'npx',
          args: ['-y', 'mcp-remote', links.mcp, '--header', 'Authorization: Bearer sk_spg_…'],
        },
      },
    },
    null,
    2,
  );
  // CSS-only tabs: `#qs-x:checked ~ #qs-x-panel` shows the panel (rules in `extraCss`).
  return html`<h2 id="quick-start">Quick start</h2>
    <p>
      Every call needs an API key (<code>sk_spg_…</code>). Prices are per record returned; a call
      never costs more than <code>max_price_micros</code>.
    </p>
    <div class="tabs">
      <input type="radio" name="qs" id="qs-curl" checked /><label for="qs-curl">curl</label>
      <input type="radio" name="qs" id="qs-mcp" /><label for="qs-mcp">MCP (Claude Desktop)</label>
      <div class="panel" id="qs-curl-panel"><pre>${curl}</pre></div>
      <div class="panel" id="qs-mcp-panel">
        <p>
          Add to <code>claude_desktop_config.json</code>, then ask Claude for
          ${clip(d.type).toLowerCase()} data from ${clip(site.name)}:
        </p>
        <pre>${mcp}</pre>
      </div>
    </div>`;
}

export function renderCatalogPage(
  site: CatalogPageSite,
  links: CatalogPageLinks,
  now: Date = new Date(),
): string {
  let out = '';
  for (const maxFields of FIELDS_SHOWN_STEPS) {
    out = render(site, links, now, maxFields, site.datasets.length);
    if (Buffer.byteLength(out) < CATALOG_PAGE_MAX_BYTES) return out;
  }
  // A site with very many datasets: halve the cards until it fits (the JSON lists them all).
  for (
    let cards = Math.floor(site.datasets.length / 2);
    cards >= 0;
    cards = Math.floor(cards / 2)
  ) {
    out = render(site, links, now, 0, cards);
    if (Buffer.byteLength(out) < CATALOG_PAGE_MAX_BYTES || cards === 0) return out;
  }
  return out;
}

function render(
  site: CatalogPageSite,
  links: CatalogPageLinks,
  now: Date,
  maxFields: number,
  maxCards: number,
): string {
  const name = clip(site.name);
  const cards = site.datasets.slice(0, maxCards);
  const hiddenCards = site.datasets.length - cards.length;
  const notes: Raw[] = [];
  if (site.paused) notes.push(html`<p class="note" role="status">${SITE_PAUSED_MESSAGE}</p>`);
  if (site.unpublished)
    notes.push(html`<p class="note" role="status">${DATASET_UNPUBLISHED_MESSAGE}</p>`);
  else if (site.datasets.length === 0) {
    notes.push(
      html`<p class="note" role="status">${name} isn't selling any data through Spigot yet.</p>`,
    );
  }

  const body = html`<h1>${name}</h1>
    <p class="sub">
      Data sold by the site owner through Spigot. Clean, typed records over an API, paid from a
      PayPal-funded balance.
    </p>
    ${notes}
    ${cards.length ? html`<div class="cards">${cards.map((d) => card(d, links, now, maxFields))}</div>` : null}
    ${hiddenCards > 0 ? html`<p>+ ${formatCount(hiddenCards)} more datasets in the <a href="${links.v1Catalog}">JSON catalog</a>.</p>` : null}
    ${quickStart(site, links)}
    <p><a class="cta" href="${links.topUpUrl}">Get an API key and top up with PayPal</a></p>
    <ul class="links">
      <li>
        <a href="${links.terms}">Terms</a>: contract terms for factual data, no resale, attribution
        optional.
      </li>
      <li><a href="${links.openapi}">OpenAPI spec</a> (<code>/v1/openapi.yaml</code>)</li>
      <li>MCP endpoint: <code>${links.mcp}</code></li>
      <li>Machine-readable: <code>curl -H "Accept: application/json" ${links.catalogUrl}</code></li>
    </ul>
    <footer>Spigot sells this data on the owner's behalf and pays them out via PayPal.</footer>`;

  return page({
    title: `${name}: data API on Spigot`,
    home: links.home,
    extraCss: '#qs-curl:checked~#qs-curl-panel,#qs-mcp:checked~#qs-mcp-panel{display:block}',
    body,
  });
}

/** `404` for an unknown site, as a page (the JSON variant is the api.md error envelope). */
export function renderCatalogNotFound(siteSlug: string): string {
  return page({
    title: 'No such site on Spigot',
    body: html`<h1>No such site</h1>
      <p class="sub">Spigot doesn't sell data for <code>${siteSlug}</code>.</p>`,
  });
}
