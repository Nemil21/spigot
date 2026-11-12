import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { recordHash } from './canonical.js';
import { compileExtractor, extract } from './extract.js';
import type { ExtractorSpecInput } from './spec.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const ORIGIN = 'https://bluebonnet.example.com';
const LISTING_URL = `${ORIGIN}/listings/2br-east-cesar-chavez-4471`;
const listingHtml = fixture('listing.html');

/** Hand-written Listing spec, as `propose_schema` would return it (features/04 §2). */
const LISTING_SPEC: ExtractorSpecInput = {
  recordKey: { from: 'url' },
  fields: [
    {
      name: 'price_usd',
      type: 'integer',
      required: true,
      source: { jsonld: '$.offers.price' },
      transforms: ['toInt'],
    },
    {
      name: 'bedrooms',
      type: 'integer',
      source: { jsonld: '$.numberOfRooms' },
      transforms: ['toInt'],
    },
    { name: 'sqft', type: 'integer', source: { jsonld: '$.floorSize.value' } },
    { name: 'city', type: 'string', source: { jsonld: '$.address.addressLocality' } },
    {
      name: 'available_from',
      type: 'date',
      source: { css: 'dl.facts dd[data-k=available]', attr: 'text' },
      transforms: ['trim', 'date'],
    },
    {
      name: 'pets_allowed',
      type: 'boolean',
      source: { css: 'dl.facts dd[data-k=pets]', attr: 'text' },
      transforms: ['bool:ok'],
    },
    {
      name: 'photos',
      type: 'string[]',
      source: { css: '.gallery img', attr: 'src', all: true },
      transforms: ['absoluteUrl'],
    },
    {
      name: 'amenities',
      type: 'string[]',
      source: { css: 'ul.amenities li', attr: 'text', all: true },
    },
    {
      name: 'agent_url',
      type: 'url',
      source: { css: '.agent-card a.agent-link', attr: 'href' },
      transforms: ['absoluteUrl'],
    },
    {
      name: 'price_text',
      type: 'number',
      source: { css: '.listing-price .price' },
      transforms: ['money'],
    },
  ],
};

describe('extract: Listing on the demo fixture', () => {
  const rec = extract(listingHtml, LISTING_SPEC, LISTING_URL);

  it('reads price/bedrooms from JSON-LD and available_from/pets_allowed from CSS', () => {
    expect(rec).not.toBeNull();
    expect(rec!.data).toEqual({
      price_usd: 2150,
      bedrooms: 2,
      sqft: 910,
      city: 'Austin',
      available_from: '2026-12-15',
      pets_allowed: true,
      photos: [
        `${ORIGIN}/img/listings/2br-east-cesar-chavez-4471-1.jpg`,
        `${ORIGIN}/img/listings/2br-east-cesar-chavez-4471-2.jpg`,
      ],
      amenities: ['In-unit laundry', 'Balcony', 'Covered parking'],
      agent_url: `${ORIGIN}/agents/maya-okafor`,
      price_text: 2150,
    });
  });

  it('record key is the last path segment, without the dataset slug', () => {
    expect(rec!.recordKey).toBe('2br-east-cesar-chavez-4471');
    expect(extract(listingHtml, LISTING_SPEC, `${LISTING_URL}/?ref=x#top`)!.recordKey).toBe(
      '2br-east-cesar-chavez-4471',
    );
  });

  it('returns url (and updatedAt) as metadata outside data', () => {
    expect(rec!.url).toBe(LISTING_URL);
    expect(rec!.updatedAt).toBeNull();
    expect(rec!.data).not.toHaveProperty('url');
    expect(rec!.data).not.toHaveProperty('updated_at');
  });

  it('re-extracting the same HTML with a different crawl time gives the same hash', () => {
    const a = extract(listingHtml, LISTING_SPEC, LISTING_URL, {
      updatedAt: '2026-12-01T00:00:00.000Z',
    })!;
    const b = extract(listingHtml, LISTING_SPEC, LISTING_URL, {
      updatedAt: '2026-12-09T08:30:00.000Z',
    })!;
    expect(a.updatedAt).not.toBe(b.updatedAt);
    expect(recordHash(a.data, sha256)).toBe(recordHash(b.data, sha256));
  });

  it('HTML whitespace and JSON-LD key order/whitespace changes give the same hash', () => {
    const reformatted = listingHtml
      .replace(/\n\s*/g, '\n')
      .replace('"price": "2150",\n"priceCurrency": "USD",', '"priceCurrency":"USD","price":"2150",')
      .replace(
        '<dd data-k="pets">Cats and dogs OK</dd>',
        '<dd data-k="pets">\n  Cats   and dogs\tOK\n</dd>',
      );
    expect(reformatted).not.toBe(listingHtml);
    const r = extract(reformatted, LISTING_SPEC, LISTING_URL)!;
    expect(recordHash(r.data, sha256)).toBe(recordHash(rec!.data, sha256));
  });

  it('a rent change gives a different hash', () => {
    const changed = listingHtml.replace('"price": "2150"', '"price": "2195"');
    expect(recordHash(extract(changed, LISTING_SPEC, LISTING_URL)!.data, sha256)).not.toBe(
      recordHash(rec!.data, sha256),
    );
  });

  it('failed coercions become null, other fields survive', () => {
    const broken = listingHtml
      .replace('2026-12-15', 'Call us')
      .replace('"numberOfRooms": 2', '"numberOfRooms": "studio"');
    const r = extract(broken, LISTING_SPEC, LISTING_URL)!;
    expect(r.data.available_from).toBeNull();
    expect(r.data.bedrooms).toBeNull();
    expect(r.data.price_usd).toBe(2150);
  });

  it('returns null when every required field is null', () => {
    const noPrice = listingHtml.replace('"price": "2150",', '');
    expect(extract(noPrice, LISTING_SPEC, LISTING_URL)).toBeNull();
    expect(extract('<html><body>Not found</body></html>', LISTING_SPEC, LISTING_URL)).toBeNull();
  });
});

