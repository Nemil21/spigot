// SP-052b re-inference, recorded mode, on real SP-004a listing pages rendered in both layouts
// (no DB): the recorded v2 Listing re-proposal, pinned to the approved v1 schema, extracts the
// same records from the redesigned pages that v1 extracted from the original ones.
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAccessLog } from '../../../demo-site/src/accessLog.js';
import { createApp } from '../../../demo-site/src/app.js';
import { createStore } from '../../../demo-site/src/data/store.js';
import { createRecordedModel, loadRecorded, recordedKey } from './claude.js';
import type { SamplePage } from './dryrun.js';
import { guardFields } from './pii.js';
import { validateProposal } from './propose.js';
import { buildReinferPrompt, describeOldSchema, pinToSchema, type OldSchema } from './reinfer.js';
import { selfCheck } from './selfcheck.js';
import { proposalSchema, type Proposal } from './tool.js';

const LISTING = '/listings/:slug';
const recorded = loadRecorded();
const v1Answer = () => structuredClone(recorded.get(LISTING)!.input) as Proposal;
const v2Answer = () =>
  proposalSchema.parse(structuredClone(recorded.get(recordedKey(LISTING, 'reinfer'))!.input));

const store = createStore(0.05);
const log = () => createAccessLog(() => {});
const apps = {
  v1: createApp({ store, accessLog: log() }),
  v2: createApp({ store, accessLog: log(), layout: 'v2', layoutSince: new Date() }),
};
const slugs = store.listings.slice(0, 20).map((l) => l.slug);
const pages: Record<'v1' | 'v2', SamplePage[]> = { v1: [], v2: [] };

/** The approved v1 schema, as SP-012a/b would have stored it (agent_phone hidden by the guard). */
function approvedV1(): OldSchema {
  const v = validateProposal(v1Answer(), pages.v1.slice(0, 5));
  if (!v.ok) throw new Error(v.problems.join('; '));
  return {
    schemaVersionId: 'sv-1',
    version: 1,
    typeName: 'Listing',
    spec: v.run.spec,
    fields: guardFields(v.proposal, v.run, { jsonldTypes: ['Apartment', 'Product'] }).fields,
  };
}

beforeAll(async () => {
  for (const layout of ['v1', 'v2'] as const) {
    for (const slug of slugs) {
      const res = await request(apps[layout])
        .get(`/listings/${slug}`)
        .set('Host', 'bluebonnet.test')
        .expect(200);
      pages[layout].push({
        id: `${layout}-${slug}`,
        url: `https://bluebonnet.test/listings/${slug}`,
        html: res.text,
      });
    }
  }
});

describe('the v1 extractor on the v2 layout (why re-inference exists)', () => {
  it('loses the CSS fields', () => {
    const old = approvedV1();
    const v = validateProposal({ ...v1Answer(), fields: v1Answer().fields }, pages.v2.slice(0, 5));
    expect(v.ok).toBe(false);
    expect(v.ok ? [] : v.run?.emptyFields).toEqual(
      expect.arrayContaining(['available_from', 'pets_allowed', 'agent_name']),
    );
    expect(old.fields.map((f) => f.name)).toContain('available_from');
  });
});

describe('recorded v2 Listing re-proposal (golden)', () => {
  it('keeps every field name, type and the record key; every field fills on v2 pages', () => {
    const old = approvedV1();
    const { proposal, notes } = pinToSchema(v2Answer(), old);
    expect(notes).toEqual([]);
    expect(proposal.typeName).toBe('Listing');
    expect(proposal.recordKey).toEqual(old.spec.recordKey);
    expect(proposal.fields.map((f) => [f.name, f.type, f.required])).toEqual(
      old.spec.fields.map((f) => [f.name, f.type, f.required]),
    );
    const v = validateProposal(proposal, pages.v2);
    if (!v.ok) throw new Error(v.problems.join('; '));
    for (const [name, s] of Object.entries(v.run.stats.fields)) expect(s.nullRate, name).toBe(0);
  });

  it('extracts the same records from v2 that v1 extracted from v1 (no renames, no value drift)', () => {
    const old = approvedV1();
    const v1 = validateProposal(v1Answer(), pages.v1);
    const v2 = validateProposal(pinToSchema(v2Answer(), old).proposal, pages.v2);
    if (!v1.ok || !v2.ok) throw new Error('invalid');
    expect(v2.run.records.map((r) => r && { key: r.key, data: r.data })).toEqual(
      v1.run.records.map((r) => r && { key: r.key, data: r.data }),
    );
  });

  it('keeps the owner’s choices: hidden PII stays hidden, filters stay', async () => {
    const old = approvedV1();
    const { proposal } = pinToSchema(v2Answer(), old);
    const v = validateProposal(proposal, pages.v2.slice(0, 5));
    if (!v.ok) throw new Error('invalid');
    const checked = await selfCheck(
      {
        proposal,
        spec: v.run.spec,
        fields: guardFields(proposal, v.run, { jsonldTypes: [] }).fields,
        sampleStats: v.run.stats,
        flags: [],
        notes: [],
      },
      {
        pathPattern: LISTING,
        pageIds: pages.v2.map((p) => p.id),
        samples: pages.v2.slice(0, 5),
        jsonldTypes: ['Apartment', 'Product'],
        loadPages: async (ids) => pages.v2.filter((p) => ids.includes(p.id)),
        model: createRecordedModel(),
        recordModelCall: async () => {},
      },
    );
    const byName = new Map(checked.fields.map((f) => [f.name, f]));
    expect([...byName.keys()]).toEqual(old.fields.map((f) => f.name));
    expect(byName.get('agent_phone')).toMatchObject({ visible: false, pii: true });
    for (const f of old.fields) {
      expect(byName.get(f.name)!.filterable, f.name).toEqual(f.filterable);
    }
    expect(checked.sampleStats).toMatchObject({ sampled: 20, dropped: [], repairRounds: 0 });
  });
});

