/**
 * `npm run demo:decline` (SP-047b): the next AUTO top-up of the demo buyer (default Acme) is
 * declined by PayPal's mock (`PayPal-Mock-Response INSTRUMENT_DECLINED`). Logic in
 * `./demoDecline.ts`.
 *
 *   DEMO_MODE=true ALLOW_MOCK_DECLINE=true npm run demo:decline [-- --buyer <email>] [-- --clear]
 *
 * Needs DATABASE_URL, SESSION_SECRET and a PayPal sandbox base. Refuses (exit 1) without DEMO_MODE,
 * ALLOW_MOCK_DECLINE or a sandbox base.
 */
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from '../config.js';
import { createPool } from '../db/index.js';
import { loadDotenv } from '../env.js';
import { assertMockDeclines, demoDecline, formatDecline } from './demoDecline.js';
import { assertDemoMode } from './demoReset.js';

loadDotenv();

const { values } = parseArgs({
  options: {
    buyer: { type: 'string' },
    clear: { type: 'boolean', default: false },
  },
});

let config;
try {
  config = loadConfig(process.env);
  assertDemoMode(config, 'demo:decline');
  assertMockDeclines(config);
} catch (err) {
  if (err instanceof ConfigError || (err instanceof Error && err.name === 'DemoResetRefused')) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const pool = createPool(config.DATABASE_URL, { max: 1, applicationName: 'spigot-demo-decline' });
let exitCode = 0;
try {
  const r = await demoDecline(pool, {
    ...(values.buyer ? { buyerEmail: values.buyer } : {}),
    clear: values.clear,
  });
  console.log(formatDecline(r).join('\n'));
} catch (err) {
  console.error(`demo:decline failed: ${err instanceof Error ? err.message : String(err)}`);
  exitCode = 1;
} finally {
  await pool.end();
}
process.exit(exitCode);
