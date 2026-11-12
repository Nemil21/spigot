/**
 * `npm run demo:payout -- --yes` (SP-038): the payout beat in one command. Logic in
 * `./demoPayout.ts`: `payoutRun('MANUAL_DEMO', { thresholdCentsOverride: 100 })`, then the batch
 * and item ids are printed (PayPal's item ids arrive with the status poll / webhook; W09 shows them).
 *
 *   DEMO_MODE=true npm run demo:payout -- --yes
 *
 * Needs DATABASE_URL, SESSION_SECRET and the PayPal settings (PAYPAL_MODE=stub uses FakePayPal).
 * Refuses without `--yes` or DEMO_MODE=true. Exits 1 unless the batch was accepted (PENDING) or
 * there was nothing to pay.
 */
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from '../config.js';
import { createPool } from '../db/index.js';
import { loadDotenv } from '../env.js';
import { payoutPayPal } from '../payouts/deps.js';
import { demoPayout, formatPayout } from './demoPayout.js';
import { assertDemoMode } from './demoReset.js';

loadDotenv();

const { values } = parseArgs({ options: { yes: { type: 'boolean', default: false } } });

let config;
try {
  config = loadConfig(process.env);
  assertDemoMode(config, 'demo:payout');
} catch (err) {
  if (err instanceof ConfigError || (err instanceof Error && err.name === 'DemoResetRefused')) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
if (!values.yes) {
  console.error(
    `demo:payout sends a real ${config.PAYPAL_MODE === 'stub' ? 'FakePayPal' : 'PayPal sandbox'} payout to every publisher with $1+ payable. Re-run with --yes.`,
  );
  process.exit(1);
}

const pool = createPool(config.DATABASE_URL, { max: 4, applicationName: 'spigot-demo-payout' });
let exitCode = 0;
try {
  const { summary } = await demoPayout({ pool, pp: payoutPayPal(config) });
  console.log(formatPayout(summary).join('\n'));
  if (summary.outcome !== 'PENDING' && summary.outcome !== 'NO_ITEMS') exitCode = 1;
} catch (err) {
  console.error(`demo:payout failed: ${err instanceof Error ? err.message : String(err)}`);
  exitCode = 1;
} finally {
  await pool.end();
}
process.exit(exitCode);
