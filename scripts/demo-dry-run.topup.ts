// `demo:dry-run` helper (SP-039b): fund buyers with server-side SIM card top-ups. Used for
// `--topup sim` (Acme, standing in for the W11 wallet approval when there is no person at the
// PayPal popup) and to re-fund the SIM buyers on a re-take (demo:reset leaves them drained, so
// sim:buyers can't earn the publisher anything new to pay out). Never used on camera.
//
//   npx tsx --conditions=source scripts/demo-dry-run.topup.ts [--week-start] <amount-cents> <buyer-email>...
//
// `--week-start` dates the ledger txn at the start of the simulated week, as seed:demo does, so
// sim:buyers' week backfill can spend it (it skips buyers "topped up too recently").
//
// Prints one line per buyer: "<email> COMPLETED order <id> / capture <id>". Needs the repo .env.
import { randomUUID } from 'node:crypto';
import { ConfigError, loadConfig } from '../apps/api/src/config.js';
import { createDb, createPool } from '../apps/api/src/db/index.js';
import { simulatedWeekStart } from '../apps/api/src/cli/seedDemo.js';
import { loadDotenv } from '../apps/api/src/env.js';
import { serverCardTopup, topupPayPal } from '../apps/api/src/topups/index.js';

loadDotenv();
const args = process.argv.slice(2);
const weekStart = args[0] === '--week-start';
const [cents, ...emails] = weekStart ? args.slice(1) : args;
if (!cents || !/^\d+$/.test(cents) || !emails.length) {
  console.error('usage: demo-dry-run.topup.ts <amount-cents> <buyer-email>...');
  process.exit(2);
}

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

const pool = createPool(config.DATABASE_URL, { max: 2, applicationName: 'spigot-dry-run-topup' });
const db = createDb(pool);
try {
  for (const email of emails) {
    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM buyers WHERE lower(email) = lower($1)',
      [email],
    );
    if (!rows[0]) throw new Error(`no buyer ${email}`);
    const out = await serverCardTopup(
      { db, config, pp: topupPayPal(config) },
      {
        topupId: randomUUID(),
        buyerId: rows[0].id,
        amountCents: Number(cents),
        trigger: 'SIM',
        ...(weekStart ? { simulatedAt: simulatedWeekStart() } : {}),
      },
    );
    if (out.status !== 'COMPLETED') throw new Error(`${email}: top-up ${out.status}`);
    console.log(
      `${email} ${out.status} order ${out.topup.paypalOrderId} / capture ${out.topup.paypalCaptureId}`,
    );
  }
} finally {
  await pool.end();
}