describe('extract: CSS-only templates (no JSON-LD)', () => {
  it('Agent', () => {
    const spec: ExtractorSpecInput = {
      recordKey: { from: 'url' },
      fields: [
        { name: 'name', type: 'string', required: true, source: { css: '.agent-name' } },
        { name: 'agent_phone', type: 'string', source: { css: '.agent-phone' } },
        {
          name: 'active_listings',
          type: 'integer',
          source: { css: 'dd[data-k=listings]' },
          transforms: ['firstInt'],
        },
        {
          name: 'languages',
          type: 'string[]',
          source: { css: 'dd[data-k=languages]' },
          transforms: ['split:,'],
        },
        {
          name: 'licensed_since',
          type: 'date',
          source: { css: 'dd[data-k=licensed]' },
          transforms: ['date'],
        },
        {
          name: 'licensed_year',
          type: 'integer',
          source: { css: 'dd[data-k=licensed]' },
          transforms: ['regex:(\\d{4})'],
        },
      ],
    };
    const r = extract(fixture('agent.html'), spec, `${ORIGIN}/agents/maya-okafor`);
    expect(r).toEqual({
      recordKey: 'maya-okafor',
      url: `${ORIGIN}/agents/maya-okafor`,
      updatedAt: null,
      data: {
        name: 'Maya Okafor',
        agent_phone: '(512) 555-0142',
        active_listings: 37,
        languages: ['English', 'Yoruba', 'Spanish'],
        licensed_since: '2015-03-04',
        licensed_year: 2015,
      },
    });
  });

  it('Open House: <time datetime> → UTC datetime', () => {
    const spec: ExtractorSpecInput = {
      recordKey: { from: 'url' },
      fields: [
        {
          name: 'starts_at',
          type: 'datetime',
          required: true,
          source: { css: '.when time', attr: 'datetime' },
          transforms: ['datetime'],
        },
        {
          name: 'listing_url',
          type: 'url',
          source: { css: 'a.listing-link', attr: 'href' },
          transforms: ['absoluteUrl'],
        },
      ],
    };
    const r = extract(fixture('open-house.html'), spec, `${ORIGIN}/open-houses/oh-12`);
    expect(r?.recordKey).toBe('oh-12');
    expect(r?.data).toEqual({
      starts_at: '2026-12-06T19:00:00.000Z',
      listing_url: `${ORIGIN}/listings/2br-mueller-1904`,
    });
  });

  it('with no required fields, null only when every field is null', () => {
    const spec: ExtractorSpecInput = {
      recordKey: { from: 'url' },
      fields: [{ name: 'name', type: 'string', source: { css: '.agent-name' } }],
    };
    expect(extract(fixture('agent.html'), spec, `${ORIGIN}/agents/x`)).not.toBeNull();
    expect(extract('<p>empty</p>', spec, `${ORIGIN}/agents/x`)).toBeNull();
  });
});

