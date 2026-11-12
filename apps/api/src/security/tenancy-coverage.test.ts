import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';
import { routeTable, type RegisteredRoute } from './routeTable.js';
import {
  isTenantScoped,
  loadTenancyCases,
  routeKey,
  staleCases,
  uncoveredRoutes,
  type LoadedCase,
} from './tenancyCases.js';

/**
 * SP-042: the route-table half of the cross-tenant matrix, with no database, so the `check` job
 * fails fast. `tenancy-matrix.db.test.ts` runs every case against Postgres.
 *
 * The meta-tests prove the rule the INDEX relies on: a tenant-scoped route that merges after
 * SP-042 without its own `tenancy/<area>.cases.ts` makes this file fail.
 */

describe('SP-042 tenancy coverage (route table vs tenancy/*.cases.ts)', () => {
  let app: FastifyInstance;
  let routes: RegisteredRoute[];
  let cases: LoadedCase[];

  beforeAll(async () => {
    app = await buildServer(loadConfig({ ...REQUIRED_ENV }), { logger: false });
    await app.ready();
    routes = routeTable(app);
    cases = await loadTenancyCases();
  });
  afterAll(() => app.close());

  it('reads the real route table (every parsed route is registered)', () => {
    expect(routes.length).toBeGreaterThan(50);
    for (const r of routes)
      expect(app.hasRoute({ method: r.method, url: r.url }), routeKey(r)).toBe(true);
    expect(routes.map(routeKey)).toEqual(
      expect.arrayContaining(['GET /api/sites/:id', 'DELETE /api/buyer/keys/:id', 'POST /mcp']),
    );
  });

  it('every tenant-scoped route has a case (add tenancy/<area>.cases.ts for a new one)', () => {
    const missing = uncoveredRoutes(routes, cases).map(routeKey);
    expect(missing, `routes with no tenancy case: ${missing.join(', ')}`).toEqual([]);
  });

  it('every case names a registered route (no stale cases)', () => {
    const stale = staleCases(routes, cases).map((c) => `${c.file}: ${routeKey(c)}`);
    expect(stale).toEqual([]);
  });

  it('no route is cased twice, and every case says who calls it and what must hold', () => {
    const keys = cases.map(routeKey);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
    for (const c of cases) {
      expect(['publisher', 'buyer', 'none'], `${c.file}: ${routeKey(c)}`).toContain(c.as);
      expect(c.expect.length, `${c.file}: ${routeKey(c)}`).toBeGreaterThan(10);
    }
  });

  describe('meta: a new tenant-scoped route without a case file fails the matrix', () => {
    it('a route added after SP-042 (route table built the same way) is reported', async () => {
      // A stand-in for a later route ticket: real Fastify, real printRoutes, same parse.
      const later = Fastify({ logger: false });
      const noop = async () => ({});
      later.get('/api/sites/:id/brand-new', noop);
      later.post('/api/publishers/me/brand-new', noop);
      later.delete('/api/buyer/things/:thingId', noop);
      later.get('/v1/:site/datasets/:dataset/brand-new', noop);
      later.get('/api/healthz-like', noop); // not tenant-scoped: no case needed
      await later.ready();
      const extra = routeTable(later);
      await later.close();

      expect(
        uncoveredRoutes([...routes, ...extra], cases)
          .map(routeKey)
          .sort(),
      ).toEqual([
        'DELETE /api/buyer/things/:thingId',
        'GET /api/sites/:id/brand-new',
        'GET /v1/:site/datasets/:dataset/brand-new',
        'POST /api/publishers/me/brand-new',
      ]);
    });

    it('dropping one ticket’s case file uncovers exactly its routes', () => {
      const withoutSites = cases.filter((c) => c.file !== 'sites.cases.ts');
      expect(uncoveredRoutes(routes, withoutSites).map(routeKey).sort()).toEqual(
        [
          'GET /api/sites',
          'GET /api/sites/:id',
          'POST /api/sites',
          'POST /api/sites/:id/verify',
        ].sort(),
      );
    });

    it('a new case file is picked up by the glob loader (no shared list to edit)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sp042-cases-'));
      try {
        writeFileSync(
          join(dir, 'brand-new.cases.ts'),
          `export const cases = [{ method: 'GET', url: '/api/sites/:id/brand-new', as: 'publisher', expect: "B's site id → 404" }];\n`,
        );
        writeFileSync(join(dir, 'README.md'), 'not a case file\n');
        const loaded = await loadTenancyCases(dir);
        expect(loaded.map((c) => `${c.file} ${routeKey(c)}`)).toEqual([
          'brand-new.cases.ts GET /api/sites/:id/brand-new',
        ]);
        const later: RegisteredRoute = { method: 'GET', url: '/api/sites/:id/brand-new' };
        expect(uncoveredRoutes([...routes, later], [...cases, ...loaded])).toEqual([]);

        writeFileSync(join(dir, 'broken.cases.ts'), 'export const notCases = [];\n');
        await expect(loadTenancyCases(dir)).rejects.toThrow(/broken\.cases\.ts must export/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('isTenantScoped: params or the tenant prefixes, nothing else', () => {
    for (const u of [
      '/api/sites',
      '/api/sites/:id',
      '/api/datasets/:id/approve',
      '/api/publishers/me',
      '/api/publishers/me/earnings',
      '/api/buyer/keys',
      '/c/:site',
      '/admin/payouts/:batchId/reconcile',
    ]) {
      expect(isTenantScoped(u), u).toBe(true);
    }
    for (const u of [
      '/',
      '/api/healthz',
      '/api/auth/me',
      '/mcp',
      '/v1/catalog',
      '/api/buyers',
      '/app*',
    ]) {
      expect(isTenantScoped(u), u).toBe(false);
    }
  });
});
