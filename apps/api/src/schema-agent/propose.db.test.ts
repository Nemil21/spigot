import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { compileExtractor } from '@spigot/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { crawlKeyHash, deriveCrawlKey } from '../crawl/crawlKey.js';
import { crawlSite } from '../crawl/crawlSite.js';
import { clearCrawlHooks } from '../crawl/hooks.js';
import { resetHostQueues } from '../crawl/queue.js';
import { createDb, type Db } from '../db/index.js';
import { testDatabaseUrl, twoPools, type TwoPools } from '../db/test-db.js';
import { re2Engine } from '../extract/adapters.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';
import { demoSite, type DemoPage } from '../test/schema-agent/demoPages.js';
import {
  createRecordedModel,
  loadRecorded,
  ZERO_USAGE,
  type ModelTurn,
  type SchemaModel,
} from './claude.js';
import { ALL_REJECTED_MESSAGE, EMPTY_STATE_MESSAGE, proposeForSite } from './propose.js';
import resumeJob, { findResumableSites, resumeProposals } from './resume.job.js';
import { startSchemaAgent } from './runtime.js';
import type { Proposal } from './tool.js';

const injectionHtml = readFileSync(
  new URL('./__fixtures__/injection-listing.html', import.meta.url),
  'utf8',
);
const recorded = loadRecorded();
const recordedInput = (p: string) => structuredClone(recorded.get(p)!.input) as Proposal;
const SECRET = 'schema-agent-test-secret-'.padEnd(40, 'x');
const silent = { info: () => {}, error: () => {} };

type Answer = unknown | Error;
/**
 * A model that answers from a script per template (attempt 0 = first, 1 = retry), defaulting to
 * the recorded proposal, and counts its calls.
 */
function scriptedModel(
  script: Record<string, (attempt: number) => Answer> = {},
  delayMs = 0,
): SchemaModel & { calls: number } {
  const m = {
    mode: 'live' as const,
    modelId: 'test-model',
    calls: 0,
    open(req: { pathPattern: string }) {
      let attempt = 0;
      const turn = async (): Promise<ModelTurn> => {
        m.calls++;
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        const fn = script[req.pathPattern];
        const a = fn ? fn(attempt++) : recordedInput(req.pathPattern);
        if (a instanceof Error) throw a;
        return {
          input: a,
          usage: { ...ZERO_USAGE, inputTokens: 1000, outputTokens: 200 },
          model: 'test-model',
          replayed: false,
          stopReason: 'tool_use',
        };
      };
      return { first: turn, retry: turn };
    },
  };
  return m;
}

