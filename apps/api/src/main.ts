import { ConfigError, loadConfig } from './config.js';
import { createPool, runEvery, type JobHandle } from './db/index.js';
import { loadDotenv } from './env.js';
import { startJobs } from './jobs/index.js';
import { buildServer } from './server.js';

loadDotenv();

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const app = await buildServer(config);

// Background jobs: every `jobs/*.job.ts`, each under SP-002's advisory-locked `runEvery`, so two
// API processes run a tick once. Own small pool, separate from request traffic.
const jobsPool = createPool(config.DATABASE_URL, { max: 2, applicationName: 'spigot-jobs' });
const jobHandles: JobHandle[] = [];
await startJobs((name, everyMs, fn) => {
  jobHandles.push(
    runEvery(jobsPool, name, everyMs, async (tick) => fn(tick), {
      onError: (err) => app.log.error({ job: name, err }, 'job failed'),
    }),
  );
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await Promise.all(jobHandles.map((h) => h.stop()));
  await app.close();
  await jobsPool.end();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.PORT, host: config.HOST });
