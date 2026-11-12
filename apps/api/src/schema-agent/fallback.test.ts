// SP-012b: model retries with backoff, `ModelUnavailableError`, the live `repair_fields` call and
// the JSON-LD-only auto-schema (no DB; the 529 → stored proposal path is in propose.db.test.ts).
import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { compileExtractor } from '@spigot/shared';
import { describe, expect, it } from 'vitest';
import {
  createLiveModel,
  isTransientModelError,
  MODEL_ATTEMPTS,
  ModelUnavailableError,
  withModelRetry,
} from './claude.js';
import type { SamplePage } from './dryrun.js';
import { AUTO_SCHEMA_LABEL, autoSchema, typeNameFor } from './fallback.js';
import { validateProposal } from './propose.js';
import { REPAIR_FIELDS_TOOL_NAME } from './repair.js';
import { proposalSchema } from './tool.js';

const listingHtml = readFileSync(new URL('./__fixtures__/listing.html', import.meta.url), 'utf8');
const agentHtml = readFileSync(new URL('./__fixtures__/agent.html', import.meta.url), 'utf8');

const apiError = (status: number, headers: Record<string, string> = {}) =>
  Anthropic.APIError.generate(
    status,
    {
      type: 'error',
      error: { type: status === 529 ? 'overloaded_error' : 'api_error', message: 'x' },
    },
    undefined,
    new Headers(headers),
  );

/** A JSON-LD Apartment page, with per-page values. */
function apartmentPage(i: number, opts: { before?: unknown[]; graph?: boolean } = {}): SamplePage {
  const entity = {
    '@context': 'https://schema.org',
    '@type': 'Apartment',
    name: `${i + 1}BR in Mueller`,
    numberOfRooms: i + 1,
    numberOfBathroomsTotal: 1.5,
    petsAllowed: i % 2 === 0,
    datePosted: `2026-10-${String(i + 10).padStart(2, '0')}`,
    url: `https://demo.example/listings/l-${i}`,
    amenityFeature: ['Pool', 'Gym'],
    floorSize: { '@type': 'QuantitativeValue', value: 900 + i, unitCode: 'FTK' },
    address: {
      '@type': 'PostalAddress',
      streetAddress: ` ${100 + i} Main St `,
      postalCode: '78723',
    },
    offers: [{ '@type': 'Offer', price: 1800 + i, priceCurrency: 'USD' }],
  };
  const blocks = [...(opts.before ?? []), opts.graph ? { '@graph': [entity] } : entity];
  return {
    id: `p${i}`,
    url: `https://demo.example/listings/l-${i}`,
    html: `<html><head>${blocks
      .map((b) => `<script type="application/ld+json">${JSON.stringify(b)}</script>`)
      .join('')}</head><body><h1>x</h1></body></html>`,
  };
}

describe('withModelRetry: 3 tries with backoff, then ModelUnavailableError', () => {
  it('overloaded (529) three times → ModelUnavailableError after waiting between tries', async () => {
    const waits: number[] = [];
    let n = 0;
    const err = await withModelRetry(
      async () => {
        n++;
        throw apiError(529);
      },
      { delaysMs: [100, 400], sleep: async (ms) => void waits.push(ms) },
    ).catch((e: unknown) => e);
    expect(n).toBe(MODEL_ATTEMPTS);
    expect(waits).toEqual([100, 400]);
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect(err).toMatchObject({ attempts: 3, status: 529 });
    expect((err as Error).cause).toBeInstanceOf(Anthropic.APIError);
  });

  it('a longer retry-after wins (capped at 30 s); success on a later try returns it', async () => {
    const waits: number[] = [];
    let n = 0;
    const out = await withModelRetry(
      async () => {
        n++;
        if (n === 1) throw apiError(429, { 'retry-after': '5' });
        if (n === 2) throw apiError(429, { 'retry-after': '600' });
        return 'ok';
      },
      { delaysMs: [100, 400], sleep: async (ms) => void waits.push(ms) },
    );
    expect(out).toBe('ok');
    expect(waits).toEqual([5_000, 30_000]);
  });

  it('only transient errors are retried: 400 / 401 / bugs propagate on the first try', async () => {
    for (const e of [apiError(400), apiError(401), new TypeError('bug')]) {
      let n = 0;
      await expect(
        withModelRetry(
          async () => {
            n++;
            throw e;
          },
          { sleep: async () => {} },
        ),
      ).rejects.toBe(e);
      expect(n).toBe(1);
    }
    expect(isTransientModelError(apiError(500))).toBe(true);
    expect(isTransientModelError(apiError(408))).toBe(true);
    expect(isTransientModelError(new Anthropic.APIConnectionError({ message: 'reset' }))).toBe(
      true,
    );
    expect(isTransientModelError(new Anthropic.APIUserAbortError())).toBe(false);
  });
});

