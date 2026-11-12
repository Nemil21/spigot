import { DATASET_UNPUBLISHED_MESSAGE, SITE_PAUSED_MESSAGE, staleDataMessage } from '@spigot/shared';
import { describe, expect, it } from 'vitest';
import { wantsJson } from '../routes/catalog.js';
import type { CatalogPageDataset, CatalogPageSite } from '../services/catalogPage.js';
import { links402 } from '../services/payment402.js';
import { CATALOG_PAGE_MAX_BYTES, catalogPageLinks, renderCatalogPage } from './catalog.html.js';
import { renderTermsPage } from './terms.html.js';

const NOW = new Date('2026-11-12T12:00:00Z');
const links = catalogPageLinks(links402('https://spigot.test', 'bluebonnet'));

function dataset(over: Partial<CatalogPageDataset> = {}): CatalogPageDataset {
  return {
    slug: 'listings',
    type: 'Listing',
    records: 2341,
    perRecordMicros: 1500,
    perChangeMicros: 500,
    fields: [
      { name: 'price_usd', type: 'integer' },
      { name: 'bedrooms', type: 'integer' },
      { name: 'city', type: 'string' },
    ],
    lastCrawlAt: new Date(NOW.getTime() - 2 * 3_600_000),
    staleSince: null,
    ...over,
  };
}

function site(over: Partial<CatalogPageSite> = {}): CatalogPageSite {
  return {
    slug: 'bluebonnet',
    name: 'Bluebonnet Rentals',
    paused: false,
    datasets: [dataset()],
    unpublished: false,
    ...over,
  };
}

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

describe('W13 catalog page view', () => {
  it('shows the site, the owner line, dataset cards, quick start, CTA and links', () => {
    const page = renderCatalogPage(site(), links, NOW);
    expect(page).toContain('<h1>Bluebonnet Rentals</h1>');
    expect(page).toContain('Data sold by the site owner through Spigot');
    // Card: type, record count, fields, price per 1,000, freshness.
    expect(page).toContain('<h2>Listing</h2>');
    expect(page).toContain('2,341');
    expect(page).toContain('$1.50 / 1,000 records');
    expect(page).toContain('$0.50 / 1,000 changes');
    expect(page).toContain('<code>price_usd</code> (integer)');
    expect(page).toContain('Crawled 2 h ago');
    expect(page).not.toContain('Stale');
    // Quick start: curl and MCP config tabs.
    expect(page).toContain('https://spigot.test/v1/bluebonnet/datasets/listings/records?limit=10');
    expect(page).toContain('&#34;mcp-remote&#34;');
    expect(page).toContain('https://spigot.test/mcp');
    // CTA → W11, terms, OpenAPI.
    expect(page).toContain('href="https://spigot.test/buyers/topup"');
    expect(page).toContain('Get an API key and top up with PayPal');
    expect(page).toContain('href="https://spigot.test/c/bluebonnet/terms"');
    expect(page).toContain('href="https://spigot.test/v1/openapi.yaml"');
    // No JS on the page.
    expect(page).not.toMatch(/<script/i);
  });

  it('badges a stale dataset with the W15 copy', () => {
    const staleSince = new Date(NOW.getTime() - 6 * 3_600_000);
    const page = renderCatalogPage(site({ datasets: [dataset({ staleSince })] }), links, NOW);
    expect(page).toContain('<span class="badge">Stale</span>');
    expect(page).toContain(staleDataMessage({ lastGoodExtractAgeMs: 6 * 3_600_000 }));
    expect(page).toContain('Last good extract 6 h ago; the site changed layout.');
  });

  it('paused site: shared copy, datasets still listed', () => {
    const page = renderCatalogPage(site({ paused: true }), links, NOW);
    expect(page).toContain(SITE_PAUSED_MESSAGE);
    expect(page).toContain('<h2>Listing</h2>');
  });

  it('unpublished site: shared copy, no cards or quick start', () => {
    const page = renderCatalogPage(site({ datasets: [], unpublished: true }), links, NOW);
    expect(page).toContain(DATASET_UNPUBLISHED_MESSAGE);
    expect(page).not.toContain('class="cards"');
    expect(page).not.toContain('Quick start');
  });

  it('escapes owner-controlled text', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const page = renderCatalogPage(
      site({
        name: evil,
        datasets: [dataset({ type: evil, fields: [{ name: evil, type: 'string' }] })],
      }),
      links,
      NOW,
    );
    expect(page).not.toContain('<img');
    expect(page).toContain('&#60;img');
    expect(renderTermsPage({ name: evil }, links)).not.toContain('<img');
  });

  it('stays under 50 KB for a large site', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      dataset({
        slug: `dataset-${i}-${'x'.repeat(80)}`,
        type: `Type${i}${'Y'.repeat(60)}`,
        staleSince: i % 2 ? NOW : null,
        fields: Array.from({ length: 200 }, (_, j) => ({
          name: `field_${j}_${'z'.repeat(40)}`,
          type: 'string' as const,
        })),
      }),
    );
    const page = renderCatalogPage(
      site({ name: 'N'.repeat(200), datasets: many, paused: true }),
      links,
      NOW,
    );
    expect(bytes(page)).toBeLessThan(CATALOG_PAGE_MAX_BYTES);
    expect(page).toContain('<h2>Type0');
  });

  it('lists 24 fields per card when they fit, then summarises', () => {
    const fields = Array.from({ length: 40 }, (_, j) => ({
      name: `f_${j}`,
      type: 'string' as const,
    }));
    const page = renderCatalogPage(site({ datasets: [dataset({ fields })] }), links, NOW);
    expect(page).toContain('<code>f_23</code>');
    expect(page).not.toContain('<code>f_24</code>');
    expect(page).toContain('+ 16 more');
  });

  it('drops cards (pointing at the JSON catalog) only when nothing else fits', () => {
    const many = Array.from({ length: 2000 }, (_, i) => dataset({ slug: `d-${i}` }));
    const page = renderCatalogPage(site({ datasets: many }), links, NOW);
    expect(bytes(page)).toBeLessThan(CATALOG_PAGE_MAX_BYTES);
    expect(page).toMatch(
      /\+ [\d,]+ more datasets in the <a href="https:\/\/spigot\.test\/v1\/catalog">/,
    );
  });

  it('terms: factual data, no resale, attribution optional', () => {
    const page = renderTermsPage({ name: 'Bluebonnet Rentals' }, links);
    expect(page).toContain('Factual records');
    expect(page).toContain('No resale.');
    expect(page).toMatch(/Attribution<\/h2>\s*<p>Optional/);
    expect(page).toContain('href="https://spigot.test/c/bluebonnet"');
  });
});

describe('Accept negotiation', () => {
  it.each([
    [undefined, false],
    ['*/*', false], // curl's default
    ['text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', false], // browser
    ['application/json', true],
    ['application/json, text/plain, */*', true], // axios
    ['text/html;q=0.5, application/json', true],
    ['application/json;q=0.5, text/html', false],
    ['application/json;q=0', false],
    ['application/*', true],
  ])('%s → json %s', (accept, json) => {
    expect(wantsJson(accept)).toBe(json);
  });
});
