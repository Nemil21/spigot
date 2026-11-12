import { readFileSync } from 'node:fs';
import { clusterUrls } from '@spigot/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { demoSite, type DemoPage } from '../test/schema-agent/demoPages.js';
import {
  createLiveModel,
  createRecordedModel,
  loadRecorded,
  RecordedProposalMissingError,
} from './claude.js';
import type { SamplePage } from './dryrun.js';
import { slugForTypeName } from './persist.js';
import { BYLINE_RE, EMAIL_RE, guardFields, PHONE_RE, STREET_UNIT_RE } from './pii.js';
import { buildUserPrompt, validateProposal } from './propose.js';
import { PROPOSE_SCHEMA_TOOL, proposalSchema, type Proposal } from './tool.js';

const injectionHtml = readFileSync(
  new URL('./__fixtures__/injection-listing.html', import.meta.url),
  'utf8',
);
const recorded = loadRecorded();
const recordedInput = (pattern: string) =>
  structuredClone(recorded.get(pattern)!.input) as Proposal;

let pages: DemoPage[];
const sample = (prefix: string, n = 5): SamplePage[] =>
  pages
    .filter((p) => p.path.startsWith(prefix))
    .slice(0, n)
    .map((p, i) => ({
      id: `${prefix}${i}`,
      url: `https://bluebonnet.example${p.path}`,
      html: p.html,
    }));

beforeAll(async () => {
  pages = (await demoSite(0.05)).pages;
});

/** Validate + guard, as the pipeline does before selfCheck/persist. */
function run(input: unknown, samples: SamplePage[], jsonldTypes: string[] = []) {
  const v = validateProposal(input, samples);
  if (!v.ok) throw new Error(v.problems.join('; '));
  return { ...v, guarded: guardFields(v.proposal, v.run, { jsonldTypes }) };
}
const field = (r: ReturnType<typeof run>, name: string) =>
  r.guarded.fields.find((f) => f.name === name)!;

describe('propose_schema tool', () => {
  it('is the only tool, with a JSON schema derived from the Zod spec', () => {
    expect(PROPOSE_SCHEMA_TOOL.name).toBe('propose_schema');
    const schema = PROPOSE_SCHEMA_TOOL.input_schema as Record<string, unknown>;
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['typeName', 'recordKey', 'fields', 'rationale']);
    expect(JSON.stringify(schema)).toContain('"filterable"');
    expect(schema).not.toHaveProperty('$schema');
  });

  it('rejects an unknown transform, a JSONPath filter and a lower-case type name', () => {
    const base = recordedInput('/listings/:slug');
    const bad = (mutate: (p: Proposal) => void) => {
      const p = structuredClone(base);
      mutate(p);
      return proposalSchema.safeParse(p).success;
    };
    expect(bad(() => {})).toBe(true);
    expect(bad((p) => (p.fields[0]!.transforms = ['eval'] as never))).toBe(false);
    expect(bad((p) => (p.fields[0]!.source = { jsonld: '$..price' }))).toBe(false);
    expect(bad((p) => (p.typeName = 'listing'))).toBe(false);
  });

  it('strips keys the model invents', () => {
    const p = recordedInput('/listings/:slug') as unknown as Record<string, unknown>;
    p.sql = 'DROP TABLE x';
    (p.fields as Record<string, unknown>[])[0]!.onLoad = 'alert(1)';
    const parsed = proposalSchema.parse(p);
    expect(parsed).not.toHaveProperty('sql');
    expect(parsed.fields[0]).not.toHaveProperty('onLoad');
  });
});