describe('pinToSchema', () => {
  it('drops renamed / extra fields, keeps old sources for missing ones, never changes a type', () => {
    const old = approvedV1();
    const answer = v2Answer();
    answer.typeName = 'Rental';
    answer.recordKey = { jsonld: '$.sku' };
    answer.fields = answer.fields
      .filter((f) => f.name !== 'pets_allowed')
      .map((f) => (f.name === 'price_usd' ? { ...f, name: 'rent_usd' } : f))
      .map((f) => (f.name === 'bedrooms' ? { ...f, type: 'string' as const } : f));
    const { proposal, notes } = pinToSchema(answer, old);
    expect(proposal.typeName).toBe('Listing');
    expect(proposal.recordKey).toEqual({ from: 'url' });
    expect(proposal.fields.map((f) => f.name)).toEqual(old.spec.fields.map((f) => f.name));
    const f = (n: string) => proposal.fields.find((x) => x.name === n)!;
    expect(f('bedrooms').type).toBe('integer');
    expect(f('pets_allowed').source).toEqual(
      old.spec.fields.find((x) => x.name === 'pets_allowed')!.source,
    );
    expect(f('price_usd').source).toEqual({ jsonld: '$.offers.price' });
    expect(notes).toEqual(
      expect.arrayContaining([
        '"price_usd" missing from the answer: kept its old source',
        '"pets_allowed" missing from the answer: kept its old source',
        '"bedrooms" kept type integer (answer said string)',
        'dropped fields not in the approved schema: rent_usd',
        'kept type name Listing (answer said Rental)',
      ]),
    );
  });

  it('a field the owner chose to show is not re-hidden on its old flag alone', () => {
    const old = approvedV1();
    old.fields = old.fields.map((f) =>
      f.name === 'agent_phone' ? { ...f, visible: true, filterable: [] } : f,
    );
    const pinned = pinToSchema(v2Answer(), old).proposal.fields.find(
      (f) => f.name === 'agent_phone',
    )!;
    expect(pinned.visible).toBe(true);
    expect(pinned.pii).toBeUndefined();
    // … but the guard still sees the phone numbers in the new values and hides it.
    const v = validateProposal(pinToSchema(v2Answer(), old).proposal, pages.v2.slice(0, 5));
    if (!v.ok) throw new Error('invalid');
    const guarded = guardFields(v.proposal, v.run, { jsonldTypes: [] });
    expect(guarded.fields.find((f) => f.name === 'agent_phone')).toMatchObject({ visible: false });
  });
});

describe('re-inference prompt', () => {
  it('carries the approved schema and asks for the same names; pages stay fenced', () => {
    const old = approvedV1();
    const prompt = buildReinferPrompt(
      { pathPattern: LISTING, urlPattern: '^/listings/[^/]+$', pageCount: 117, jsonldTypes: [] },
      old,
      pages.v2.slice(0, 3),
    );
    for (const f of old.spec.fields) expect(prompt).toContain(`- ${f.name}: ${f.type}`);
    expect(prompt).toContain('EVERY field with exactly the same name and type');
    expect(prompt).toContain('dl.facts dd[data-k=available]');
    expect(prompt.match(/<untrusted_page index=/g)).toHaveLength(3);
    expect(describeOldSchema(old)).toContain('typeName: Listing');
  });

  it('recorded mode keys the re-proposal apart from the first proposal', async () => {
    const model = createRecordedModel();
    const first = await model.open({ pathPattern: LISTING, userPrompt: '' }).first();
    const again = await model
      .open({ pathPattern: LISTING, userPrompt: '', variant: 'reinfer' })
      .first();
    expect(JSON.stringify(first.input)).toContain('dl.facts');
    expect(JSON.stringify(again.input)).toContain('dl.specs');
  });
});
