import { afterEach, describe, expect, it, vi } from 'vitest';

// Spy on the evaluator: a rejected spec must never reach it.
const jsonPathCalls = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock('./jsonpath.js', async (orig) => {
  const mod = await orig<typeof import('./jsonpath.js')>();
  return {
    ...mod,
    jsonPathFirst: (path: string, roots: readonly unknown[]) => {
      jsonPathCalls.paths.push(path);
      return mod.jsonPathFirst(path, roots);
    },
  };
});

const { compileExtractor, extract } = await import('./extract.js');
const { extractorSpecSchema, jsonPathSchema, recordKeySchema, transformSchema } = await import(
  './spec.js'
);

const HTML = `<script type="application/ld+json">{"@type":"Apartment","numberOfRooms":2,"offers":{"price":2150}}</script>`;
const URL_ = 'https://bluebonnet.example.com/listings/2br-east-cesar-chavez-4471';

const specWith = (jsonld: string) => ({
  recordKey: { from: 'url' },
  fields: [{ name: 'x', type: 'string', source: { jsonld } }],
});

afterEach(() => {
  jsonPathCalls.paths.length = 0;
});

describe('JSONPath grammar', () => {
  it.each(["$.offers.price", "$['@id']", '$.offers[0].price', "$['@graph'][1].name", '$.@type', '$.a_b.c-d'])(
    'accepts %s',
    (p) => {
      expect(jsonPathSchema.safeParse(p).success).toBe(true);
    },
  );

  const malicious = [
    "$..[?(@.constructor.constructor('return process')())]",
    '$[?(@.price < 10)]',
    '$.offers[?(@.price)]',
    "$['a'][?(1)]",
    '$..price',
    '$.*',
    '$[*]',
    '$[0:2]',
    '$[0,1]',
    '$.offers.(price)',
    '$',
    'offers.price',
    "$['a'];process.exit()",
    '$.' + 'a'.repeat(250),
  ];

  it.each(malicious)('rejects %s', (p) => {
    expect(jsonPathSchema.safeParse(p).success).toBe(false);
  });

  it.each(malicious.filter((p) => p.includes('?(')))(
    'a spec with %s is rejected and the path is never evaluated',
    (p) => {
      expect(() => compileExtractor(specWith(p))).toThrow();
      expect(() => extract(HTML, specWith(p), URL_)).toThrow();
      expect(() => extract(HTML, { recordKey: { jsonld: p }, fields: specWith('$.name').fields }, URL_)).toThrow();
      expect(jsonPathCalls.paths).toEqual([]);
    },
  );

  it('valid paths do reach the evaluator', () => {
    expect(extract(HTML, specWith('$.offers.price'), URL_)?.data).toEqual({ x: '2150' });
    expect(jsonPathCalls.paths).toContain('$.offers.price');
  });

  it('cannot reach prototype members', () => {
    for (const p of ['$.constructor', '$.constructor.name', '$.__proto__', '$.toString', "$['constructor']['constructor']"]) {
      expect(extract(HTML, { recordKey: { from: 'url' }, fields: [{ name: 'x', type: 'string', source: { jsonld: p } }, { name: 'y', type: 'integer', required: true, source: { jsonld: '$.numberOfRooms' } }] }, URL_)?.data.x).toBeNull();
    }
  });
});

describe('transform whitelist', () => {
  it.each([
    'trim', 'lower', 'toInt', 'toFloat', 'firstInt', 'money', 'date', 'datetime', 'absoluteUrl',
    'split:,', 'split: / ', 'bool:yes', 'bool:dogs ok', 'regex:(\\d+)',
  ])('accepts %s', (t) => {
    expect(transformSchema.safeParse(t).success).toBe(true);
  });

  it.each([
    'eval', 'upper', 'toint', 'trim:', 'split:', 'split:' + ','.repeat(11), 'bool:', 'bool:   ',
    'regex:(a+)+$', 'regex:' + 'a'.repeat(101), 'regex:(a)\\1', 'js:process.exit()', '',
  ])('rejects %j', (t) => {
    expect(transformSchema.safeParse(t).success).toBe(false);
  });

  it('an unknown transform rejects the whole spec', () => {
    const spec = { recordKey: { from: 'url' }, fields: [{ name: 'x', type: 'string', source: { css: 'h1' }, transforms: ['trim', 'exec'] }] };
    expect(extractorSpecSchema.safeParse(spec).success).toBe(false);
  });

  it('a catastrophic regex rejects the whole spec', () => {
    const spec = { recordKey: { from: 'url' }, fields: [{ name: 'x', type: 'string', source: { css: 'h1' }, transforms: ['regex:(\\w+\\s?)*$'] }] };
    expect(extractorSpecSchema.safeParse(spec).success).toBe(false);
  });
});

describe('extractor spec', () => {
  const ok = {
    recordKey: { from: 'url' },
    fields: [{ name: 'price_usd', type: 'integer', required: true, source: { jsonld: '$.offers.price' }, transforms: ['toInt'] }],
  };

  it('applies defaults and strips non-extractor keys (propose_schema extras)', () => {
    const parsed = extractorSpecSchema.parse({
      ...ok,
      fields: [{ name: 'title', type: 'string', source: { css: 'h1' }, description: 'Title', filterable: ['eq'], pii: false }],
    });
    expect(parsed.fields[0]).toEqual({ name: 'title', type: 'string', required: false, source: { css: 'h1', attr: 'text' }, transforms: [] });
  });

  it.each([
    ['unknown type', { ...ok, fields: [{ ...ok.fields[0], type: 'object' }] }],
    ['non-snake name', { ...ok, fields: [{ ...ok.fields[0], name: 'PriceUSD' }] }],
    ['reserved url', { ...ok, fields: [{ ...ok.fields[0], name: 'url' }] }],
    ['reserved updated_at', { ...ok, fields: [{ ...ok.fields[0], name: 'updated_at' }] }],
    ['duplicate names', { ...ok, fields: [ok.fields[0], ok.fields[0]] }],
    ['no fields', { ...ok, fields: [] }],
    ['mixed source', { ...ok, fields: [{ ...ok.fields[0], source: { jsonld: '$.a', css: 'h1' } }] }],
    ['bad attr', { ...ok, fields: [{ ...ok.fields[0], source: { css: 'a', attr: 'on click' } }] }],
    ['empty css', { ...ok, fields: [{ ...ok.fields[0], source: { css: '  ' } }] }],
    ['bad recordKey', { ...ok, recordKey: { from: 'title' } }],
  ])('rejects %s', (_why, spec) => {
    expect(extractorSpecSchema.safeParse(spec).success).toBe(false);
  });

  it('recordKey accepts url and a JSON-LD path', () => {
    expect(recordKeySchema.safeParse({ from: 'url' }).success).toBe(true);
    expect(recordKeySchema.safeParse({ jsonld: "$['@id']" }).success).toBe(true);
  });

  it('an invalid CSS selector is rejected at compile time', () => {
    expect(() => compileExtractor({ ...ok, fields: [{ name: 'x', type: 'string', source: { css: 'dl[' } }] })).toThrow(/invalid CSS selector/);
  });
});