describe('live model (stub client)', () => {
  it('Claude stubbed to 529: one proposal attempt = 3 requests, then ModelUnavailableError', async () => {
    let requests = 0;
    const client = {
      beta: {
        messages: {
          create: async () => {
            requests++;
            throw apiError(529);
          },
        },
      },
    };
    const model = createLiveModel({
      apiKey: 'k',
      client: client as never,
      retry: { delaysMs: [0, 0] },
    });
    await expect(
      model.open({ pathPattern: '/listings/:slug', userPrompt: 'PAGES' }).first(),
    ).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(requests).toBe(3);
  });

  it('repair(): a fresh call with only repair_fields, the cached system + DSL, and the repair rules', async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = {
      beta: {
        messages: {
          create: async (body: Record<string, unknown>) => {
            bodies.push(structuredClone(body));
            return {
              id: 'msg',
              model: 'claude-opus-5-5',
              stop_reason: 'tool_use',
              usage: { input_tokens: 10, output_tokens: 5 },
              content: [
                {
                  type: 'tool_use',
                  id: 'tu',
                  name: REPAIR_FIELDS_TOOL_NAME,
                  input: { fields: [] },
                },
              ],
            };
          },
        },
      },
    };
    const model = createLiveModel({ apiKey: 'k', client: client as never });
    const turn = await model.repair({
      pathPattern: '/listings/:slug',
      round: 1,
      userPrompt: 'FIX',
    });
    expect(turn).toMatchObject({
      input: { fields: [] },
      replayed: false,
      usage: { inputTokens: 10 },
    });
    const req = bodies[0]!;
    expect((req.tools as { name: string }[]).map((t) => t.name)).toEqual([REPAIR_FIELDS_TOOL_NAME]);
    expect(req.messages).toEqual([{ role: 'user', content: 'FIX' }]);
    expect(req).not.toHaveProperty('temperature');
    const system = req.system as { text: string; cache_control?: unknown }[];
    expect(system).toHaveLength(3);
    expect(system[0]!.text).toMatch(/untrusted data/);
    expect(system[1]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(system[2]!.text).toMatch(/only output is one call to the `repair_fields` tool/);
  });
});

describe('autoSchema: JSON-LD-only proposal (no AI)', () => {
  const samples = [0, 1, 2, 3, 4].map((i) => apartmentPage(i));
  const input = (s: SamplePage[]) => ({
    pathPattern: '/listings/:slug',
    jsonldTypes: ['Apartment'],
    samples: s,
    reason: 'HTTP 529 after 3 tries',
  });

  it('flattens the main entity to typed fields; the proposal validates and extracts', () => {
    const p = autoSchema(input(samples))!;
    expect(proposalSchema.parse(p)).toBeTruthy();
    expect(p.typeName).toBe('Listing');
    expect(p.recordKey).toEqual({ from: 'url' });
    expect(p.rationale.startsWith(`${AUTO_SCHEMA_LABEL}: Claude was unavailable (HTTP 529`)).toBe(
      true,
    );
    const byName = Object.fromEntries(p.fields.map((f) => [f.name, f]));
    expect(byName).toMatchObject({
      name: { type: 'string', source: { jsonld: '$.name' }, transforms: ['trim'], required: true },
      number_of_rooms: { type: 'integer', source: { jsonld: '$.numberOfRooms' }, required: true },
      number_of_bathrooms_total: { type: 'number' },
      pets_allowed: { type: 'boolean' },
      date_posted: { type: 'date' },
      jsonld_url: { type: 'url', source: { jsonld: '$.url' } },
      amenity_feature: { type: 'string[]' },
      floor_size_value: { type: 'integer', source: { jsonld: '$.floorSize.value' } },
      address_postal_code: { type: 'string' }, // ZIP stays a string
      offers_price: { type: 'integer', source: { jsonld: '$.offers.price' } },
    });
    expect(p.fields.filter((f) => f.required)).toHaveLength(3);
    expect(p.fields.some((f) => f.name === 'url' || f.name.startsWith('f_'))).toBe(false);
    const v = validateProposal(p, samples);
    expect(v.ok).toBe(true);
    const rec = compileExtractor(p).extract(samples[2]!.html, samples[2]!.url)!;
    expect(rec.data).toMatchObject({
      offers_price: 1802,
      address_street_address: '102 Main St',
      amenity_feature: ['Pool', 'Gym'],
      pets_allowed: true,
    });
  });

  it('works on the SP-004a listing fixture and on @graph pages', () => {
    const fixture = autoSchema(
      input([{ id: 'a', url: 'https://d.example/listings/x', html: listingHtml }]),
    )!;
    expect(fixture.fields.map((f) => f.name)).toEqual(
      expect.arrayContaining(['name', 'number_of_rooms', 'offers_price', 'address_postal_code']),
    );
    const graph = autoSchema(input([0, 1, 2].map((i) => apartmentPage(i, { graph: true }))))!;
    expect(graph.fields.find((f) => f.name === 'offers_price')).toBeTruthy();
  });

  it('skips paths the extractor would read from another entity (a breadcrumb first on the page)', () => {
    const crumb = { '@type': 'BreadcrumbList', name: 'Listings', itemListElement: [] };
    const p = autoSchema(input([0, 1, 2].map((i) => apartmentPage(i, { before: [crumb] }))))!;
    const names = p.fields.map((f) => f.name);
    expect(names).not.toContain('name'); // `$.name` would hit the breadcrumb's name
    expect(names).toContain('offers_price');
    expect(
      validateProposal(
        p,
        [0, 1, 2].map((i) => apartmentPage(i, { before: [crumb] })),
      ).ok,
    ).toBe(true);
  });

  it('no JSON-LD (Agent / Open House pages) → no auto-schema', () => {
    expect(
      autoSchema(input([{ id: 'a', url: 'https://d.example/agents/x', html: agentHtml }])),
    ).toBeNull();
    expect(autoSchema(input([]))).toBeNull();
  });

  it('type name from the URL pattern, else the JSON-LD type', () => {
    expect(typeNameFor('/listings/:slug', 'Apartment')).toBe('Listing');
    expect(typeNameFor('/open-houses/:id', undefined)).toBe('Open House');
    expect(typeNameFor('/properties/:id', undefined)).toBe('Property');
    expect(typeNameFor('/:slug', 'Product')).toBe('Product');
    expect(typeNameFor('/:slug', 'lower case')).toBe('Record');
  });
});
