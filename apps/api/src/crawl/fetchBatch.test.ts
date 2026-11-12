import { describe, expect, it } from 'vitest';
import type { CrawlDeps } from './deps.js';
import { fetchBatch, planBatches } from './fetchBatch.js';
import type { FetchPageResult } from './fetchPage.js';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `page-${i}`);

describe('planBatches (structural 2-per-host fan-out)', () => {
  it('100 pages → exactly 2 batches of 50 that cover every page once', () => {
    const pages = ids(100);
    const batches = planBatches(pages);
    expect(batches).toHaveLength(2);
    expect(batches.map((b) => b.length)).toEqual([50, 50]);
    expect([...batches.flat()].sort()).toEqual([...pages].sort());
    expect(new Set(batches.flat()).size).toBe(100);
  });

  it('never more than 2, never an empty batch', () => {
    expect(planBatches([])).toEqual([]);
    expect(planBatches(['a'])).toEqual([['a']]);
    expect(planBatches(['a', 'b', 'c'])).toEqual([['a', 'c'], ['b']]);
    // Asking for more than the host limit still yields 2.
    expect(planBatches(ids(10), 8)).toHaveLength(2);
    for (let n = 0; n <= 25; n++) {
      const b = planBatches(ids(n));
      expect(b.length).toBe(Math.min(2, n));
      expect(b.every((share) => share.length > 0)).toBe(true);
    }
  });

  it('keeps the crawl order within each batch', () => {
    const [a, b] = planBatches(ids(6));
    expect(a).toEqual(['page-0', 'page-2', 'page-4']);
    expect(b).toEqual(['page-1', 'page-3', 'page-5']);
  });
});

/** A db whose "already fetched?" query answers `remaining`; counts other writes. */
function fakeDeps(remaining: string[]) {
  const failedBumps: unknown[] = [];
  const deps = {
    db: {
      pool: {
        query: async (sql: string, params: unknown[]) => {
          if (sql.includes('FROM pages p JOIN crawl_runs r')) {
            return { rows: remaining.map((id) => ({ id })) };
          }
          if (sql.includes('pages_failed = pages_failed + 1')) failedBumps.push(params);
          return { rows: [] };
        },
      },
    },
    progressEvery: 1_000,
  } as unknown as CrawlDeps;
  return { deps, failedBumps };
}

describe('fetchBatch', () => {
  it('fetches its share one page at a time, in order', async () => {
    const pages = ids(20);
    const { deps } = fakeDeps(pages);
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    const res = await fetchBatch({ runId: 'r', pageIds: pages }, deps, async ({ pageId }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      order.push(pageId);
      inFlight -= 1;
      return { outcome: 'changed', status: 200 };
    });
    expect(res).toEqual({ attempted: 20, alreadyDone: 0, stopped: false });
    expect(maxInFlight).toBe(1);
    expect(order).toEqual(pages);
  });

  it('two batches at once never exceed 2 requests in flight (by construction)', async () => {
    const [a, b] = planBatches(ids(100));
    let inFlight = 0;
    let maxInFlight = 0;
    const runPage = async (): Promise<FetchPageResult> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, Math.random() * 2));
      inFlight -= 1;
      return { outcome: 'not_modified', status: 304 };
    };
    const results = await Promise.all([
      fetchBatch({ runId: 'r', pageIds: a! }, fakeDeps(a!).deps, runPage),
      fetchBatch({ runId: 'r', pageIds: b! }, fakeDeps(b!).deps, runPage),
    ]);
    expect(results.map((r) => r.attempted)).toEqual([50, 50]);
    expect(maxInFlight).toBe(2);
  });

  it('a retried batch skips the pages this run already fetched', async () => {
    const pages = ids(5);
    const { deps } = fakeDeps(['page-3', 'page-4']);
    const seen: string[] = [];
    const res = await fetchBatch({ runId: 'r', pageIds: pages }, deps, async ({ pageId }) => {
      seen.push(pageId);
      return { outcome: 'changed', status: 200 };
    });
    expect(seen).toEqual(['page-3', 'page-4']);
    expect(res).toEqual({ attempted: 2, alreadyDone: 3, stopped: false });
  });

  it('stops when the run pauses or is no longer RUNNING', async () => {
    const pages = ids(10);
    for (const stop of [
      { outcome: 'paused', status: 429 },
      { outcome: 'skipped', reason: 'run_not_running' },
    ] as FetchPageResult[]) {
      let n = 0;
      const res = await fetchBatch(
        { runId: 'r', pageIds: pages },
        fakeDeps(pages).deps,
        async () => (++n === 3 ? stop : { outcome: 'changed', status: 200 }),
      );
      expect(res).toEqual({ attempted: 3, alreadyDone: 0, stopped: true });
    }
  });

  it('a page that throws counts as failed and the batch carries on', async () => {
    const pages = ids(3);
    const { deps, failedBumps } = fakeDeps(pages);
    const res = await fetchBatch({ runId: 'r', pageIds: pages }, deps, async ({ pageId }) => {
      if (pageId === 'page-1') throw new Error('db blip');
      return { outcome: 'changed', status: 200 };
    });
    expect(res).toEqual({ attempted: 3, alreadyDone: 0, stopped: false });
    expect(failedBumps).toEqual([['r']]);
  });
});
