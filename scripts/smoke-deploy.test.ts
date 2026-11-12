import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/** SP-040: scripts/smoke-deploy.mjs against stub API and demo-site servers. */

const SCRIPT = fileURLToPath(new URL('./smoke-deploy.mjs', import.meta.url));
const GATE_KEY = 'gk_smoke_test_secret_value_123';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function serve(handler: Handler): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const json = (
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
const noRoute = (req: IncomingMessage, res: ServerResponse) =>
  json(res, 404, {
    error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.url}.` },
  });

/** An API with everything merged (`full`) or only SP-001a's routes (`partial`). */
function api(mode: 'full' | 'partial', health = true): Handler {
  return (req, res) => {
    const url = req.url ?? '';
    if (url === '/api/healthz') return health ? json(res, 200, { ok: true }) : json(res, 500, {});
    if (url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><html><body>Spigot</body></html>');
    }
    if (mode === 'partial') return noRoute(req, res);
    if (url === '/v1/catalog')
      return json(res, 200, { sites: [{ slug: 'bluebonnet', datasets: [{}] }] });
    if (url === '/api/gate/policy') {
      return req.headers.authorization === `Bearer ${GATE_KEY}`
        ? json(res, 200, { policyVersion: 3, gatedPaths: ['^/listings/'] })
        : json(res, 401, { error: { code: 'UNAUTHENTICATED', message: 'Gate key required.' } });
    }
    return noRoute(req, res);
  };
}

/** The demo site with the gate installed (`gated`) or not. */
function demoSite(gated: boolean): Handler {
  return (req, res) => {
    const url = req.url ?? '';
    if (url === '/healthz') return json(res, 200, { ok: true });
    if (url === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end(
        '<urlset><url><loc>https://bluebonnet-rentals.onrender.com/</loc></url>' +
          '<url><loc>https://bluebonnet-rentals.onrender.com/listings/2br-x-1</loc></url></urlset>',
      );
    }
    if (url === '/listings/2br-x-1') {
      if (gated && /GPTBot/.test(req.headers['user-agent'] ?? '')) {
        return json(
          res,
          402,
          {
            error: { code: 'PAYMENT_REQUIRED', message: 'This site sells its data as an API.' },
            datasets: [{ slug: 'listings' }],
            pay: { provider: 'PayPal' },
          },
          { 'cache-control': 'no-store', link: '<https://spigot/c/bluebonnet>; rel="payment"' },
        );
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html>listing</html>');
    }
    res.writeHead(404).end();
  };
}

function smoke(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env: { PATH: process.env.PATH ?? '', ...env } },
      (err, stdout, stderr) =>
        resolve({ code: err ? Number(err.code ?? 1) : 0, out: stdout + stderr }),
    );
  });
}

describe('smoke-deploy.mjs', () => {
  it('passes --strict against a fully built stack and never prints the gate key', async () => {
    const base = await serve(api('full'));
    const site = await serve(demoSite(true));
    const r = await smoke([base, '--site', site, '--strict'], { SPIGOT_GATE_KEY: GATE_KEY });
    expect(r.out).toContain('SMOKE PASSED');
    expect(r.out).toContain('GPTBot → 402 PAYMENT_REQUIRED');
    expect(r.out).toContain('policy v3');
    expect(r.out).not.toContain(GATE_KEY);
    expect(r.code).toBe(0);
  });

  it('passes with pending steps on a stack where catalog, policy and the gate are not merged', async () => {
    const base = await serve(api('partial'));
    const site = await serve(demoSite(false));
    const r = await smoke([base, '--site', site]);
    expect(r.out).toContain('pending  /v1/catalog not built yet');
    expect(r.out).toContain('pending  /api/gate/policy not built yet');
    expect(r.out).toContain('pending  GPTBot → 200');
    expect(r.out).toContain('SMOKE PASSED (3 pending');
    expect(r.code).toBe(0);
  });

  it('--strict fails the same partial stack', async () => {
    const base = await serve(api('partial'));
    const site = await serve(demoSite(false));
    const r = await smoke([base, '--site', site, '--strict']);
    expect(r.out).toContain('SMOKE FAILED: 3 step(s)');
    expect(r.code).toBe(1);
  });

  it('fails when the API is unhealthy or unreachable', async () => {
    const base = await serve(api('full', false));
    const site = await serve(demoSite(true));
    const bad = await smoke([base, '--site', site], { SPIGOT_GATE_KEY: GATE_KEY });
    expect(bad.out).toContain('FAIL     /api/healthz → 500');
    expect(bad.code).toBe(1);

    const down = await smoke(['http://127.0.0.1:1', '--site', site, '--timeout', '2']);
    expect(down.code).toBe(1);
  });

  it('fails when a gated bot gets something other than 402 or 200', async () => {
    const base = await serve(api('full'));
    const site = await serve((req, res) =>
      /GPTBot/.test(req.headers['user-agent'] ?? '') && req.url?.startsWith('/listings/')
        ? json(res, 500, {})
        : demoSite(true)(req, res),
    );
    const r = await smoke([base, '--site', site], { SPIGOT_GATE_KEY: GATE_KEY });
    expect(r.out).toContain('FAIL     GPTBot → 500');
    expect(r.code).toBe(1);
  });

  it('prints usage without a base URL', async () => {
    const r = await smoke([]);
    expect(r.code).toBe(2);
    expect(r.out).toContain('usage:');
  });
});
