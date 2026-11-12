// SP-064: the schema agent's render hook on the real demo site. With rendering on, every new
// template is checked once before its samples are read, and the server-rendered demo site never
// switches a template to `browser` (the renderer is never even asked). No Chromium needed.
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccessLog } from '../../../demo-site/src/accessLog.js';
import { createApp } from '../../../demo-site/src/app.js';
import { openStore } from '../../../demo-site/src/data/store.js';
import { createDb, type Db } from '../db/index.js';
import { testDatabaseUrl, twoPools, type TwoPools } from '../db/test-db.js';
import { RecordedProposalMissingError, type SchemaModel } from '../schema-agent/claude.js';
import { proposeForSite } from '../schema-agent/propose.js';
import { crawlKeyHash, deriveCrawlKey } from './crawlKey.js';
import { crawlSite } from './crawlSite.js';
import type { CrawlDeps } from './deps.js';
import { clearCrawlHooks } from './hooks.js';
import { resetHostQueues } from './queue.js';
import { prepareTemplateRender, type Renderer } from './render.js';

const SECRET = 'render-propose-secret-'.padEnd(40, 'x');

// No recorded proposal for any template: each one is skipped without a model call.
const noModel: SchemaModel = {
  mode: 'recorded',
  modelId: 'none',
  open: () => {
    const fail = async () => {
      throw new RecordedProposalMissingError('no recording');
    };
    return { first: fail, retry: fail };
  },
  repair: async () => {
    throw new Error('unused');
  },
};

describe.skipIf(!testDatabaseUrl)('schema agent render hook on the demo site (SP-064)', () => {
  let pools: TwoPools;
  let db: Db;
  let server: Server;
  let origin: string;
  let dataDir: string;

  beforeAll(async () => {
    pools = await twoPools();
    db = createDb(pools.a);
    await pools.a.query(
      'TRUNCATE snapshots, crawl_runs, pages, templates, sites, publishers CASCADE',
    );
    resetHostQueues();
    clearCrawlHooks();
    dataDir = await mkdtemp(join(tmpdir(), 'spigot-sp064-'));
    const store = await openStore({ dataDir, scale: 0.05 });
    server = createServer(createApp({ store, accessLog: createAccessLog(() => {}) }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);
  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    await pools?.close();
  });

  it('checks each new template once and never marks the demo site browser', async () => {
    const pub = await pools.a.query<{ id: string }>(
      `INSERT INTO publishers (name, email, payout_email) VALUES ('P', 'p@x.test', 'p@x.test') RETURNING id`,
    );
    const site = await pools.a.query<{ id: string }>(
      `INSERT INTO sites (publisher_id, origin, verify_token, crawl_key_hash, gate_key_hash, status)
       VALUES ($1, $2, 'v', 'pending', 'g', 'VERIFIED') RETURNING id`,
      [pub.rows[0]!.id, origin],
    );
    const siteId = site.rows[0]!.id;
    await pools.a.query('UPDATE sites SET crawl_key_hash = $2 WHERE id = $1', [
      siteId,
      crawlKeyHash(deriveCrawlKey(siteId, SECRET)),
    ]);

    let renders = 0;
    const renderer: Renderer = {
      render: async () => {
        renders++;
        throw new Error('the demo site must never be rendered');
      },
      close: async () => {},
    };
    const crawlDeps: CrawlDeps = {
      db,
      crawlSecret: SECRET,
      allowLocal: true,
      appBaseUrl: 'http://spigot.test',
      minGapMs: 0,
      sleep: async () => {},
      renderer,
    };
    await crawlSite({ siteId, trigger: 'CONNECT' }, crawlDeps);

    const checked: string[] = [];
    const result = await proposeForSite(
      {
        db,
        model: noModel,
        prepareRender: async (templateId) => {
          checked.push(templateId);
          return prepareTemplateRender(crawlDeps, templateId);
        },
      },
      siteId,
      { trigger: 'ADMIN' },
    );
    expect(result.status).toBe('done');

    const templates = await pools.a.query<{
      id: string;
      render: string;
      render_since: Date | null;
    }>('SELECT id, render, render_since FROM templates WHERE site_id = $1', [siteId]);
    expect(templates.rows.length).toBeGreaterThan(0);
    expect(checked.sort()).toEqual(templates.rows.map((t) => t.id).sort());
    for (const t of templates.rows) expect(t).toMatchObject({ render: 'html', render_since: null });
    expect(renders).toBe(0);
  }, 60_000);
});
