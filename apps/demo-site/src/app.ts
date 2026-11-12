import express, { type Request, type RequestHandler, type Response } from 'express';
import { fileURLToPath } from 'node:url';
import { createAccessLog, type AccessLog } from './accessLog.js';
import { createAdminRouter } from './admin.js';
import type { Store } from './data/store.js';
import type { Listing } from './data/types.js';
import { sendWithEtag } from './etag.js';
import { noopGate } from './gate.js';
import { jsonLdScript, listingJsonLd } from './jsonld.js';
import { PAGE_SIZE, parseSearchQuery, searchListings } from './search.js';

export const SITE_NAME = 'Bluebonnet Rentals';
export const FOOTER_NOTICE = 'Fictional demo site for Spigot. Not a real business.';

/** Facade colours: sky, wall, roof, door, glass, ground, tree. Warm Hill Country limestone, sage, brick. */
const ART_PALETTES = [
  ['#dfe7ef', '#efe6d6', '#5b4a3f', '#2c3d8f', '#b9c9d9', '#c9d3b5', '#6f8a5a'],
  ['#e4ebe4', '#c9d6c4', '#3e4a44', '#b35d3c', '#f3efe6', '#b9c4a3', '#55704d'],
  ['#e9e4ef', '#b9654c', '#3a3536', '#f1e7d6', '#d8e1ea', '#cbcfb0', '#667f55'],
  ['#e7ebf3', '#3b4a6b', '#222a3d', '#e3b04b', '#d9e2ee', '#c2cba9', '#5f7c55'],
  ['#f1e8dd', '#f6f1e7', '#a5553a', '#2f5d50', '#c4d1da', '#d3cfae', '#708f5b'],
  ['#e5e8ea', '#d7dadc', '#2e3438', '#c98a3a', '#9fb3c2', '#c0c8ab', '#5c7752'],
] as const;

const VIEWS_DIR = fileURLToPath(new URL('../views', import.meta.url));

export interface AppOptions {
  store: Store;
  /** spigot-gate middleware (SP-006b). Defaults to a no-op. */
  gate?: RequestHandler;
  /** Served at /.well-known/spigot.txt; 404 when unset. */
  verifyToken?: string;
  accessLog?: AccessLog;
  /** DEMO_ADMIN_TOKEN for /admin/{mutate,reset,state} (SP-004b). Unset → every /admin path is a 404. */
  adminToken?: string;
  /**
   * `DEMO_LAYOUT` (SP-052a, the drift demo). `v2` is the "redesign": listing pages render
   * `listing-v2.ejs` (renamed CSS classes, `available_from` moved) and their sitemap lastmod is at
   * least `layoutSince`, so a scheduled crawl re-fetches them like after a real redeploy.
   */
  layout?: DemoLayout;
  /** When the v2 layout went live (default: when createApp ran). */
  layoutSince?: Date;
}

export type DemoLayout = 'v1' | 'v2';

/** `DEMO_LAYOUT` → layout: `v2` (any case) is the redesign, anything else the original. */
export function parseDemoLayout(v: string | undefined): DemoLayout {
  return v?.trim().toLowerCase() === 'v2' ? 'v2' : 'v1';
}

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const longDate = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' });
const chicagoDate = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' });
const chicagoTime = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });

