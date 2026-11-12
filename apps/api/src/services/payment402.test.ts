import { describe, expect, it } from 'vitest';
import { build402, parsePolicy, type PolicyWire } from '@spigot/gate';
import { errorEnvelopeSchema } from '@spigot/shared';
import {
  headers402,
  insufficientBalanceBody,
  links402,
  paymentRequiredBody,
  priceAboveMaxBody,
  suggestedTopUpCents,
  type Site402,
} from './payment402.js';

const BASE = 'https://spigot.onrender.com';

/** The same site as the gate would see it from `GET /api/gate/policy`. */
function gateFor(site: Site402) {
  const wire: PolicyWire = {
    siteId: 'site_x',
    policyVersion: 1,
    apiBase: `${BASE}/v1/${site.slug}`,
    catalogUrl: `${BASE}/c/${site.slug}`,
    gatedPaths: [],
    decisions: {
      SEARCH: 'PASS',
      AI_TRAINING: 'QUOTE',
      AI_AGENT: 'QUOTE',
      SCRAPER_TOOL: 'QUOTE',
      UNKNOWN: 'PASS',
    },
    prices: site.datasets.map((d) => ({
      dataset: d.slug,
      perRecordMicros: d.perRecordMicros,
      type: d.type,
      records: d.records,
    })),
    ...(site.name ? { siteName: site.name } : {}),
  };
  return build402(parsePolicy(wire));
}

const bluebonnet: Site402 = {
  slug: 'bluebonnet',
  name: 'Bluebonnet Rentals',
  datasets: [{ slug: 'listings', type: 'Listing', records: 2341, perRecordMicros: 1500 }],
};

const cases: [string, Site402][] = [
  ['the api.md demo site', bluebonnet],
  [
    'several datasets, odd prices',
    {
      slug: 'acme-homes',
      name: 'Acme Homes & "Co"',
      datasets: [
        { slug: 'agents', type: 'Agent', records: 88, perRecordMicros: 100 },
        { slug: 'listings', type: 'Listing', records: 0, perRecordMicros: 100_000 },
        { slug: 'open-houses', type: 'OpenHouse', records: 40, perRecordMicros: 1234 },
      ],
    },
  ],
  ['no sold datasets', { slug: 'empty-site', name: 'Empty', datasets: [] }],
  ['no display name', { slug: 'noname', name: null, datasets: bluebonnet.datasets }],
];

describe('402 contract parity with @spigot/gate build402', () => {
  it.each(cases)('PAYMENT_REQUIRED body is identical: %s', (_name, site) => {
    const gate = gateFor(site);
    const ours = paymentRequiredBody(site, links402(BASE, site.slug));
    expect(ours).toEqual(gate.body);
    // Same serialization, so key order matches too.
    expect(JSON.stringify(ours)).toBe(gate.json);
  });

  it.each(cases)('402 headers are identical: %s', (_name, site) => {
    expect(headers402(site, links402(BASE, site.slug))).toEqual(gateFor(site).headers);
  });

  it('a trailing slash on APP_BASE_URL changes nothing', () => {
    expect(paymentRequiredBody(bluebonnet, links402(`${BASE}/`, 'bluebonnet'))).toEqual(
      gateFor(bluebonnet).body,
    );
  });

  it('INSUFFICIENT_BALANCE keeps the gate shape and adds quote, balanceMicros, topUpUrl', () => {
    const links = links402(BASE, 'bluebonnet');
    const body = insufficientBalanceBody(bluebonnet, links, {
      quote: { unit: 'records', count: 37, priceMicros: 55_500 },
      balanceMicros: 12_000,
      channel: 'REST',
    });
    const gate = gateFor(bluebonnet).body;
    expect(body).toEqual({
      ...gate,
      error: {
        code: 'INSUFFICIENT_BALANCE',
        message:
          'This call costs $0.0555 and your balance is $0.012. Top up with PayPal: https://spigot.onrender.com/buyers/topup.',
      },
      quote: { records: 37, priceMicros: 55_500 },
      balanceMicros: 12_000,
      topUpUrl: 'https://spigot.onrender.com/buyers/topup',
    });
    expect(Object.keys(body).slice(0, 5)).toEqual(Object.keys(gate));
    expect(errorEnvelopeSchema.safeParse(body).success).toBe(true);
    expect(body).not.toHaveProperty('top_up');
  });

  it('INSUFFICIENT_BALANCE over MCP adds a top_up hint that covers the shortfall', () => {
    const body = insufficientBalanceBody(bluebonnet, links402(BASE, 'bluebonnet'), {
      quote: { unit: 'changes', count: 28, priceMicros: 14_000 },
      balanceMicros: 0,
      channel: 'MCP',
    });
    expect(body.quote).toEqual({ changes: 28, priceMicros: 14_000 });
    expect(body.top_up).toEqual({ tool: 'top_up', amountCents: 500 });
    expect(suggestedTopUpCents(12_340_000, 1_000_000)).toBe(1200);
    expect(suggestedTopUpCents(12_340_001, 1_000_000)).toBe(1200);
    expect(suggestedTopUpCents(13_000_001, 1_000_000)).toBe(1300);
  });

  it('PRICE_ABOVE_MAX keeps the gate shape and adds quote and maxPriceMicros', () => {
    const body = priceAboveMaxBody(bluebonnet, links402(BASE, 'bluebonnet'), {
      quote: { unit: 'records', count: 1000, priceMicros: 1_500_000 },
      maxPriceMicros: 1_000_000,
    });
    expect(body).toEqual({
      ...gateFor(bluebonnet).body,
      error: {
        code: 'PRICE_ABOVE_MAX',
        message:
          'This would return 1,000 records ($1.50), above your $1.00 per-call limit. Narrow the filters or raise `max_price_micros`.',
      },
      quote: { records: 1000, priceMicros: 1_500_000 },
      maxPriceMicros: 1_000_000,
    });
    expect(errorEnvelopeSchema.safeParse(body).success).toBe(true);
  });
});
