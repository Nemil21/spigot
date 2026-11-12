import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as cheerio from 'cheerio';
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createAccessLog } from './accessLog.js';
import { createApp } from './app.js';
import { LOG_FILE, createStore, openStore } from './data/store.js';
import { generateSeed } from './data/seed.js';

const TOKEN = 'demo-admin-test-token';
const auth = { Authorization: `Bearer ${TOKEN}` };
const SCALE = 0.05;

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A clock the test advances by hand, starting after the seed's newest updated_at. */
function clock(start = '2026-11-12T10:00:00Z') {
  let t = Date.parse(start);
  return { now: () => new Date(t), tick: (s = 60) => void (t += s * 1000) };
}

async function boot(dataDir: string, now: () => Date) {
  const store = await openStore({ dataDir, scale: SCALE, now });
  const app = createApp({ store, adminToken: TOKEN, accessLog: createAccessLog(() => {}) });
  return { store, app };
}

async function tmp() {
  const dir = await mkdtemp(path.join(tmpdir(), 'bluebonnet-admin-'));
  dirs.push(dir);
  return dir;
}

/**
 * path → { lastmod, etag } for every record page in the sitemap. Host is pinned because
 * supertest binds a new port per request and listing JSON-LD embeds the absolute URL.
 */
async function crawl(app: Express): Promise<Map<string, { lastmod: string; etag: string }>> {
  const HOST = 'bluebonnet.test';
  const xml = (await request(app).get('/sitemap.xml').set('Host', HOST).expect(200)).text;
  const $ = cheerio.load(xml, { xml: true });
  const out = new Map<string, { lastmod: string; etag: string }>();
  for (const el of $('url').toArray()) {
    const p = new URL($(el).find('loc').text()).pathname;
    if (!/^\/(listings|agents|open-houses)\//.test(p)) continue;
    const res = await request(app).get(p).set('Host', HOST).expect(200);
    out.set(p, { lastmod: $(el).find('lastmod').text(), etag: res.headers.etag as string });
  }
  return out;
}

describe('admin endpoints: auth', () => {
  it('404 on every /admin path when DEMO_ADMIN_TOKEN is unset', async () => {
    const app = createApp({ store: createStore(SCALE), accessLog: createAccessLog(() => {}) });
    await request(app).get('/admin/state').set(auth).expect(404);
    await request(app).post('/admin/mutate').set(auth).send({ prices: 1 }).expect(404);
    await request(app).post('/admin/reset').expect(404);
  });

  it('401 without the token or with a wrong one, for every endpoint', async () => {
    const app = createApp({
      store: createStore(SCALE),
      adminToken: TOKEN,
      accessLog: createAccessLog(() => {}),
    });
    for (const [method, p] of [
      ['get', '/admin/state'],
      ['post', '/admin/mutate'],
      ['post', '/admin/reset'],
    ] as const) {
      const res = await request(app)[method](p).expect(401);
      expect(res.headers['www-authenticate']).toMatch(/^Bearer/);
      await request(app)[method](p).set('Authorization', 'Bearer wrong').expect(401);
      await request(app)[method](p).set('Authorization', TOKEN).expect(401);
    }
    await request(app).get('/admin/state').set(auth).expect(200);
    await request(app).get('/admin/nope').set(auth).expect(404);
  });

  it('400 on bad options or bad JSON, and nothing changes', async () => {
    const store = createStore(SCALE);
    const app = createApp({ store, adminToken: TOKEN, accessLog: createAccessLog(() => {}) });
    expect(
      (await request(app).post('/admin/mutate').set(auth).send({}).expect(400)).body.message,
    ).toMatch(/nothing to change/);
    await request(app).post('/admin/mutate').set(auth).send({ prices: 'lots' }).expect(400);
    await request(app)
      .post('/admin/mutate')
      .set(auth)
      .send({ prices: 1, focus: 'colour=red' })
      .expect(400);
    await request(app).post('/admin/mutate').set(auth).send({ prices: 10_000 }).expect(400);
    await request(app)
      .post('/admin/mutate')
      .set(auth)
      .set('Content-Type', 'application/json')
      .send('{not json')
      .expect(400);
    expect(store.state().mutations).toBe(0);
  });
});

describe('admin endpoints: mutate, restart, reset', () => {
  it('mutate bumps lastmod and ETag on touched pages only; a restart keeps it; reset restores the seed', async () => {
    const dir = await tmp();
    const c = clock();
    let { store, app } = await boot(dir, c.now);
    const seed = generateSeed(SCALE);
    const before = await crawl(app);

    c.tick();
    const res = await request(app)
      .post('/admin/mutate')
      .set(auth)
      .send({ prices: 10, leased: 3, new: 2, seed: 42 })
      .expect(200);
    const m = res.body;
    expect(m.label).toBe('demo mutation');
    expect(m.prices).toHaveLength(10);
    expect(m.leased).toHaveLength(3);
    expect(m.added).toHaveLength(2);
    expect(res.body.counts.listings).toBe(seed.listings.length + 2);

    const after = await crawl(app);
    const touched = new Set<string>(m.touched);
    for (const slug of m.added) expect(touched.has(`/listings/${slug}`)).toBe(true);
    for (const [p, now] of after) {
      const was = before.get(p);
      if (touched.has(p)) {
        expect(now.lastmod, p).toBe(m.at);
        if (was) {
          expect(now.lastmod > was.lastmod, p).toBe(true);
          expect(now.etag, p).not.toBe(was.etag);
        }
      } else {
        expect(now, p).toEqual(was);
      }
    }
    // The page shows the new rent and the leased badge.
    const p0 = m.prices[0];
    const html = cheerio.load((await request(app).get(`/listings/${p0.slug}`).expect(200)).text);
    expect(html('.listing-price').text()).toBe(`$${p0.to.toLocaleString('en-US')}`);
    const leasedHtml = cheerio.load(
      (await request(app).get(`/listings/${m.leased[0]}`).expect(200)).text,
    );
    expect(leasedHtml('.status-badge').text().trim()).toBe('Leased');

    const state = (await request(app).get('/admin/state').set(auth).expect(200)).body;
    expect(state.mutations).toBe(1);
    expect(state.log[0].prices).toEqual(m.prices);
    expect(state.counts.listings).toBe(seed.listings.length + 2);

    // Restart: a new process replays the log and serves the same pages.
    ({ store, app } = await boot(dir, c.now));
    expect(await crawl(app)).toEqual(after);
    expect(store.state().mutations).toBe(1);

    // Reset: seed content back, added listings gone, reverted pages' lastmod newer than before the reset.
    c.tick();
    const r = (await request(app).post('/admin/reset').set(auth).expect(200)).body;
    expect(r.removed.sort()).toEqual([...m.added].sort());
    for (const slug of m.added) await request(app).get(`/listings/${slug}`).expect(404);
    const strip = (ls: typeof seed.listings) => ls.map(({ updated_at: _u, ...rest }) => rest);
    expect(strip([...store.listings])).toEqual(strip(seed.listings));
    const reset = await crawl(app);
    expect([...reset.keys()].sort()).toEqual([...before.keys()].sort());
    const reverted = new Set<string>(r.reverted);
    expect(reverted).toEqual(new Set([...touched].filter((p) => before.has(p))));
    for (const [p, now] of reset) {
      if (reverted.has(p)) {
        expect(now.lastmod > after.get(p)!.lastmod, p).toBe(true);
        expect(now.lastmod, p).toBe(r.at);
      } else {
        expect(now, p).toEqual(before.get(p));
      }
    }
    expect((await request(app).get('/admin/state').set(auth).expect(200)).body).toMatchObject({
      mutations: 0,
      lastResetAt: r.at,
    });

    // The reset survives a restart too (log = one reset entry carrying the new lastmods).
    ({ app } = await boot(dir, c.now));
    expect(await crawl(app)).toEqual(reset);
    const lines = (await readFile(path.join(dir, LOG_FILE), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).kind).toBe('reset');
  });

  it('serializes concurrent mutations: both apply, disjoint new ids, and the log replays to the same state', async () => {
    const dir = await tmp();
    const c = clock();
    const { store, app } = await boot(dir, c.now);
    const [a, b] = await Promise.all([
      request(app).post('/admin/mutate').set(auth).send({ prices: 5, new: 2, seed: 1 }),
      request(app).post('/admin/mutate').set(auth).send({ prices: 5, new: 2, seed: 1 }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(new Set([...a.body.added, ...b.body.added]).size).toBe(4);
    // Same second, same pages possibly: the second one's lastmod is strictly later.
    expect(a.body.at).not.toBe(b.body.at);
    expect(store.state().mutations).toBe(2);
    const replayed = await openStore({ dataDir: dir, scale: SCALE, now: c.now });
    expect(replayed.data).toEqual(store.data);
  });

  it('drops a torn last log line on boot, and refuses a log from another seed scale', async () => {
    const dir = await tmp();
    const c = clock();
    const { store } = await boot(dir, c.now);
    await store.mutate({ prices: 2, leased: 0, new: 0, seed: 1, ping: false });
    const file = path.join(dir, LOG_FILE);
    await writeFile(file, `${await readFile(file, 'utf8')}{"kind":"mutate","at":`);
    const reopened = await openStore({ dataDir: dir, scale: SCALE, now: c.now });
    expect(reopened.data).toEqual(store.data);
    await reopened.mutate({ prices: 1, leased: 0, new: 0, seed: 2, ping: false });
    expect((await openStore({ dataDir: dir, scale: SCALE, now: c.now })).data).toEqual(
      reopened.data,
    );
    await expect(openStore({ dataDir: dir, scale: 0.1 })).rejects.toThrow(/DEMO_SEED_SCALE/);
  });
});
