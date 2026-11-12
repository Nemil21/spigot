import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { registerErrorHandler } from '../http/errors.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';
import webRoutes from './web.js';

const INDEX = '<!doctype html><div id="root"></div><!-- spa-index -->';

let dist: string;

beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), 'spigot-web-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), INDEX);
  writeFileSync(join(dist, 'favicon.svg'), '<svg/>');
  writeFileSync(join(dist, 'assets', 'index-abc123.js'), 'console.log(1)');
});
afterAll(() => rmSync(dist, { recursive: true, force: true }));

async function build(webDistDir: string | null): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerErrorHandler(app); // as server.ts does: the api.md envelope for 404s
  await app.register(webRoutes, { webDistDir });
  // Another ticket's route next to it, to prove the fallback never shadows real routes.
  app.get('/api/healthz', async () => ({ ok: true }));
  await app.ready();
  return app;
}

const html = { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };

describe('web routes: SPA fallback', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await build(dist);
  });
  afterAll(() => app.close());

  it.each([
    '/',
    '/app',
    '/app/',
    '/app/earnings',
    '/app/datasets/ds_1',
    '/app/admin/audit',
    '/buyers',
    '/buyers/usage',
    '/buyers/topup/tp_1?ok=1',
  ])('GET %s serves index.html', async (url) => {
    const res = await app.inject({ method: 'GET', url, headers: html });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toBe(INDEX);
  });

  it('HEAD on a deep link works', async () => {
    const res = await app.inject({ method: 'HEAD', url: '/app/payouts', headers: html });
    expect(res.statusCode).toBe(200);
  });

  it.each([
    '/c/x',
    '/c/bluebonnet/terms',
    '/v1/catalog',
    '/v1/bluebonnet/datasets/listings/records',
    '/mcp',
    '/api/nope',
    '/admin/audit',
    '/webhooks/paypal',
    '/topups/return?token=EC-1',
    '/application',
    '/buyersx',
    '/index',
    '/app/logo.png',
  ])('GET %s never returns index.html; it 404s as JSON', async (url) => {
    const res = await app.inject({ method: 'GET', url, headers: html });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).not.toContain('spa-index');
    expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('does not answer non-GET methods on SPA paths', async () => {
    const res = await app.inject({ method: 'POST', url: '/app/earnings', payload: {} });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('spa-index');
  });

  it('leaves other routes alone', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/healthz' });
    expect(res.json()).toEqual({ ok: true });
  });

  it('serves hashed assets with a long cache and other files with no-cache', async () => {
    const js = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const icon = await app.inject({ method: 'GET', url: '/favicon.svg' });
    expect(icon.statusCode).toBe(200);
    expect(icon.headers['cache-control']).toBe('no-cache');
  });

  it('a missing asset is a 404, not index.html', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/gone-123.js', headers: html });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('spa-index');
  });
});

describe('web routes: no build', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await build(join(dist, 'does-not-exist'));
  });
  afterAll(() => app.close());

  it('pages answer 503 with a build hint', async () => {
    const res = await app.inject({ method: 'GET', url: '/app/earnings', headers: html });
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatch(/npm run build -w @spigot\/web/);
  });

  it('non-SPA paths still 404 as JSON', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/catalog', headers: html });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});

describe('web routes: loaded by the real server (autoload)', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildServer(loadConfig({ ...REQUIRED_ENV, NODE_ENV: 'test' }), { logger: false });
  });
  afterAll(() => app.close());

  // `/c/:site` itself is SP-033's page (routes/catalog.ts, catalog.db.test.ts).
  it.each(['/c/x/nope', '/v1/nope'])(
    'GET %s is a JSON 404 envelope, never index.html',
    async (url) => {
      const res = await app.inject({ method: 'GET', url, headers: html });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        error: { code: 'NOT_FOUND', message: `No route for GET ${url}.` },
      });
    },
  );

  it('registers the SPA routes (200 with a build, 503 without one)', async () => {
    const res = await app.inject({ method: 'GET', url: '/app/earnings', headers: html });
    expect([200, 503]).toContain(res.statusCode);
    if (res.statusCode === 200) expect(res.body).toContain('<div id="root">');
  });
});
