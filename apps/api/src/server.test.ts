import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
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
});
