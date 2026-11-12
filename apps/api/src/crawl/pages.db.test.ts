import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db/index.js';
import { twoPools, testDatabaseUrl, type TwoPools } from '../db/test-db.js';
import { upsertPages } from './pages.js';
import type { SitemapEntry } from './sitemap.js';

const ORIGIN = 'https://site.test';
const e = (path: string, lastmod: string | null = null): SitemapEntry => ({
  url: `${ORIGIN}${path}`,
  lastmod: lastmod ? new Date(lastmod) : null,
});

describe.skipIf(!testDatabaseUrl)('upsertPages', () => {
  let pools: TwoPools;
  let db: Db;
  let siteId: string;
  let otherSiteId: string;

  const pages = async (site = siteId) =>
    (
      await pools.a.query<{
        url: string;
        sitemap_lastmod: Date | null;
        removed_at: Date | null;
        updated_at: Date;
      }>(
        'SELECT url, sitemap_lastmod, removed_at, updated_at FROM pages WHERE site_id = $1 ORDER BY url',
        [site],
      )
    ).rows;

  const newSite = async (pool: pg.Pool, origin: string) => {
    const pub = await pool.query<{ id: string }>(
      `INSERT INTO publishers (name, email, payout_email) VALUES ('P', $1, 'p@x.test') RETURNING id`,
      [`p-${origin}@x.test`],
    );
    const site = await pool.query<{ id: string }>(
      `INSERT INTO sites (publisher_id, origin, verify_token, crawl_key_hash, gate_key_hash)
       VALUES ($1, $2, 'v', 'c', 'g') RETURNING id`,
      [pub.rows[0]!.id, origin],
    );
    return site.rows[0]!.id;
  };

  beforeAll(async () => {
    pools = await twoPools();
    db = createDb(pools.a);
  });
  afterAll(async () => {
    await pools?.close();
  });
  beforeEach(async () => {
    await pools.a.query('TRUNCATE pages, sites, publishers CASCADE');
    siteId = await newSite(pools.a, ORIGIN);
    otherSiteId = await newSite(pools.a, 'https://other.test');
  });

  it('inserts new pages, then the same list again changes nothing', async () => {
    const list = [e('/a', '2026-11-01'), e('/b'), e('/c?z=1&a=2#frag', '2026-11-02T08:00:00Z')];
    expect(await upsertPages(db, siteId, list)).toEqual({ new: 3, changed: 0, removed: 0 });
    const first = await pages();
    expect(first.map((p) => p.url)).toEqual([`${ORIGIN}/a`, `${ORIGIN}/b`, `${ORIGIN}/c?a=2&z=1`]);
    expect(first[0]!.sitemap_lastmod).toEqual(new Date('2026-11-01T00:00:00Z'));

    expect(await upsertPages(db, siteId, list)).toEqual({ new: 0, changed: 0, removed: 0 });
    // Not a single row was rewritten.
    expect(await pages()).toEqual(first);
  });

  it('a dropped URL gets removed_at; a re-listed one is cleared; lastmod changes count as changed', async () => {
    await upsertPages(db, siteId, [e('/a', '2026-11-01'), e('/b'), e('/c')]);

    expect(await upsertPages(db, siteId, [e('/a', '2026-11-05'), e('/c'), e('/d')])).toEqual({
      new: 1,
      changed: 1,
      removed: 1,
    });
    let rows = await pages();
    const b = rows.find((p) => p.url === `${ORIGIN}/b`)!;
    expect(b.removed_at).not.toBeNull();
    expect(rows.filter((p) => p.removed_at)).toHaveLength(1);
    expect(rows.find((p) => p.url === `${ORIGIN}/a`)!.sitemap_lastmod).toEqual(
      new Date('2026-11-05T00:00:00Z'),
    );

    // Still dropped: removed_at stays as it was (not re-stamped).
    expect(await upsertPages(db, siteId, [e('/a', '2026-11-05'), e('/c'), e('/d')])).toEqual({
      new: 0,
      changed: 0,
      removed: 0,
    });
    expect((await pages()).find((p) => p.url === `${ORIGIN}/b`)!.removed_at).toEqual(b.removed_at);

    // Listed again: back to live.
    expect(
      await upsertPages(db, siteId, [e('/a', '2026-11-05'), e('/b'), e('/c'), e('/d')]),
    ).toEqual({
      new: 0,
      changed: 1,
      removed: 0,
    });
    rows = await pages();
    expect(rows.every((p) => p.removed_at === null)).toBe(true);
  });

  it('dedupes the input and leaves other sites alone', async () => {
    await upsertPages(db, otherSiteId, [{ url: 'https://other.test/x', lastmod: null }]);
    expect(await upsertPages(db, siteId, [e('/a'), e('/a#x'), e('/a')])).toEqual({
      new: 1,
      changed: 0,
      removed: 0,
    });
    expect(await upsertPages(db, siteId, [])).toEqual({ new: 0, changed: 0, removed: 1 });
    expect((await pages(otherSiteId))[0]!.removed_at).toBeNull();
  });

  it('two concurrent runs with the same list from two processes: one inserts, the other is a no-op', async () => {
    const dbB = createDb(pools.b);
    const list = Array.from({ length: 500 }, (_, i) => e(`/p/${i}`, '2026-11-01'));
    const [r1, r2] = await Promise.all([
      upsertPages(db, siteId, list),
      upsertPages(dbB, siteId, list),
    ]);
    expect([r1, r2].map((r) => r.new).sort((x, y) => x - y)).toEqual([0, 500]);
    expect(r1.changed + r2.changed + r1.removed + r2.removed).toBe(0);
    expect(await pages()).toHaveLength(500);
  });
});