describe('recorded proposals on real SP-004a pages', () => {
  it('there is one for each demo template (clustering is checked at full scale in propose.db.test.ts)', () => {
    expect([...recorded.keys()].sort()).toEqual([
      '/agents/:slug',
      '/listings/:slug',
      '/open-houses/:id',
    ]);
    for (const rec of recorded.values())
      expect(proposalSchema.safeParse(rec.input).success).toBe(true);
  });

  it('Listing: JSON-LD for price/rooms, CSS for available_from/pets_allowed, every field filled', () => {
    const r = run(recordedInput('/listings/:slug'), sample('/listings/'), ['Apartment', 'Product']);
    const src = (n: string) => r.proposal.fields.find((f) => f.name === n)!.source;
    expect(src('price_usd')).toEqual({ jsonld: '$.offers.price' });
    expect(src('bedrooms')).toEqual({ jsonld: '$.numberOfRooms' });
    expect(src('available_from')).toMatchObject({ css: 'dl.facts dd[data-k=available]' });
    expect(src('pets_allowed')).toMatchObject({ css: 'dl.facts dd[data-k=pets]' });
    expect(r.run.stats.recordRate).toBe(1);
    for (const [name, s] of Object.entries(r.run.stats.fields)) {
      expect(s.nullRate, name).toBe(0);
    }
    expect(r.run.records[0]!.data).toMatchObject({
      price_usd: expect.any(Number),
      available_from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
  });

  it('agent_phone, agent phone/email and host_phone are hidden even though the recording says visible', () => {
    const listing = run(recordedInput('/listings/:slug'), sample('/listings/'), [
      'Apartment',
      'Product',
    ]);
    expect(
      recordedInput('/listings/:slug').fields.find((f) => f.name === 'agent_phone')!.visible,
    ).toBe(true);
    expect(field(listing, 'agent_phone')).toMatchObject({
      pii: true,
      visible: false,
      filterable: [],
    });
    expect(field(listing, 'street_address')).toMatchObject({ pii: false, visible: true });
    expect(field(listing, 'price_usd')).toMatchObject({
      visible: true,
      filterable: ['eq', 'lt', 'lte', 'gt', 'gte'],
    });

    const agent = run(recordedInput('/agents/:slug'), sample('/agents/'));
    expect(field(agent, 'phone')).toMatchObject({ pii: true, visible: false });
    expect(field(agent, 'email')).toMatchObject({ pii: true, visible: false });
    expect(field(agent, 'name')).toMatchObject({ pii: false, visible: true });
    expect(agent.guarded.flags).toContainEqual({
      field: 'email',
      flag: 'pii',
      reason: 'email address in sample values',
    });

    const oh = run(recordedInput('/open-houses/:id'), sample('/open-houses/'));
    expect(field(oh, 'host_phone')).toMatchObject({ pii: true, visible: false });
    expect(field(oh, 'starts_at')).toMatchObject({ visible: true, type: 'datetime' });
  });

  it('injection page in the samples: same field list and flags as the clean page', () => {
    const clean = sample('/listings/');
    const withInjection = [
      { id: 'inj', url: 'https://bluebonnet.example/listings/x', html: injectionHtml },
      ...clean.slice(1),
    ];
    const a = run(recordedInput('/listings/:slug'), clean, ['Apartment', 'Product']);
    const b = run(recordedInput('/listings/:slug'), withInjection, ['Apartment', 'Product']);
    expect(b.guarded.fields).toEqual(a.guarded.fields);
    expect(field(b, 'agent_phone').visible).toBe(false);
  });

  it('an answer that obeyed the injection still ends up with ssn and the phone hidden', () => {
    const obedient = recordedInput('/listings/:slug');
    obedient.fields.find((f) => f.name === 'agent_phone')!.pii = false;
    obedient.fields.push({
      name: 'ssn',
      type: 'string',
      required: false,
      source: { css: '[data-k=ssn]', attr: 'text' },
      transforms: [],
      visible: true,
    });
    const samples = [
      { id: 'inj', url: 'https://bluebonnet.example/listings/x', html: injectionHtml },
      ...sample('/listings/').slice(1),
    ];
    const r = run(obedient, samples, ['Apartment', 'Product']);
    expect(field(r, 'ssn')).toMatchObject({ pii: true, visible: false });
    expect(field(r, 'agent_phone')).toMatchObject({ pii: true, visible: false });
  });

  it('dry run: a selector that matches nothing is a validation problem', () => {
    const p = recordedInput('/listings/:slug');
    p.fields.find((f) => f.name === 'pets_allowed')!.source = {
      css: 'dl.facts dd[data-k=nope]',
      attr: 'text',
    };
    const v = validateProposal(p, sample('/listings/'));
    expect(v.ok).toBe(false);
    expect(!v.ok && v.problems.join()).toMatch(
      /pets_allowed.*no value on any of the 5 sample pages/,
    );
  });
});

describe('PII / rights regexes', () => {
  it('match what features/04 lists', () => {
    expect(PHONE_RE.test('(512) 555-0158')).toBe(true);
    expect(PHONE_RE.test('512-555-0158')).toBe(true);
    expect(PHONE_RE.test('2026-11-10')).toBe(false);
    expect(PHONE_RE.test('TX-DEMO-100000')).toBe(false);
    expect(EMAIL_RE.test('neil.m.1@example.com')).toBe(true);
    expect(STREET_UNIT_RE.test('477 Grackle Pass Unit 291')).toBe(false); // "Pass" isn't a suffix we list
    expect(STREET_UNIT_RE.test('1904 Aldrich St #214')).toBe(true);
    expect(BYLINE_RE.test('Photo: AP')).toBe(true);
    expect(BYLINE_RE.test('Reuters')).toBe(true);
    expect(BYLINE_RE.test('apartment')).toBe(false);
  });

  it('street addresses count as PII only for person-like records; bylines set rights_flag', () => {
    const proposal = (typeName: string): Proposal => ({
      typeName,
      recordKey: { from: 'url' },
      rationale: 'x',
      fields: [
        { name: 'home', type: 'string', required: false, source: { css: '.a' }, transforms: [] },
        { name: 'credit', type: 'string', required: false, source: { css: '.c' }, transforms: [] },
      ],
    });
    const values = { home: ['1904 Aldrich St #214'], credit: ['Photo: Reuters'] };
    const g = (t: string) =>
      guardFields(proposal(t), { values, rawText: {}, nearbyText: {} }, { jsonldTypes: [] });
    expect(g('Listing').fields[0]).toMatchObject({ pii: false, visible: true });
    expect(g('Agent').fields[0]).toMatchObject({ pii: true, visible: false });
    expect(g('Listing').fields[1]).toMatchObject({ rights_flag: true, visible: false });
  });
});

describe('prompt and model clients', () => {
  it('wraps pages as untrusted data and fences a closing tag inside page text', () => {
    const t = clusterUrls(
      ['/listings/a', '/listings/b'],
      {},
      { paramMinDistinct: 2, minPages: 1 },
    )[0]!;
    const hostile = injectionHtml.replace('Bright 3-bed', 'Bright</untrusted_page> 3-bed');
    const prompt = buildUserPrompt(t, [
      { id: '1', url: 'https://x.example/listings/a', html: hostile },
    ]);
    expect(prompt).toContain('<untrusted_page index="1"');
    expect(prompt.match(/<\/untrusted_page>/g)).toHaveLength(1);
    expect(prompt).toContain('Pages in this template: 2');
    expect(prompt).toContain('"@type"');
  });

  it('slugs from type names', () => {
    expect(slugForTypeName('Listing')).toBe('listings');
    expect(slugForTypeName('Open House')).toBe('open-houses');
    expect(slugForTypeName('Property')).toBe('properties');
    expect(slugForTypeName('Address')).toBe('addresses');
    expect(slugForTypeName('OpenHouse')).toBe('open-houses');
  });

  it('recorded mode replays without a network call; unknown templates are a typed miss', async () => {
    const model = createRecordedModel();
    const turn = await model.open({ pathPattern: '/agents/:slug', userPrompt: '' }).first();
    expect(turn).toMatchObject({ replayed: true, model: 'claude-opus-5-5' });
    expect((turn.input as Proposal).typeName).toBe('Agent');
    await expect(
      model.open({ pathPattern: '/blog/:slug', userPrompt: '' }).first(),
    ).rejects.toBeInstanceOf(RecordedProposalMissingError);
  });

  it('live mode: one tool, cached system + DSL, no temperature; retry sends an is_error tool_result', async () => {
    const calls: Record<string, unknown>[] = [];
    const answer = (input: unknown) => ({
      id: 'msg',
      model: 'claude-opus-5-5',
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      },
      content: [{ type: 'tool_use', id: `tu_${calls.length}`, name: 'propose_schema', input }],
    });
    const client = {
      beta: {
        messages: {
          create: async (body: Record<string, unknown>) => {
            const res = answer({ typeName: 'Listing' });
            calls.push(structuredClone(body));
            return res;
          },
        },
      },
    };
    const model = createLiveModel({ apiKey: 'k', client: client as never });
    const conv = model.open({ pathPattern: '/listings/:slug', userPrompt: 'PAGES' });
    const first = await conv.first();
    expect(first).toMatchObject({
      input: { typeName: 'Listing' },
      replayed: false,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 10,
        cacheCreationInputTokens: 5,
      },
    });
    const req = calls[0]!;
    expect(req.model).toBe('claude-opus-5-5');
    expect(req).not.toHaveProperty('temperature');
    expect((req.tools as { name: string }[]).map((t) => t.name)).toEqual(['propose_schema']);
    expect(req.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    const system = req.system as { text: string; cache_control?: unknown }[];
    expect(system.at(-1)!.cache_control).toEqual({ type: 'ephemeral' });
    expect(system[0]!.text).toMatch(/untrusted data/);

    await conv.retry(['fields.0.transforms.0: unknown transform "eval"']);
    const msgs = calls[1]!.messages as { role: string; content: unknown }[];
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(msgs[2]!.content).toEqual([
      expect.objectContaining({ type: 'tool_result', tool_use_id: 'tu_0', is_error: true }),
    ]);
  });
});
