import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, type Db } from '../db/index.js';
import { twoPools, testDatabaseUrl, type TwoPools } from '../db/test-db.js';
import {
  insertSnapshots,
  listings,
  newRun,
  seedDataset,
  upsertListingPages,
} from '../test/extract-fixtures.js';
import { extractTemplate } from './extractTemplate.js';

// Any Anthropic client constructed while this file runs is recorded here.
const anthropicCtor = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/sdk', () => ({ default: anthropicCtor, Anthropic: anthropicCtor }));

const DEMO_LISTINGS = 2341;

describe('extract module: no model call anywhere', () => {
  it('no source file in apps/api/src/extract imports the Anthropic SDK or the schema agent', () => {
    const dir = new URL('.', import.meta.url);
    const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(sources).toEqual(
      expect.arrayContaining([
        'extractPage.ts',
        'extractTemplate.ts',
        'publishWatermark.ts',
        'upsert.ts',
      ]),
    );
    for (const f of sources) {
      const src = readFileSync(new URL(f, dir), 'utf8');
      expect(src, f).not.toMatch(/@anthropic-ai\/sdk|schema-agent|ai_calls/);
    }
  });
});

describe.skipIf(!testDatabaseUrl)('full re-extract of 2,341 pages', () => {
  let pools: TwoPools;
  let db: Db;

  beforeAll(async () => {
    pools = await twoPools();
    db = createDb(pools.a);
  });
  afterAll(async () => {
    await pools?.close();
  });

  it('ai_calls stays 0 and no Anthropic client is constructed', { timeout: 180_000 }, async () => {
    const ds = await seedDataset(pools.a);
    const ls = listings(DEMO_LISTINGS);
    const ids = await upsertListingPages(pools.a, ds, ls);
    await insertSnapshots(pools.a, ids, ls, new Date('2026-11-12T06:00:00Z'));

    const approveRun = await newRun(pools.a, ds.siteId, 'APPROVE');
    const first = await extractTemplate({ datasetId: ds.datasetId, runId: approveRun }, { db });
    expect(first).toMatchObject({
      added: DEMO_LISTINGS,
      batches: Math.ceil(DEMO_LISTINGS / 200),
      recordCount: DEMO_LISTINGS,
    });

    const reRun = await newRun(pools.a, ds.siteId, 'MANUAL');
    const again = await extractTemplate({ datasetId: ds.datasetId, runId: reRun }, { db });
    expect(again).toMatchObject({ added: 0, updated: 0, removed: 0, unchanged: DEMO_LISTINGS });

    const runs = (
      await pools.a.query<{ id: string; ai_calls: number }>(
        'SELECT id, ai_calls FROM crawl_runs WHERE site_id = $1',
        [ds.siteId],
      )
    ).rows;
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.ai_calls === 0)).toBe(true);
    expect(anthropicCtor).not.toHaveBeenCalled();
  });
});
