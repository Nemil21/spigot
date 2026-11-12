import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ERROR_STATUS } from '@spigot/shared';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';
import { REQUIRED_ENV } from './test/env.js';

describe('API server', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer(loadConfig({ ...REQUIRED_ENV }), { logger: false });
  });
  afterAll(() => app.close());

  it('GET /api/healthz → 200 (route autoloaded from routes/)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('unknown routes 404 with the error envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'No route for GET /api/nope.' },
    });
  });

  it('boots when a plugin directory has no files yet (empty dirs are not emitted by tsc)', async () => {
    const bare = await buildServer(loadConfig({ ...REQUIRED_ENV }), {
      logger: false,
      pluginsDir: '/nonexistent/spigot/plugins',
    });
    expect((await bare.inject({ method: 'GET', url: '/api/healthz' })).statusCode).toBe(200);
    await bare.close();
  });

  it('exposes the config to routes', () => {
    expect(app.config.APP_BASE_URL).toBe('http://localhost:3000');
  });

  it('Fastify client errors keep code and status in line with ERROR_STATUS', async () => {
    const echo = await buildServer(loadConfig({ ...REQUIRED_ENV }), { logger: false });
    echo.post('/echo', async (req) => req.body);
    try {
      for (const [res, code] of [
        [
          await echo.inject({
            method: 'POST',
            url: '/echo',
            headers: { 'content-type': 'application/xml' },
            payload: '<x/>',
          }),
          'VALIDATION_ERROR',
        ],
        [
          await echo.inject({
            method: 'POST',
            url: '/echo',
            headers: { 'content-type': 'application/json' },
            payload: JSON.stringify({ big: 'x'.repeat(1_100_000) }),
          }),
          'VALIDATION_ERROR',
        ],
        [
          await echo.inject({
            method: 'POST',
            url: '/echo',
            headers: { 'content-type': 'application/json' },
            payload: '{not json',
          }),
          'VALIDATION_ERROR',
        ],
      ] as const) {
        expect(res.json().error.code).toBe(code);
        expect(res.statusCode).toBe(ERROR_STATUS[code]);
      }
    } finally {
      await echo.close();
    }
  });
});

describe('client IP (trustProxy)', () => {
  async function ipFor(nodeEnv: 'development' | 'production') {
    const app = await buildServer(loadConfig({ ...REQUIRED_ENV, NODE_ENV: nodeEnv }), {
      logger: false,
    });
    app.get('/ip', async (req) => ({ ip: req.ip }));
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/ip',
        remoteAddress: '10.0.0.1',
        headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.7' },
      });
      return res.json().ip as string;
    } finally {
      await app.close();
    }
  }

  it('ignores a client-sent X-Forwarded-For outside production', async () => {
    expect(await ipFor('development')).toBe('10.0.0.1');
  });

  it("trusts exactly one proxy hop in production (Render's), not the spoofable leftmost value", async () => {
    expect(await ipFor('production')).toBe('203.0.113.7');
  });
});
