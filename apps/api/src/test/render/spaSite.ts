// SP-064 fixture: a small listings site in two builds over the same data. `ssr` renders each
// listing on the server; `spa` serves a JS shell whose script fetches `/api/listings/<slug>.json`
// and builds the identical DOM in the browser. The script also tries to reach `leakUrl` (another
// origin) and sets a cookie, so tests can prove the renderer refuses both.
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Listing {
  slug: string;
  title: string;
  price: number;
  beds: number;
}

export const LISTINGS: Listing[] = [
  { slug: 'sunny-loft-1', title: 'Sunny loft on Elm', price: 1850, beds: 1 },
  { slug: 'garden-flat-2', title: 'Garden flat by the park', price: 2400, beds: 2 },
  { slug: 'river-house-3', title: 'River house with deck', price: 3900, beds: 3 },
];

export interface SeenRequest {
  path: string;
  headers: IncomingHttpHeaders;
}

export interface SpaSite {
  origin: string;
  mode: 'ssr' | 'spa';
  data: Listing[];
  seen: SeenRequest[];
  close(): Promise<void>;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

const listingHtml = (l: Listing) =>
  `<article class="listing"><h1 class="title">${esc(l.title)}</h1>` +
  `<p class="price">$${l.price.toLocaleString('en-US')}/mo</p>` +
  `<p class="beds">${l.beds} bedrooms</p></article>`;

const page = (body: string, scripts = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Listings</title>${scripts}</head>` +
  `<body><header><a href="/">Fixture Rentals</a></header><main id="app">${body}</main></body></html>`;

// The browser build of `listingHtml`, plus some bundle-like weight so the shell looks like an SPA.
const appJs = (leakUrl: string) => `
(function () {
  var esc = function (s) { return s.replace(/[&<>"]/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); };
  document.cookie = 'tracker=1; path=/';
  try { fetch(${JSON.stringify(leakUrl)}).catch(function () {}); } catch (e) {}
  var slug = location.pathname.split('/').pop();
  fetch('/api/listings/' + slug + '.json', { headers: { accept: 'application/json' } })
    .then(function (r) { return r.json(); })
    .then(function (l) {
      document.getElementById('app').innerHTML =
        '<article class="listing"><h1 class="title">' + esc(l.title) + '</h1>' +
        '<p class="price">$' + l.price.toLocaleString('en-US') + '/mo</p>' +
        '<p class="beds">' + l.beds + ' bedrooms</p></article>';
    });
})();
/* ${'bundle padding '.repeat(80)} */
`;

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
}

export async function startSpaSite(
  mode: 'ssr' | 'spa',
  opts: { leakUrl?: string } = {},
): Promise<SpaSite> {
  const data = LISTINGS.map((l) => ({ ...l }));
  const seen: SeenRequest[] = [];
  let origin = '';
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    seen.push({ path, headers: req.headers });
    const send = (status: number, type: string, body: string) => {
      res.writeHead(status, { 'content-type': type, 'set-cookie': 'session=abc; Path=/' });
      res.end(body);
    };
    if (path === '/sitemap.xml') {
      const locs = data.map((l) => `<url><loc>${origin}/listings/${l.slug}</loc></url>`).join('');
      return send(
        200,
        'application/xml',
        `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs}</urlset>`,
      );
    }
    if (path === '/app.js')
      return send(200, 'text/javascript', appJs(opts.leakUrl ?? 'http://203.0.113.9/leak'));
    const api = /^\/api\/listings\/([\w-]+)\.json$/.exec(path);
    const html = /^\/listings\/([\w-]+)$/.exec(path);
    const l = data.find((x) => x.slug === (api ?? html)?.[1]);
    if (api && l) return send(200, 'application/json', JSON.stringify(l));
    if (html && l) {
      if (mode === 'ssr') return send(200, 'text/html; charset=utf-8', page(listingHtml(l)));
      return send(
        200,
        'text/html; charset=utf-8',
        page('<noscript>Enable JavaScript</noscript>', '<script defer src="/app.js"></script>'),
      );
    }
    send(404, 'text/plain', 'not found');
  });
  origin = await listen(server);
  return {
    origin,
    mode,
    data,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Counts any request at all: the renderer must never reach it. */
export async function startLeakListener(): Promise<{
  url: string;
  hits: () => number;
  close(): Promise<void>;
}> {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.end('leaked');
  });
  const origin = await listen(server);
  return {
    url: `${origin}/leak`,
    hits: () => hits,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