describe.skipIf(!testDatabaseUrl)('schema agent: propose / persist / resume', () => {
  let pools: TwoPools;
  let db: Db;
  let db2: Db;
  let full: DemoPage[];
  /** A small but cluster-complete slice of the real site: 25 listings, 25 agents, 25 open houses + blog/about. */
  let small: DemoPage[];

  beforeAll(async () => {
    pools = await twoPools();
    db = createDb(pools.a);
    db2 = createDb(pools.b);
    full = (await demoSite(1)).pages;
    const take = (prefix: string, n: number) =>
      full.filter((p) => p.path.startsWith(prefix)).slice(0, n);
    small = [
      ...take('/listings/', 25),
      ...take('/agents/', 25),
      ...take('/open-houses/', 25),
      ...take('/blog', 20),
      ...full.filter((p) => ['/', '/about', '/search'].includes(p.path)),
    ];
  }, 120_000);
  afterAll(async () => {
    clearCrawlHooks();
    await pools?.close();
  });

  async function seedSite(pages: DemoPage[], status = 'PROPOSING') {
    const origin = `https://site-${randomUUID().slice(0, 8)}.example`;
    const pub = await pools.a.query<{ id: string }>(
      `INSERT INTO publishers (name, email, payout_email) VALUES ('P', $1, 'p@x.test') RETURNING id`,
      [`p-${randomUUID()}@x.test`],
    );
    const site = await pools.a.query<{ id: string }>(
      `INSERT INTO sites (publisher_id, origin, verify_token, crawl_key_hash, gate_key_hash, status)
       VALUES ($1, $2, 'v', 'c', 'g', $3) RETURNING id`,
      [pub.rows[0]!.id, origin, status],
    );
    const siteId = site.rows[0]!.id;
    const run = await pools.a.query<{ id: string }>(
      `INSERT INTO crawl_runs (site_id, trigger, status, started_at, finished_at)
       VALUES ($1, 'CONNECT', 'SUCCEEDED', now(), now()) RETURNING id`,
      [siteId],
    );
    for (let i = 0; i < pages.length; i += 500) {
      const batch = pages.slice(i, i + 500);
      await pools.a.query(
        `WITH p AS (
           INSERT INTO pages (site_id, url, last_status, fetched_at)
           SELECT $1, u.url, 200, now() FROM unnest($2::text[]) AS u(url)
           RETURNING id, url)
         INSERT INTO snapshots (page_id, http_status, html_gz, bytes)
         SELECT p.id, 200, h.gz, length(h.gz) FROM p
           JOIN unnest($2::text[], $3::bytea[]) AS h(url, gz) ON h.url = p.url`,
        [siteId, batch.map((p) => origin + p.path), batch.map((p) => gzipSync(p.html))],
      );
    }
    return { siteId, runId: run.rows[0]!.id, publisherId: pub.rows[0]!.id, origin };
  }

  const one = async <T>(sql: string, params: unknown[]) =>
    (await pools.a.query(sql, params)).rows[0] as T;
  const siteStatus = (id: string) =>
    one<{ status: string }>('SELECT status FROM sites WHERE id = $1', [id]).then((r) => r.status);
  const aiCalls = (runId: string) =>
    one<{ ai_calls: number }>('SELECT ai_calls FROM crawl_runs WHERE id = $1', [runId]).then(
      (r) => r.ai_calls,
    );
  const datasets = async (siteId: string) =>
    (
      await pools.a.query<{
        id: string;
        type_name: string;
        slug: string;
        record_count: number;
        status: string;
        template_id: string;
      }>(
        'SELECT id, type_name, slug, record_count, status, template_id FROM datasets WHERE site_id = $1 ORDER BY record_count DESC',
        [siteId],
      )
    ).rows;
  const doneAudit = (siteId: string) =>
    one<{ data: Record<string, unknown> }>(
      `SELECT data FROM audit_events WHERE entity = 'sites' AND entity_id = $1 AND action = 'SCHEMA_PROPOSAL_DONE'
        ORDER BY id DESC LIMIT 1`,
      [siteId],
    ).then((r) => r?.data);

  // ---------------------------------------------------------------------------------------------
  it('golden (recorded, real SP-004a pages at full scale): Listing 2,341 · Agent 88 · Open House 40, /blog skipped', async () => {
    const { siteId, runId, publisherId } = await seedSite(full);
    const listener = await pools.b.connect();
    const events: { type: string; publisherId: string; ids: string[] }[] = [];
    await listener.query('LISTEN publisher_events');
    listener.on('notification', (n) => events.push(JSON.parse(n.payload!)));

    const t0 = Date.now();
    const result = await proposeForSite({ db, model: createRecordedModel() }, siteId, {
      trigger: 'DISCOVERY',
      runId,
    });
    const elapsed = Date.now() - t0;
    await new Promise((r) => setTimeout(r, 50));
    listener.release();

    expect(elapsed).toBeLessThan(90_000);
    expect(result).toMatchObject({ status: 'done', proposals: 3, aiCalls: 3, siteStatus: 'READY' });
    expect(result.templates.map((t) => [t.pathPattern, t.pageCount, t.status])).toEqual([
      ['/listings/:slug', 2341, 'proposed'],
      ['/agents/:slug', 88, 'proposed'],
      ['/open-houses/:id', 40, 'proposed'],
    ]);
    expect(await siteStatus(siteId)).toBe('READY');
    // The discovery run's AI-calls column equals the model calls made.
    expect(await aiCalls(runId)).toBe(3);

    const ds = await datasets(siteId);
    expect(ds.map((d) => [d.type_name, d.slug, d.record_count, d.status])).toEqual([
      ['Listing', 'listings', 2341, 'PROPOSED'],
      ['Agent', 'agents', 88, 'PROPOSED'],
      ['Open House', 'open-houses', 40, 'PROPOSED'],
    ]);
    const templates = await pools.a.query<{ url_pattern: string }>(
      'SELECT url_pattern FROM templates WHERE site_id = $1',
      [siteId],
    );
    expect(templates.rows.some((t) => t.url_pattern.includes('blog'))).toBe(false);
    const assigned = await one<{ n: number }>(
      'SELECT count(*)::int AS n FROM pages WHERE site_id = $1 AND template_id IS NOT NULL',
      [siteId],
    );
    expect(assigned.n).toBe(2341 + 88 + 40);

    // schema_versions v1: PROPOSED, AI, model, rationale, guarded fields, stats.
    const sv = (
      await pools.a.query(
        `SELECT d.type_name, v.* FROM schema_versions v JOIN datasets d ON d.id = v.dataset_id
            WHERE d.site_id = $1`,
        [siteId],
      )
    ).rows;
    expect(sv).toHaveLength(3);
    for (const v of sv) {
      expect(v).toMatchObject({
        version: 1,
        status: 'PROPOSED',
        proposed_by: 'AI',
        ai_model: 'claude-opus-5-5',
      });
      expect(v.ai_rationale.length).toBeGreaterThan(20);
      expect(v.record_key).toEqual({ from: 'url' });
      expect(v.sample_stats).toMatchObject({ source: 'samples', sampled: 5, recordRate: 1 });
    }
    const fieldsOf = (t: string) =>
      new Map(
        (
          sv.find((v) => v.type_name === t)!.fields as {
            name: string;
            visible: boolean;
            pii: boolean;
          }[]
        ).map((f) => [f.name, f]),
      );
    expect(fieldsOf('Listing').get('agent_phone')).toMatchObject({ visible: false, pii: true });
    expect(fieldsOf('Agent').get('phone')).toMatchObject({ visible: false, pii: true });
    expect(fieldsOf('Agent').get('email')).toMatchObject({ visible: false, pii: true });
    expect(fieldsOf('Open House').get('host_phone')).toMatchObject({ visible: false, pii: true });
    expect(fieldsOf('Listing').get('price_usd')).toMatchObject({
      visible: true,
      filterable: ['eq', 'lt', 'lte', 'gt', 'gte'],
    });
    // Hidden fields' sample values stay out of sample_stats.
    expect(sv.find((v) => v.type_name === 'Agent')!.sample_stats.fields.email).not.toHaveProperty(
      'example',
    );

    // Golden: the stored extractor over every page of each template → counts, required nulls ≤ 2%.
    for (const d of ds) {
      const v = sv.find((x) => x.dataset_id === d.id)!;
      const ex = compileExtractor(v.extractor, { regex: re2Engine });
      const rows = await pools.a.query<{ url: string; html_gz: Buffer }>(
        `SELECT p.url, s.html_gz FROM pages p JOIN snapshots s ON s.page_id = p.id WHERE p.template_id = $1`,
        [d.template_id],
      );
      const { gunzipSync } = await import('node:zlib');
      const recs = rows.rows.map((r) => ex.extract(gunzipSync(r.html_gz).toString('utf8'), r.url));
      expect(recs.filter(Boolean).length, d.type_name).toBe(d.record_count);
      for (const f of ex.spec.fields.filter((x) => x.required)) {
        const nulls = recs.filter((r) => r!.data[f.name] === null).length;
        expect(nulls / recs.length, `${d.type_name}.${f.name}`).toBeLessThanOrEqual(0.02);
      }
    }

    // Audit: one SCHEMA_PROPOSED per dataset, labelled replayed, with token counts.
    const audits = (
      await pools.a.query(
        `SELECT * FROM audit_events WHERE publisher_id = $1 AND action = 'SCHEMA_PROPOSED' ORDER BY id`,
        [publisherId],
      )
    ).rows;
    expect(audits).toHaveLength(3);
    for (const a of audits) {
      expect(a).toMatchObject({ actor_type: 'SCHEMA_AGENT', entity: 'datasets' });
      expect(a.data).toMatchObject({
        label: 'replayed proposal',
        replayed: true,
        modelCalls: 1,
        runId,
      });
      expect(a.data.tokens).toEqual(ZERO_USAGE);
    }
    expect(await doneAudit(siteId)).toMatchObject({ proposals: 3, aiCalls: 3, siteReady: true });

    // proposal.ready: one per dataset, ids only, after commit.
    const ready = events.filter(
      (e) => e.type === 'proposal.ready' && e.publisherId === publisherId,
    );
    expect(ready.map((e) => e.ids[0]).sort()).toEqual(ds.map((d) => d.id).sort());

    // Recorded mode is deterministic: a second site gets identical proposals (its sample pages
    // differ, since samples are seeded by page id, so sample_stats may differ).
    const again = await seedSite(full);
    await proposeForSite({ db, model: createRecordedModel() }, again.siteId, {
      trigger: 'DISCOVERY',
      runId: again.runId,
    });
    const sv2 = (
      await pools.a.query(
        `SELECT d.type_name, v.fields, v.extractor, v.record_key, v.ai_model FROM schema_versions v JOIN datasets d ON d.id = v.dataset_id
            WHERE d.site_id = $1 ORDER BY d.type_name`,
        [again.siteId],
      )
    ).rows;
    const pick = (rows: typeof sv) =>
      rows
        .map(({ type_name, fields, extractor, record_key, ai_model }) => ({
          type_name,
          fields,
          extractor,
          record_key,
          ai_model,
        }))
        .sort((a, b) => a.type_name.localeCompare(b.type_name));
    expect(sv2).toEqual(pick(sv));
  }, 180_000);

  // ---------------------------------------------------------------------------------------------
  it('an unknown transform is retried once with the errors, and never stored if still invalid', async () => {
    const badListing = () => {
      const p = recordedInput('/listings/:slug');
      p.fields[1]!.transforms = ['toInt', 'exec'];
      return p;
    };
    const { siteId, runId } = await seedSite(small);
    const model = scriptedModel({ '/listings/:slug': () => badListing() });
    const r = await proposeForSite({ db, model }, siteId, { trigger: 'DISCOVERY', runId });

    const listing = r.templates.find((t) => t.pathPattern === '/listings/:slug')!;
    expect(listing).toMatchObject({ status: 'rejected', modelCalls: 2 });
    expect(listing.reason).toMatch(/unknown transform "exec"/);
    expect((await datasets(siteId)).map((d) => d.type_name).sort()).toEqual([
      'Agent',
      'Open House',
    ]);
    expect(model.calls).toBe(4);
    expect(await aiCalls(runId)).toBe(4);
    expect(await siteStatus(siteId)).toBe('READY');

    // Bad first answer, good retry → stored with a note.
    const s2 = await seedSite(small);
    const m2 = scriptedModel({
      '/listings/:slug': (n) => (n === 0 ? badListing() : recordedInput('/listings/:slug')),
    });
    const r2 = await proposeForSite({ db, model: m2 }, s2.siteId, {
      trigger: 'DISCOVERY',
      runId: s2.runId,
    });
    expect(r2.templates.find((t) => t.pathPattern === '/listings/:slug')).toMatchObject({
      status: 'proposed',
      modelCalls: 2,
    });
    expect(await aiCalls(s2.runId)).toBe(4);
    const audit = await one<{ data: { notes: string[]; modelCalls: number } }>(
      `SELECT a.data FROM audit_events a JOIN datasets d ON d.id = a.entity_id
        WHERE d.site_id = $1 AND d.type_name = 'Listing' AND a.action = 'SCHEMA_PROPOSED'`,
      [s2.siteId],
    );
    expect(audit.data.modelCalls).toBe(2);
    expect(audit.data.notes[0]).toMatch(/^retried after: .*exec/);

    // Every template invalid → nothing stored, site READY with the failure message.
    const s3 = await seedSite(small);
    const m3 = scriptedModel({
      '/listings/:slug': () => ({ typeName: 'Listing' }),
      '/agents/:slug': () => ({ typeName: 'Agent' }),
      '/open-houses/:id': () => undefined, // no propose_schema call at all
    });
    const r3 = await proposeForSite({ db, model: m3 }, s3.siteId, {
      trigger: 'DISCOVERY',
      runId: s3.runId,
    });
    expect(r3).toMatchObject({ proposals: 0, aiCalls: 6, siteStatus: 'READY' });
    expect(await datasets(s3.siteId)).toEqual([]);
    expect(await doneAudit(s3.siteId)).toMatchObject({
      proposals: 0,
      message: ALL_REJECTED_MESSAGE,
    });
  });

  it('a field that matches nothing after the retry is dropped with a note, not the whole type', async () => {
    const { siteId, runId } = await seedSite(small);
    const withGhost = () => {
      const p = recordedInput('/agents/:slug');
      p.fields.push({
        name: 'ssn',
        type: 'string',
        required: false,
        source: { css: '.ssn' },
        transforms: [],
      });
      return p;
    };
    const model = scriptedModel({ '/agents/:slug': withGhost });
    await proposeForSite({ db, model }, siteId, { trigger: 'DISCOVERY', runId });
    const sv = await one<{ fields: { name: string }[] }>(
      `SELECT v.fields FROM schema_versions v JOIN datasets d ON d.id = v.dataset_id WHERE d.site_id = $1 AND d.type_name = 'Agent'`,
      [siteId],
    );
    expect(sv.fields.map((f) => f.name)).not.toContain('ssn');
    expect(sv.fields).toHaveLength(recordedInput('/agents/:slug').fields.length);
  });

  it('injection page in the listing samples (recorded mode): same field list as the clean site', async () => {
    const clean = await seedSite(small);
    const injected = await seedSite(
      small.map((p) => (p.path.startsWith('/listings/') ? { ...p, html: injectionHtml } : p)),
    );
    for (const s of [clean, injected]) {
      await proposeForSite({ db, model: createRecordedModel() }, s.siteId, {
        trigger: 'DISCOVERY',
        runId: s.runId,
      });
    }
    const fields = async (siteId: string) =>
      (
        await one<{ fields: unknown }>(
          `SELECT v.fields FROM schema_versions v JOIN datasets d ON d.id = v.dataset_id WHERE d.site_id = $1 AND d.type_name = 'Listing'`,
          [siteId],
        )
      ).fields as { name: string; visible: boolean }[];
    const a = await fields(clean.siteId);
    const b = await fields(injected.siteId);
    expect(b).toEqual(a);
    expect(b.map((f) => f.name)).not.toContain('ssn');
    expect(b.find((f) => f.name === 'agent_phone')!.visible).toBe(false);
  });

  // ---------------------------------------------------------------------------------------------
  it('killed after the crawl, before proposal: the resume job proposes on its next tick', async () => {
    const { siteId, runId } = await seedSite(small);
    expect(await findResumableSites(pools.a)).toContain(siteId);
    // The job runs through the runtime the API plugin starts.
    const stop = startSchemaAgent({
      db,
      config: loadConfig({ ...REQUIRED_ENV, SCHEMA_AGENT_MODE: 'recorded' }),
      log: silent,
    });
    try {
      await resumeJob.run();
    } finally {
      stop();
    }
    expect(await siteStatus(siteId)).toBe('READY');
    expect((await datasets(siteId)).map((d) => d.type_name).sort()).toEqual([
      'Agent',
      'Listing',
      'Open House',
    ]);
    // Counted on the site's discovery run even though nobody passed the run id.
    expect(await aiCalls(runId)).toBe(3);
    expect(await findResumableSites(pools.a)).not.toContain(siteId);
  });

  it('a run that died half-way is finished by the resume pass, after the 5-minute quiet window', async () => {
    const { siteId, runId } = await seedSite(small);
    const down = scriptedModel({ '/agents/:slug': () => new Error('overloaded') });
    const r1 = await proposeForSite({ db, model: down }, siteId, { trigger: 'DISCOVERY', runId });
    expect(r1.templates.find((t) => t.pathPattern === '/agents/:slug')).toMatchObject({
      status: 'failed',
    });
    // ≥ 1 proposal → READY (W05 shows the cards it has); the resume job fills the gap later.
    expect(r1).toMatchObject({ proposals: 2, siteStatus: 'READY' });
    expect(await aiCalls(runId)).toBe(3);

    // A site whose model was down for every template stays PROPOSING for the resume job.
    const s2 = await seedSite(small);
    const allDown = scriptedModel({
      '/listings/:slug': () => new Error('down'),
      '/agents/:slug': () => new Error('down'),
      '/open-houses/:id': () => new Error('down'),
    });
    const r2 = await proposeForSite({ db, model: allDown }, s2.siteId, {
      trigger: 'DISCOVERY',
      runId: s2.runId,
    });
    expect(r2).toMatchObject({ proposals: 0, siteStatus: 'PROPOSING' });
    expect(await aiCalls(s2.runId)).toBe(3);
    // Just ran: inside the quiet window, not picked up.
    expect(await findResumableSites(pools.a)).not.toContain(s2.siteId);
    // Pretend the attempt was 6 minutes ago (quiet window 0 = "any earlier attempt is old").
    expect(await findResumableSites(pools.a, 0)).toContain(s2.siteId);
    const model = scriptedModel();
    const results = await resumeProposals({ db, model }, 0);
    expect(results.find((r) => r.siteId === s2.siteId)).toMatchObject({
      proposals: 3,
      siteStatus: 'READY',
    });
    expect(await aiCalls(s2.runId)).toBe(6);
    // The READY site with a failed template was revisited too: only the missing type, one call.
    expect(results.find((r) => r.siteId === siteId)).toMatchObject({ proposals: 3, aiCalls: 1 });
    expect((await datasets(siteId)).map((d) => d.type_name).sort()).toEqual([
      'Agent',
      'Listing',
      'Open House',
    ]);
    expect(await aiCalls(runId)).toBe(4);
    // Nothing failed any more: no further resume.
    expect(await findResumableSites(pools.a, 0)).not.toContain(siteId);
  });

  it('one template throwing (persist error) fails only that template; the run finishes under the lock', async () => {
    const { siteId, runId } = await seedSite(small);
    // A NUL character can't be stored in jsonb: persistProposal throws for Agent only.
    const nul = () => {
      const p = recordedInput('/agents/:slug');
      p.fields[0]!.description = 'name\u0000';
      return p;
    };
    const slow = scriptedModel({ '/agents/:slug': nul }, 30);
    const r = await proposeForSite({ db, model: slow }, siteId, { trigger: 'DISCOVERY', runId });
    expect(r.status).toBe('done');
    expect(r.templates.find((t) => t.pathPattern === '/agents/:slug')).toMatchObject({
      status: 'failed',
      reason: expect.stringMatching(/^error: /),
    });
    // The siblings all finished before the run returned (and released the lock).
    expect(r.proposals).toBe(2);
    expect(slow.calls).toBe(3);
    expect(await aiCalls(runId)).toBe(3);
    expect((await datasets(siteId)).map((d) => d.type_name).sort()).toEqual([
      'Listing',
      'Open House',
    ]);
    expect(await doneAudit(siteId)).toMatchObject({ proposals: 2, siteReady: true });
    // The lock was released: the next run proceeds and fills in Agent.
    const again = await proposeForSite({ db, model: scriptedModel() }, siteId, {
      trigger: 'ADMIN',
    });
    expect(again).toMatchObject({ status: 'done', proposals: 3, aiCalls: 1 });
  });

  it('re-running skips templates that already have a dataset: no second model call', async () => {
    const { siteId, runId } = await seedSite(small);
    await proposeForSite({ db, model: createRecordedModel() }, siteId, {
      trigger: 'DISCOVERY',
      runId,
    });
    const model = scriptedModel();
    const again = await proposeForSite({ db, model }, siteId, { trigger: 'ADMIN' });
    expect(again.templates.map((t) => t.status)).toEqual(['existing', 'existing', 'existing']);
    expect(model.calls).toBe(0);
    expect(await aiCalls(runId)).toBe(3);
    expect(await datasets(siteId)).toHaveLength(3);
    const templates = await one<{ n: number }>(
      'SELECT count(*)::int AS n FROM templates WHERE site_id = $1',
      [siteId],
    );
    expect(templates.n).toBe(3);
  });

  it('two runners at once (two API processes): one runs, one is busy; one dataset per template', async () => {
    const { siteId, runId } = await seedSite(small);
    const ma = scriptedModel({}, 50);
    const mb = scriptedModel({}, 50);
    const [a, b] = await Promise.all([
      proposeForSite({ db, model: ma }, siteId, { trigger: 'DISCOVERY', runId }),
      proposeForSite({ db: db2, model: mb }, siteId, { trigger: 'RESUME' }),
    ]);
    expect([a.status, b.status].sort()).toEqual(['busy', 'done']);
    expect(ma.calls + mb.calls).toBe(3);
    expect(await aiCalls(runId)).toBe(3);
    expect(await datasets(siteId)).toHaveLength(3);
    const started = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events WHERE entity_id = $1 AND action = 'SCHEMA_PROPOSAL_STARTED'`,
      [siteId],
    );
    expect(started.n).toBe(1);
  });

  it('no repeated structure: 0 proposals → READY with the empty-state audit row, no model call', async () => {
    const { siteId, runId } = await seedSite(
      full.filter((p) => !/^\/(listings|agents|open-houses)\//.test(p.path)),
    );
    const model = scriptedModel();
    const r = await proposeForSite({ db, model }, siteId, { trigger: 'DISCOVERY', runId });
    expect(r).toMatchObject({ proposals: 0, aiCalls: 0, siteStatus: 'READY', templates: [] });
    expect(model.calls).toBe(0);
    expect(await siteStatus(siteId)).toBe('READY');
    expect(await doneAudit(siteId)).toMatchObject({
      proposals: 0,
      message: EMPTY_STATE_MESSAGE,
      siteReady: true,
    });
  });

  it('only PROPOSING sites are proposed (ADMIN may also top up a READY one)', async () => {
    const { siteId } = await seedSite(small, 'VERIFIED');
    expect(
      await proposeForSite({ db, model: scriptedModel() }, siteId, { trigger: 'RESUME' }),
    ).toMatchObject({
      status: 'wrong_status',
      siteStatus: 'VERIFIED',
    });
    expect(
      await proposeForSite({ db, model: scriptedModel() }, randomUUID(), { trigger: 'RESUME' }),
    ).toMatchObject({
      status: 'not_found',
    });
  });

  // ---------------------------------------------------------------------------------------------
  it('end to end: discovery crawl of the live demo site → onDiscoveryDone → proposals, ai_calls on that run', async () => {
    clearCrawlHooks();
    resetHostQueues();
    const site = await demoSite(0.05, { keepOpen: true });
    try {
      const pub = await pools.a.query<{ id: string }>(
        `INSERT INTO publishers (name, email, payout_email) VALUES ('P', $1, 'p@x.test') RETURNING id`,
        [`p-${randomUUID()}@x.test`],
      );
      const ins = await pools.a.query<{ id: string }>(
        `INSERT INTO sites (publisher_id, origin, verify_token, crawl_key_hash, gate_key_hash, status)
         VALUES ($1, $2, 'v', 'pending', 'g', 'VERIFIED') RETURNING id`,
        [pub.rows[0]!.id, site.origin],
      );
      const siteId = ins.rows[0]!.id;
      await pools.a.query('UPDATE sites SET crawl_key_hash = $2 WHERE id = $1', [
        siteId,
        crawlKeyHash(deriveCrawlKey(siteId, SECRET)),
      ]);
      const stop = startSchemaAgent({
        db,
        config: loadConfig(REQUIRED_ENV),
        log: silent,
        model: createRecordedModel(),
      });
      let result;
      try {
        result = await crawlSite(
          { siteId, trigger: 'CONNECT' },
          {
            db,
            crawlSecret: SECRET,
            allowLocal: true,
            appBaseUrl: 'http://spigot.test',
            minGapMs: 0,
          },
        );
      } finally {
        stop();
      }
      expect(result).toMatchObject({ status: 'SUCCEEDED', discovery: true });
      // At 5% scale only listings repeat enough (117 pages); agents (4) and open houses (2) drop out.
      expect((await datasets(siteId)).map((d) => [d.type_name, d.record_count])).toEqual([
        ['Listing', 117],
      ]);
      expect(await aiCalls(result.runId)).toBe(1);
      expect(await siteStatus(siteId)).toBe('READY');
    } finally {
      await site.close();
      clearCrawlHooks();
    }
  }, 60_000);

  it('POST /admin/sites/:id/repropose: admins only; runs the proposal', async () => {
    const ADMIN = `admin-${randomUUID()}@example.com`;
    const app = await buildServer(
      loadConfig({
        ...REQUIRED_ENV,
        DATABASE_URL: pools.db.url,
        ADMIN_EMAILS: ADMIN,
        SCHEMA_AGENT_MODE: 'recorded',
        LOG_LEVEL: 'silent',
      }),
    );
    try {
      await app.ready();
      const origin = REQUIRED_ENV.APP_BASE_URL!;
      const signup = async (email: string) => {
        const res = await request(app.server)
          .post('/api/auth/signup')
          .set('Origin', origin)
          .send({ name: 'P', email, password: 'correct horse', payoutEmail: 'p@example.com' });
        expect(res.status).toBe(201);
        return (res.headers['set-cookie'] as unknown as string[])
          .map((c) => c.split(';', 1)[0])
          .join('; ');
      };
      const { siteId, runId } = await seedSite(small);
      const post = (cookie?: string, id = siteId) => {
        const r = request(app.server).post(`/admin/sites/${id}/repropose`).set('Origin', origin);
        return cookie ? r.set('Cookie', cookie) : r;
      };

      expect((await post()).status).toBe(401);
      const user = await signup(`u-${randomUUID()}@example.com`);
      expect((await post(user)).status).toBe(403);
      expect(await aiCalls(runId)).toBe(0);

      const admin = await signup(ADMIN);
      expect((await post(admin, randomUUID())).status).toBe(404);
      const ok = await post(admin);
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ siteId, siteStatus: 'READY', proposals: 3, aiCalls: 3 });
      expect(ok.body.templates.map((t: { typeName: string }) => t.typeName).sort()).toEqual([
        'Agent',
        'Listing',
        'Open House',
      ]);
      // Again: nothing missing, no model call.
      const again = await post(admin);
      expect(again.body).toMatchObject({ proposals: 3, aiCalls: 0 });
    } finally {
      await app.close();
    }
  });
});
