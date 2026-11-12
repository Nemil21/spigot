import type { Config } from '../config.js';
import { createDb, createPool, type Db } from '../db/index.js';
import { defaultJobDeps } from '../jobs/deps.js';
import { createPayPalClient, type MoneyOutClient } from '../paypal/index.js';
import type { WebhookContext } from './paypal.js';

/**
 * What SP-059's route and job use. The verifier is `createPayPalClient(config).verifyWebhook`
 * (`PAYPAL_MODE=stub` → the shared FakePayPal, which signs what `fake.emitWebhook` returns).
 *
 * The job gets its own pool (3 connections): an event's transaction holds one connection while a
 * handler may capture an order and credit it on another (`captureTopup` writes in its own
 * transactions), so it must not share SP-019's 2-connection jobs pool with the other jobs.
 * Under vitest the job does nothing until a test calls `setWebhookDeps`.
 */
export type WebhookVerifier = Pick<MoneyOutClient, 'verifyWebhook'>;

let overrideVerifier: WebhookVerifier | undefined;
let overrideDeps: WebhookContext | undefined;
const verifiers = new WeakMap<Config, WebhookVerifier>();
let cachedDb: Db | undefined;

export function webhookVerifier(config: Config): WebhookVerifier {
  if (overrideVerifier) return overrideVerifier;
  let v = verifiers.get(config);
  if (!v) {
    v = createPayPalClient(config);
    verifiers.set(config, v);
  }
  return v;
}

/** Deps for `jobs/webhook-process.job.ts`, or `null` when jobs are off (vitest). */
export function webhookJobDeps(): WebhookContext | null {
  if (overrideDeps) return overrideDeps;
  const deps = defaultJobDeps();
  if (!deps) return null;
  cachedDb ??= createDb(
    createPool(deps.config.DATABASE_URL, { max: 3, applicationName: 'spigot-webhooks' }),
  );
  return { db: cachedDb, pp: deps.pp, config: deps.config };
}

/** Tests: swap the route's verifier and the job's deps (`undefined` restores the defaults). */
export function setWebhookDeps(
  over: { verifier?: WebhookVerifier | undefined; job?: WebhookContext | undefined } = {},
): void {
  overrideVerifier = over.verifier;
  overrideDeps = over.job;
}