const helpers = {
  siteName: SITE_NAME,
  footerNotice: FOOTER_NOTICE,
  money: (n: number) => money.format(n),
  /** YYYY-MM-DD → "December 5, 2026". */
  date: (iso: string) => longDate.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`)),
  day: (iso: string) => chicagoDate.format(new Date(iso)),
  time: (iso: string) => chicagoTime.format(new Date(iso)),
  beds: (n: number) => (n === 0 ? 'Studio' : `${n} bed${n === 1 ? '' : 's'}`),
  baths: (n: number) => `${n} bath${n === 1 ? '' : 's'}`,
  num: (n: number) => n.toLocaleString('en-US'),
  /** The listing's illustrated facade: building type by size, colours fixed per listing id. */
  art: (l: Pick<Listing, 'id' | 'bedrooms'>) => {
    const kind = l.bedrooms <= 1 ? 'apartment' : l.bedrooms === 2 ? 'bungalow' : 'house';
    const [sky, wall, roof, door, glass, ground, tree] = ART_PALETTES[l.id % ART_PALETTES.length]!;
    return {
      kind,
      flip: Math.floor(l.id / ART_PALETTES.length) % 2 === 1,
      style: `--sky:${sky};--wall:${wall};--roof:${roof};--door:${door};--glass:${glass};--ground:${ground};--tree:${tree}`,
    };
  },
};

function origin(req: Request): string {
  return `${req.protocol}://${req.get('host')}`;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function createApp({
  store,
  gate = noopGate,
  verifyToken,
  accessLog = createAccessLog(),
  adminToken,
  layout = 'v1',
  layoutSince = new Date(),
}: AppOptions) {
  const app = express();
  // Sitemap lastmod format (whole seconds, Z).
  const layoutLastmod = `${layoutSince.toISOString().slice(0, 19)}Z`;
  const listingLastmod = (updatedAt: string) =>
    layout === 'v2' && layoutLastmod > updatedAt ? layoutLastmod : updatedAt;
  app.set('views', VIEWS_DIR);
  app.set('view engine', 'ejs');
  app.set('etag', false); // sendWithEtag sets a strong hash-of-body ETag instead
  // Render puts exactly one proxy in front: trust that hop only, so X-Forwarded-For can't be
  // spoofed past it (spigot-gate may key on req.ip). Sitemap URLs use the forwarded proto.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.locals.accessLog = accessLog;
  app.locals.store = store;
  Object.assign(app.locals, helpers);

  async function page(req: Request, res: Response, view: string, locals: Record<string, unknown>, status = 200) {
    const html = await new Promise<string>((resolve, reject) =>
      app.render(view, { ...locals, path: req.path }, (err, out) => (err ? reject(err) : resolve(out))),
    );
    res.status(status);
    sendWithEtag(req, res, html, 'text/html; charset=utf-8');
  }

  const notFound = (req: Request, res: Response) => page(req, res, 'not-found', { title: 'Page not found' }, 404);

  app.use(accessLog.middleware);
  // Admin sits before the gate: the CLI isn't a browser and must never get a 402.
  app.use('/admin', adminToken ? createAdminRouter({ store, token: adminToken }) : notFound);
  app.use(gate);

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, counts: store.counts() });
  });

  app.get('/', (req, res) => {
    const featured = store.listings.filter((l) => l.status === 'available').slice(0, 12);
    return page(req, res, 'home', {
      title: `${SITE_NAME}: apartments and homes for rent around Austin`,
      featured,
      neighbourhoods: store.neighbourhoods(),
      counts: store.counts(),
      q: parseSearchQuery({}),
    });
  });

  app.get('/search', (req, res) => {
    const parsed = parseSearchQuery(req.query as Record<string, unknown>);
    const total = searchListings(store.listings, { ...parsed, page: 1 }).total;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    // Clamp past-the-end pages so crawlers never walk an endless run of empty result pages.
    const q = { ...parsed, page: Math.min(parsed.page, pages) };
    const { results } = searchListings(store.listings, q);
    const params = new URLSearchParams();
    if (q.beds !== undefined) params.set('beds', String(q.beds));
    if (q.maxRent !== undefined) params.set('max_rent', String(q.maxRent));
    if (q.neighbourhood) params.set('neighbourhood', q.neighbourhood);
    return page(req, res, 'search', {
      title: `Search rentals | ${SITE_NAME}`,
      q,
      total,
      results,
      pages,
      baseQuery: params.toString(),
      neighbourhoods: store.neighbourhoods(),
    });
  });

  app.get('/listings/:slug', (req, res) => {
    const listing = store.listing(req.params.slug);
    if (!listing) return notFound(req, res);
    const url = `${origin(req)}/listings/${listing.slug}`;
    return page(req, res, layout === 'v2' ? 'listing-v2' : 'listing', {
      title: `${listing.title} | ${SITE_NAME}`,
      listing,
      agent: store.agent(listing.agent_slug),
      openHouses: store.openHousesForListing(listing.slug),
      jsonLd: jsonLdScript(listingJsonLd(listing, url)),
    });
  });

  app.get('/agents/:slug', (req, res) => {
    const agent = store.agent(req.params.slug);
    if (!agent) return notFound(req, res);
    const listings = store.listingsForAgent(agent.slug);
    return page(req, res, 'agent', {
      title: `${agent.name}, ${agent.brokerage} | ${SITE_NAME}`,
      agent,
      active: listings.filter((l) => l.status === 'available'),
      leasedCount: listings.filter((l) => l.status === 'leased').length,
    });
  });

  app.get('/open-houses/:id', (req, res) => {
    const id = /^\d+$/.test(req.params.id) ? Number(req.params.id) : NaN;
    const openHouse = store.openHouse(id);
    if (!openHouse) return notFound(req, res);
    const listing = store.listing(openHouse.listing_slug);
    return page(req, res, 'open-house', {
      title: `Open house: ${listing?.title ?? 'listing'} | ${SITE_NAME}`,
      openHouse,
      listing,
      agent: store.agent(openHouse.host_agent_slug),
    });
  });

  app.get('/about', (req, res) => page(req, res, 'about', { title: `About | ${SITE_NAME}`, counts: store.counts() }));

  app.get('/blog', (req, res) => page(req, res, 'blog-index', { title: `Renter notes | ${SITE_NAME}`, posts: store.blogPosts }));

  app.get('/blog/:slug', (req, res) => {
    const post = store.blogPost(req.params.slug);
    if (!post) return notFound(req, res);
    return page(req, res, 'blog-post', { title: `${post.title} | ${SITE_NAME}`, post });
  });

  app.get('/sitemap.xml', (req, res) => {
    const base = origin(req);
    const newest = (dates: string[]) => dates.reduce((a, b) => (a > b ? a : b), '1970-01-01T00:00:00Z');
    const siteLastmod = newest([
      ...store.listings.map((l) => listingLastmod(l.updated_at)),
      ...store.agents.map((a) => a.updated_at),
      ...store.openHouses.map((o) => o.updated_at),
    ]);
    const entries: [string, string][] = [
      ['/', siteLastmod],
      ['/about', siteLastmod],
      ['/blog', newest(store.blogPosts.map((p) => p.updated_at))],
      ...store.listings.map((l): [string, string] => [`/listings/${l.slug}`, listingLastmod(l.updated_at)]),
      ...store.agents.map((a): [string, string] => [`/agents/${a.slug}`, a.updated_at]),
      ...store.openHouses.map((o): [string, string] => [`/open-houses/${o.id}`, o.updated_at]),
      ...store.blogPosts.map((p): [string, string] => [`/blog/${p.slug}`, p.updated_at]),
    ];
    const body =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      entries.map(([p, lastmod]) => `  <url><loc>${xmlEscape(base + p)}</loc><lastmod>${lastmod}</lastmod></url>\n`).join('') +
      '</urlset>\n';
    sendWithEtag(req, res, body, 'application/xml; charset=utf-8');
  });

  app.get('/robots.txt', (req, res) => {
    const body = `User-agent: *\nAllow: /\nDisallow: /admin\n\nSitemap: ${origin(req)}/sitemap.xml\n`;
    sendWithEtag(req, res, body, 'text/plain; charset=utf-8');
  });

  app.get('/.well-known/spigot.txt', (req, res) => {
    if (!verifyToken) return notFound(req, res);
    sendWithEtag(req, res, `${verifyToken}\n`, 'text/plain; charset=utf-8');
  });

  app.use(notFound);

  return app;
}
