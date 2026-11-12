import { ConfigError, loadConfig } from './config.js';
import { loadDotenv } from './env.js';
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
// Jobs: SP-002 wires `startJobs(runEvery)` from ./jobs/index.js here once its advisory-locked
// `runEvery` exists. After that, jobs are added as `jobs/*.job.ts` files only.

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.PORT, host: config.HOST });
