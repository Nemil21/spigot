import { clusterUrls } from '@spigot/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demoSite, type DemoSite } from '../test/schema-agent/demoPages.js';
import { startSpaSite, type SpaSite } from '../test/render/spaSite.js';
import {
  chooseRenderMode,
  createBrowserRenderer,
  looksClientRendered,
  pageSignals,
  RenderError,
  type PlaywrightLike,
} from './render.js';

const get = async (url: string) => (await fetch(url)).text();

describe('render heuristic (SP-064)', () => {
  let spa: SpaSite;
  let ssr: SpaSite;
  beforeAll(async () => {
    [spa, ssr] = await Promise.all([startSpaSite('spa'), startSpaSite('ssr')]);
  });
  afterAll(async () => {
    await Promise.all([spa?.close(), ssr?.close()]);
  });

  it('flags the SPA shell and not its server-rendered twin', async () => {
    const shell = await get(`${spa.origin}/listings/sunny-loft-1`);
    const full = await get(`${ssr.origin}/listings/sunny-loft-1`);
    expect(looksClientRendered(shell)).toBe(true);
    expect(looksClientRendered(full)).toBe(false);
    expect(pageSignals(shell).textChars).toBeLessThan(40); // <noscript> doesn't count
  });

  it('ignores JSON-LD and other data blocks', () => {
    const ld = `<script type="application/ld+json">${JSON.stringify({ x: 'y'.repeat(5000) })}</script>`;
    const html = `<html><head>${ld}</head><body><p>Short page</p></body></html>`;
    expect(pageSignals(html).scriptChars).toBe(0);
    expect(looksClientRendered(html)).toBe(false);
  });

  it('a text-rich page with a big bundle stays html', () => {
    const html = `<body><script>${'x'.repeat(50_000)}</script><p>${'word '.repeat(200)}</p></body>`;
    expect(looksClientRendered(html)).toBe(false);
  });

  it('marks a template browser only when most samples are shells', async () => {
    const shell = await get(`${spa.origin}/listings/sunny-loft-1`);
    const full = await get(`${ssr.origin}/listings/sunny-loft-1`);
    expect(chooseRenderMode([shell, shell, full])).toBe('browser');
    expect(chooseRenderMode([shell, full])).toBe('html');
    expect(chooseRenderMode([])).toBe('html');
  });
});

describe('the demo site (server-rendered) never triggers browser mode', () => {
  let demo: DemoSite;
  beforeAll(async () => {
    demo = await demoSite(0.05);
  }, 60_000);

  it('no page looks client-rendered and every template stays html', () => {
    expect(demo.pages.length).toBeGreaterThan(50);
    for (const p of demo.pages) {
      if (looksClientRendered(p.html)) throw new Error(`${p.path} looks client-rendered`);
    }
    const byId = new Map(demo.pages.map((p) => [p.path, p.html]));
    const templates = clusterUrls(
      demo.pages.map((p) => ({ id: p.path, url: `${demo.origin}${p.path}` })),
    );
    expect(templates.length).toBeGreaterThan(0);
    for (const t of templates) {
      expect(chooseRenderMode(t.samplePageIds.map((id) => byId.get(id)!))).toBe('html');
    }
  });
});

describe('createBrowserRenderer without Chromium', () => {
  it('reports UNAVAILABLE when Playwright is missing, and retries the load next time', async () => {
    let loads = 0;
    const renderer = createBrowserRenderer({
      userAgent: 'ua',
      loadPlaywright: async () => {
        loads++;
        throw new RenderError('UNAVAILABLE', 'no playwright');
      },
    });
    const input = {
      url: 'http://x.test/',
      html: Buffer.from(''),
      fetchResource: async () => {
        throw new Error('unused');
      },
    };
    await expect(renderer.render(input)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(renderer.render(input)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(loads).toBe(2);
    await renderer.close();
  });

  it('renders one page at a time, each in a fresh context that is closed afterwards', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let contexts = 0;
    let closed = 0;
    let launchArgs: unknown;
    const fake: PlaywrightLike = {
      chromium: {
        launch: async (o) => {
          launchArgs = o.args;
          return {
            close: async () => {},
            newContext: async (ctxOpts) => {
              contexts++;
              expect(ctxOpts).toMatchObject({
                serviceWorkers: 'block',
                userAgent: 'SpigotCrawler/1.0',
              });
              return {
                route: async () => {},
                close: async () => void closed++,
                newPage: async () => ({
                  goto: async () => {
                    inFlight++;
                    maxInFlight = Math.max(maxInFlight, inFlight);
                    await new Promise((r) => setTimeout(r, 10));
                    inFlight--;
                  },
                  waitForLoadState: async () => {},
                  content: async () => '<html>rendered</html>',
                  mainFrame: () => null,
                }),
              };
            },
          };
        },
      },
    };
    const renderer = createBrowserRenderer({
      userAgent: 'SpigotCrawler/1.0',
      loadPlaywright: async () => fake,
    });
    const input = {
      url: 'http://x.test/',
      html: Buffer.from('<html></html>'),
      fetchResource: async () => {
        throw new Error('unused');
      },
    };
    const out = await Promise.all([1, 2, 3].map(() => renderer.render(input)));
    expect(out).toEqual(Array(3).fill('<html>rendered</html>'));
    expect(maxInFlight).toBe(1);
    expect(contexts).toBe(3);
    expect(closed).toBe(3);
    expect(launchArgs).toContain('--host-resolver-rules=MAP * ~NOTFOUND');
    await renderer.close();
  });
});
