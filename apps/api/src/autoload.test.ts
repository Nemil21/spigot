import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { loadJobs, startJobs } from './jobs/index.js';
import { buildServer } from './server.js';
import { REQUIRED_ENV } from './test/env.js';

// The hot-spot rule: a ticket adds a file and edits nothing shared. These tests drop files into
// fresh plugin / route / job directories and check they are picked up with no other change.

const errorsModule = new URL('./http/errors.ts', import.meta.url).pathname;
const zodModule = import.meta.resolve('zod');

let root: string;
const dir = (name: string) => join(root, name);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'spigot-autoload-'));
  for (const d of ['plugins', 'routes', 'jobs']) await mkdir(dir(d));

  await writeFile(
    join(dir('plugins'), 'tag.ts'),
    `export default async function tag(app) {
      app.addHook('onSend', async (_req, reply) => { reply.header('x-plugin', 'loaded'); });
    }`,
  );
  await writeFile(
    join(dir('routes'), 'sample.ts'),
    `export const autoPrefix = '/api/sample';
    export default async function sample(app) {
      app.get('/', async () => ({ sample: true }));
    }`,
  );
  await writeFile(
    join(dir('routes'), 'errors.ts'),
    `import { ApiError } from ${JSON.stringify(errorsModule)};
    import { z } from ${JSON.stringify(zodModule)};
    export default async function errors(app) {
      app.get('/api/boom/api', async () => {
        throw new ApiError(409, 'STATE_CONFLICT', 'Nope.', { reason: 'test' });
      });
      app.get('/api/boom/zod', async () => z.object({ n: z.number() }).parse({ n: 'x' }));
      app.get('/api/boom/crash', async () => { throw new Error('secret internals'); });
    }`,
  );
  await writeFile(
    join(dir('routes'), 'sample.test.ts'),
    `throw new Error('tests are not routes');`,
  );

  await writeFile(
    join(dir('jobs'), 'b-sample.job.ts'),
    `export default { name: 'sample', everyMs: 60_000, run: async () => {} };`,
  );
  await writeFile(
    join(dir('jobs'), 'a-other.job.ts'),
    `export default { name: 'other', everyMs: 5_000, run: () => {} };`,
  );
  await writeFile(join(dir('jobs'), 'helper.ts'), `throw new Error('not a job file');`);
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe('route and plugin autoload', () => {
  it('serves a route file dropped into routes/, with app-wide plugins applied', async () => {
    const app = await buildServer(loadConfig({ ...REQUIRED_ENV }), {
      logger: false,
      pluginsDir: dir('plugins'),
      routesDir: dir('routes'),
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/sample' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ sample: true });
      expect(res.headers['x-plugin']).toBe('loaded');

      const api = await app.inject({ method: 'GET', url: '/api/boom/api' });
      expect(api.statusCode).toBe(409);
      expect(api.json()).toEqual({
        error: { code: 'STATE_CONFLICT', message: 'Nope.', details: { reason: 'test' } },
      });

      const zod = await app.inject({ method: 'GET', url: '/api/boom/zod' });
      expect(zod.statusCode).toBe(400);
      expect(zod.json().error.code).toBe('VALIDATION_ERROR');
      expect(zod.json().error.details.issues[0].path).toBe('n');

      const crash = await app.inject({ method: 'GET', url: '/api/boom/crash' });
      expect(crash.statusCode).toBe(500);
      expect(crash.json().error.code).toBe('INTERNAL_ERROR');
      expect(crash.body).not.toContain('secret internals');
    } finally {
      await app.close();
    }
  });
});

describe('job autoload', () => {
  it('loads every *.job.ts file in name order and ignores other files', async () => {
    const jobs = await loadJobs(dir('jobs'));
    expect(jobs.map((j) => [j.name, j.everyMs])).toEqual([
      ['other', 5_000],
      ['sample', 60_000],
    ]);
  });

  it('starts each job with runEvery', async () => {
    const runEvery = vi.fn();
    await startJobs(runEvery, dir('jobs'));
    expect(runEvery.mock.calls.map((c) => [c[0], c[1], typeof c[2]])).toEqual([
      ['other', 5_000, 'function'],
      ['sample', 60_000, 'function'],
    ]);
  });

  it('rejects a malformed job file and duplicate names', async () => {
    const bad = await mkdtemp(join(tmpdir(), 'spigot-badjobs-'));
    try {
      await writeFile(join(bad, 'x.job.ts'), `export default { name: 'x' };`);
      await expect(loadJobs(bad)).rejects.toThrow(/x\.job\.ts must default-export/);
      const dup = join(bad, 'dup');
      await mkdir(dup);
      await writeFile(join(dup, 'x.job.ts'), `export default { name: 'x', everyMs: 1, run() {} };`);
      await writeFile(join(dup, 'y.job.ts'), `export default { name: 'x', everyMs: 1, run() {} };`);
      await expect(loadJobs(dup)).rejects.toThrow(/Duplicate job name "x"/);
    } finally {
      await rm(bad, { recursive: true, force: true });
    }
  });

  it('the real jobs/ directory loads (empty until tickets add *.job.ts files)', async () => {
    await expect(loadJobs()).resolves.toBeInstanceOf(Array);
  });
});
