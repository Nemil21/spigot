// Real SP-004a demo-site pages for schema-agent tests: the Express app runs in-process on a free
// port, and every sitemap URL is fetched once. Tests use the HTML as crawled snapshots.
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import PQueue from 'p-queue';
import { createAccessLog } from '../../../../demo-site/src/accessLog.js';
import { createApp } from '../../../../demo-site/src/app.js';
import { openStore } from '../../../../demo-site/src/data/store.js';

export interface DemoPage {
  /** Path, e.g. `/listings/3br-tarrytown-grackle-pass-1`. */
  path: string;
  html: string;
}

export interface DemoSite {
  origin: string;
  pages: DemoPage[];
  close(): Promise<void>;
}

/** Start the demo site at `scale` and fetch every sitemap page. Keep it running with `keepOpen`. */
export async function demoSite(
  scale: number,
  opts: { keepOpen?: boolean } = {},
): Promise<DemoSite> {
  const dataDir = await mkdtemp(join(tmpdir(), 'spigot-sp012a-'));
  const store = await openStore({ dataDir, scale });
  const app = createApp({ store, accessLog: createAccessLog(() => {}) });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dataDir, { recursive: true, force: true });
  };

  const sitemap = await (await fetch(`${origin}/sitemap.xml`)).text();
  const paths = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]!).pathname);
  const queue = new PQueue({ concurrency: 16 });
  const pages = await Promise.all(
    paths.map((path) =>
      queue.add(async () => ({ path, html: await (await fetch(`${origin}${path}`)).text() })),
    ),
  );
  if (!opts.keepOpen) await close();
  return { origin, pages: pages as DemoPage[], close };
}
