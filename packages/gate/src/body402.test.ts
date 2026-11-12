import { describe, expect, it } from 'vitest';
import { build402, D04_MAX_BYTES, dollarsPer1000, type Payment402Body } from './body402.js';
import { parsePolicy } from './policy.js';
import { demoPolicyWire } from './fixtures.test-helpers.js';

describe('build402', () => {
  const built = build402(parsePolicy(demoPolicyWire()));

  it('builds the api.md body exactly', () => {
    const expected: Payment402Body = {
      error: {
        code: 'PAYMENT_REQUIRED',
        message: 'This site sells its data as an API. Clean, typed, live records: $1.50 per 1,000.',
      },
      site: 'Bluebonnet Rentals',
      datasets: [
        {
          slug: 'listings',
          type: 'Listing',
          records: 2341,
          perRecordMicros: 1500,
          endpoint: 'https://spigot.onrender.com/v1/bluebonnet/datasets/listings/records',
        },
      ],
      pay: {
        method: 'prepaid_balance',
        provider: 'PayPal',
        topUpUrl: 'https://spigot.onrender.com/buyers/topup',
        mcp: 'https://spigot.onrender.com/mcp',
      },
      terms: 'https://spigot.onrender.com/c/bluebonnet/terms',
    };
    expect(built.status).toBe(402);
    expect(built.body).toEqual(expected);
    expect(built.json).toBe(JSON.stringify(expected));
    expect(Object.keys(built.body.datasets[0]!)).toEqual([
      'slug',
      'type',
      'records',
      'perRecordMicros',
      'endpoint',
    ]);
  });

  it('builds the api.md headers exactly', () => {
    expect(built.headers).toEqual({
      Link: [
        '<https://spigot.onrender.com/v1/bluebonnet/datasets/listings>; rel="alternate"; type="application/json"',
        '<https://spigot.onrender.com/c/bluebonnet>; rel="payment"',
      ],
      'Cache-Control': 'no-store',
      'Spigot-Price': 'listings; per-record-micros=1500',
    });
    expect(built.contentType.json).toMatch(/^application\/json/);
    expect(built.contentType.html).toMatch(/^text\/html/);
  });

  it('lists every dataset in Spigot-Price and the body', () => {
    const b = build402(
      parsePolicy(
        demoPolicyWire({
          prices: [
            { dataset: 'listings', perRecordMicros: 1500 },
            { dataset: 'agents', perRecordMicros: 500 },
          ],
        }),
      ),
    );
    expect(b.headers['Spigot-Price']).toBe(
      'listings; per-record-micros=1500, agents; per-record-micros=500',
    );
    expect(b.body.datasets.map((d) => d.slug)).toEqual(['listings', 'agents']);
    expect(b.body.datasets[0]).not.toHaveProperty('records');
  });

  it('works with no live datasets yet', () => {
    const b = build402(parsePolicy(demoPolicyWire({ prices: [], siteName: undefined })));
    expect(b.body.site).toBe('bluebonnet');
    expect(b.body.error.message).toBe('This site sells its data as an API.');
    expect(b.headers['Spigot-Price']).toBeUndefined();
    expect(b.headers.Link[0]).toBe(
      '<https://spigot.onrender.com/v1/bluebonnet>; rel="alternate"; type="application/json"',
    );
  });

  describe('D04 HTML', () => {
    it('states the facts and links to the catalog and MCP', () => {
      expect(built.html).toContain(
        'Bluebonnet Rentals sells this data as an API. $1.50 per 1,000 listings, live, typed. Pay with a PayPal-funded balance.',
      );
      expect(built.html).toContain('href="https://spigot.onrender.com/c/bluebonnet"');
      expect(built.html).toContain('href="https://spigot.onrender.com/mcp"');
    });

    it('is static (no JS) and under 2 KB', () => {
      expect(built.html).not.toMatch(/<script|javascript:|\son[a-z]+=/i);
      expect(Buffer.byteLength(built.html, 'utf8')).toBeLessThan(D04_MAX_BYTES);
    });

    it('stays under 2 KB with a worst-case policy', () => {
      const prices = Array.from({ length: 50 }, (_, i) => ({
        dataset: `dataset-${'x'.repeat(60)}-${i}`,
        perRecordMicros: 123_456_789,
      }));
      const b = build402(parsePolicy(demoPolicyWire({ prices, siteName: '数'.repeat(300) })));
      expect(Buffer.byteLength(b.html, 'utf8')).toBeLessThan(D04_MAX_BYTES);
      expect(b.html).toContain('more in the catalog');
    });

    it('escapes the site name', () => {
      const b = build402(parsePolicy(demoPolicyWire({ siteName: '<img src=x onerror=alert(1)>' })));
      expect(b.html).not.toContain('<img');
      expect(b.html).toContain('&#60;img');
    });
  });

  it('builds once: the same object is safe to reuse per request', () => {
    const p = parsePolicy(demoPolicyWire());
    expect(build402(p).json).toBe(build402(p).json);
  });
});

describe('dollarsPer1000', () => {
  it.each([
    [1500, '$1.50'],
    [500, '$0.50'],
    [10, '$0.01'],
    [5, '$0.005'],
    [1234, '$1.234'],
    [0, '$0.00'],
    [2_500_000, '$2,500.00'],
  ])('%i micros/record → %s', (micros, out) => {
    expect(dollarsPer1000(micros)).toBe(out);
  });
});
