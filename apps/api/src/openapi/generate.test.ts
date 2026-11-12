import { readFileSync } from 'node:fs';
import SwaggerParser from '@apidevtools/swagger-parser';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadConfig } from '../config.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';
import {
  DEFAULT_SERVER_URL,
  DOCUMENTED_ROUTES,
  OPENAPI_YAML_PATH,
  generateOpenApi,
  renderOpenApiYaml,
} from './generate.js';

/** SP-023: openapi.yaml is valid OpenAPI 3.1, committed up to date, and covers every `/v1` route. */

type Operation = {
  security?: Record<string, string[]>[];
  parameters?: { name: string; in: string; description?: string }[];
  responses: Record<string, { headers?: Record<string, unknown>; content?: unknown }>;
};
type Doc = {
  openapi: string;
  servers: { url: string }[];
  paths: Record<string, Record<string, Operation>>;
  components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown> };
};

const doc = () => generateOpenApi() as unknown as Doc;
const op = (method: string, path: string) => doc().paths[path]![method]!;
const PAID = [
  '/v1/{site}/datasets/{dataset}/records',
  '/v1/{site}/datasets/{dataset}/records/{key}',
  '/v1/{site}/datasets/{dataset}/changes',
];

describe('SP-023 OpenAPI document', () => {
  it('validates as OpenAPI 3.1 (swagger-parser, refs resolved)', async () => {
    const d = doc();
    expect(d.openapi).toBe('3.1.0');
    // validate() dereferences in place: give it a copy.
    await expect(SwaggerParser.validate(structuredClone(d) as never)).resolves.toBeTruthy();
  });

  it('the committed openapi.yaml equals a fresh render (run `npm run openapi` if this fails)', () => {
    const committed = readFileSync(OPENAPI_YAML_PATH, 'utf8');
    expect(committed, 'openapi.yaml is stale: run `npm run openapi` and commit it').toBe(
      renderOpenApiYaml(),
    );
    expect(parse(committed).servers).toEqual([{ url: DEFAULT_SERVER_URL }]);
  });

  it('render is deterministic', () => {
    expect(renderOpenApiYaml()).toBe(renderOpenApiYaml());
  });

  it('documents exactly DOCUMENTED_ROUTES', () => {
    const documented = Object.entries(doc().paths).flatMap(([path, ops]) =>
      Object.keys(ops).map((m) => `${m.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ':$1')}`),
    );
    expect(documented.sort()).toEqual([...DOCUMENTED_ROUTES].sort());
  });

  it('Bearer security scheme; free routes opt out, paid routes allow keyless (→ 402)', () => {
    const d = doc();
    expect(d.components.securitySchemes.bearerAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    expect(op('get', '/v1/catalog').security).toEqual([]);
    expect(op('get', '/v1/{site}/datasets/{dataset}').security).toEqual([]);
    expect(op('get', '/v1/balance').security).toEqual([{ bearerAuth: [] }]);
    for (const p of PAID) expect(op('get', p).security).toEqual([{ bearerAuth: [] }, {}]);
  });

  it('paid routes: 402/409/410/429 with the error envelope, Spigot-* headers, Idempotency-Key', () => {
    for (const p of PAID) {
      const o = op('get', p);
      for (const status of ['400', '401', '402', '403', '404', '409', '410', '429']) {
        expect(o.responses[status], `${p} ${status}`).toBeDefined();
      }
      expect(JSON.stringify(o.responses['409']!.content)).toContain('ErrorEnvelope');
      expect(JSON.stringify(o.responses['410']!.content)).toContain('ErrorEnvelope');
      expect(JSON.stringify(o.responses['429']!.content)).toContain('ErrorEnvelope');
      expect(Object.keys(o.responses['429']!.headers!)).toContain('Retry-After');
      const body402 = JSON.stringify(o.responses['402']!.content);
      for (const s of ['PaymentRequired', 'InsufficientBalance', 'PriceAboveMax']) {
        expect(body402).toContain(s);
      }
      expect(Object.keys(o.responses['402']!.headers!)).toEqual(
        expect.arrayContaining(['Link', 'Spigot-Price', 'Cache-Control']),
      );
      expect(Object.keys(o.responses['200']!.headers!).sort()).toEqual([
        'Spigot-Balance-Micros',
        'Spigot-Call-Id',
        'Spigot-Charged-Micros',
        'Spigot-Records',
        'Spigot-Replay',
      ]);
      const idem = o.parameters!.find((x) => x.name === 'Idempotency-Key');
      expect(idem?.in).toBe('header');
      expect(idem?.description).toMatch(/only within the same minute/);
    }
  });

  it('documents the filter syntax on records and quote', () => {
    for (const p of [
      '/v1/{site}/datasets/{dataset}/records',
      '/v1/{site}/datasets/{dataset}/quote',
    ]) {
      const f = op('get', p).parameters!.find((x) => x.name === 'filters');
      expect(f).toMatchObject({ in: 'query', style: 'form', explode: true });
      expect(f!.description).toMatch(/field\[op\]=value/);
    }
  });

  it('POST /v1/topups: body, 403 (scope), 409, 422 and 502', () => {
    const o = op('post', '/v1/topups') as Operation & { requestBody: unknown };
    expect(JSON.stringify(o.requestBody)).toContain('TopupRequest');
    for (const s of ['200', '400', '401', '403', '409', '422', '429', '502']) {
      expect(o.responses[s], s).toBeDefined();
    }
  });
});

/**
 * Every registered route with its methods (HEAD / OPTIONS dropped), rebuilt from Fastify's
 * `printRoutes()` tree: each line is `<indent>├── <segment> (GET, HEAD)`, indented 4 columns per
 * level, and a node's full path is its parent's plus its segment.
 */
function routeTable(app: FastifyInstance): { path: string; methods: string[] }[] {
  const prefix: string[] = [];
  const out: { path: string; methods: string[] }[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const m = /^(.*?)[├└]── (\S+)(?: \(([^)]+)\))?$/.exec(line);
    if (!m) continue;
    const depth = m[1]!.length / 4;
    prefix.length = depth;
    const path = (prefix[depth - 1] ?? '') + m[2]!;
    prefix[depth] = path;
    const methods = (m[3] ?? '').split(', ').filter((x) => x && x !== 'HEAD' && x !== 'OPTIONS');
    if (methods.length > 0) out.push({ path, methods });
  }
  return out;
}

describe('SP-023 routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer(loadConfig({ ...REQUIRED_ENV }), { logger: false });
    await app.ready();
  });
  afterAll(() => app.close());

  it('every registered /v1 route is documented (CI fails if routes change without regenerating)', () => {
    const registered = routeTable(app)
      .filter((r) => r.path.startsWith('/v1/'))
      .flatMap((r) => r.methods.map((m) => `${m} ${r.path}`));
    expect(registered.length).toBeGreaterThan(0);
    expect(registered.sort()).toEqual([...DOCUMENTED_ROUTES].sort());
    for (const r of DOCUMENTED_ROUTES) {
      const [method, url] = r.split(' ') as ['GET' | 'POST', string];
      expect(app.hasRoute({ method, url }), r).toBe(true);
    }
  });

  it('GET /v1/openapi.yaml serves the document (no key) with this deployment as the server', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/openapi.yaml' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/yaml/);
    const served = parse(res.body);
    expect(served.servers).toEqual([{ url: app.config.APP_BASE_URL.replace(/\/+$/, '') }]);
    expect(served).toEqual(generateOpenApi({ serverUrl: app.config.APP_BASE_URL }));
  });
});
