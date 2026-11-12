/**
 * A second, separate API process for SP-025's two-process SSE test (publisher-events.db.test.ts),
 * as in Holdfast HF-008. Builds the real server from the environment, listens on a free port and
 * prints `PORT=<n>`. Test-only: not built (tsconfig excludes src/test) and never deployed.
 */
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../config.js';
import { buildServer } from '../server.js';

const app = await buildServer(loadConfig(process.env), { logger: false });
await app.listen({ port: 0, host: '127.0.0.1' });
process.stdout.write(`PORT=${(app.server.address() as AddressInfo).port}\n`);

const stop = () => {
  void app.close().finally(() => process.exit(0));
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