describe('extract: JSON-LD handling', () => {
  const spec = (jsonld: string, type: 'string' | 'integer' = 'string'): ExtractorSpecInput => ({
    recordKey: { from: 'url' },
    fields: [{ name: 'v', type, source: { jsonld } }],
  });
  const ld = (...blocks: string[]) =>
    blocks.map((b) => `<script type="application/ld+json">${b}</script>`).join('');

  it('first match across all blocks, skipping invalid ones', () => {
    const html = ld(
      '{not json',
      '{"@type":"Organization"}',
      '{"name":"second"}',
      '{"name":"third"}',
    );
    expect(extract(html, spec('$.name'), LISTING_URL)?.data.v).toBe('second');
  });

  it('searches top-level arrays and @graph nodes', () => {
    expect(
      extract(ld('[{"@type":"A"},{"name":"in array"}]'), spec('$.name'), LISTING_URL)?.data.v,
    ).toBe('in array');
    expect(
      extract(ld('{"@graph":[{"@type":"A"},{"name":"in graph"}]}'), spec('$.name'), LISTING_URL)
        ?.data.v,
    ).toBe('in graph');
  });

  it('matches type attributes case-insensitively and with parameters', () => {
    const html =
      '<script type="Application/LD+JSON; charset=utf-8">{"name":"x"}</script><script>{"name":"js"}</script>';
    expect(extract(html, spec('$.name'), LISTING_URL)?.data.v).toBe('x');
  });

  it('unwraps @value objects; other objects coerce to null', () => {
    expect(
      extract(ld('{"n":{"@value":"7"},"o":{"a":1}}'), spec('$.n', 'integer'), LISTING_URL)?.data.v,
    ).toBe(7);
    expect(
      extract(
        ld('{"n":1,"o":{"a":1}}'),
        {
          recordKey: { from: 'url' },
          fields: [
            { name: 'n', type: 'integer', source: { jsonld: '$.n' } },
            { name: 'o', type: 'string', source: { jsonld: '$.o' } },
          ],
        },
        LISTING_URL,
      )?.data.o,
    ).toBeNull();
  });

  it('recordKey from a JSON-LD path', () => {
    const s: ExtractorSpecInput = {
      recordKey: { jsonld: "$['@id']" },
      fields: [{ name: 'n', type: 'string', source: { jsonld: '$.name' } }],
    };
    expect(extract(listingHtml, s, LISTING_URL)?.recordKey).toBe(
      `${ORIGIN}/listings/2br-east-cesar-chavez-4471`,
    );
    // No key → not a record.
    expect(extract(ld('{"name":"no id"}'), s, LISTING_URL)).toBeNull();
  });

  it('an origin URL has no record key', () => {
    expect(extract(listingHtml, LISTING_SPEC, `${ORIGIN}/`)).toBeNull();
  });
});

describe('compileExtractor', () => {
  it('compiles once and is reused', () => {
    const c = compileExtractor(LISTING_SPEC);
    expect(c.extract(listingHtml, LISTING_URL)).toEqual(
      extract(listingHtml, LISTING_SPEC, LISTING_URL),
    );
  });

  it('uses an injected regex engine', () => {
    const calls: string[] = [];
    const spec: ExtractorSpecInput = {
      recordKey: { from: 'url' },
      fields: [{ name: 'n', type: 'string', source: { css: 'h1' }, transforms: ['regex:(\\w+)'] }],
    };
    const r = extract('<h1>Hello world</h1>', spec, LISTING_URL, {
      regex: { compile: (p) => (calls.push(p), { firstGroup: () => 'stub' }) },
    });
    expect(calls).toEqual(['(\\w+)']);
    expect(r?.data.n).toBe('stub');
  });
});

/** 2,341 listing pages shaped like the demo site (features/01), each with its own facts. */
function demoPages(n: number) {
  const hoods = ['mueller', 'east-cesar-chavez', 'zilker', 'hyde-park', 'bouldin', 'tarrytown'];
  return Array.from({ length: n }, (_, i) => {
    const beds = (i % 4) + 1;
    const slug = `${beds}br-${hoods[i % hoods.length]}-${1000 + i}`;
    const html = listingHtml
      .replaceAll('2br-east-cesar-chavez-4471', slug)
      .replace('"price": "2150"', `"price": "${1200 + (i % 900)}"`)
      .replace('"numberOfRooms": 2', `"numberOfRooms": ${beds}`)
      .replace('2026-12-15', `2027-01-${String((i % 28) + 1).padStart(2, '0')}`)
      .replace('Cats and dogs OK', i % 3 ? 'Cats and dogs OK' : 'No pets');
    return { url: `${ORIGIN}/listings/${slug}`, html, i, beds };
  });
}

describe('performance', () => {
  it('extracts 2,341 fixture pages in < 10 s', () => {
    const pages = demoPages(2341);
    const t0 = performance.now();
    const records = pages.map((p) => extract(p.html, LISTING_SPEC, p.url));
    const elapsed = performance.now() - t0;
    expect(records.every((r) => r !== null)).toBe(true);
    expect(new Set(records.map((r) => r!.recordKey)).size).toBe(2341);
    const last = records[2340]!;
    expect(last.data.price_usd).toBe(1200 + (2340 % 900));
    expect(last.data.bedrooms).toBe(pages[2340]!.beds);
    expect(records[0]!.data.pets_allowed).toBe(false);
    expect(records[1]!.data.pets_allowed).toBe(true);
    console.log(`extracted 2,341 pages in ${Math.round(elapsed)} ms`);
    expect(elapsed).toBeLessThan(10_000);
  }, 30_000);
});
