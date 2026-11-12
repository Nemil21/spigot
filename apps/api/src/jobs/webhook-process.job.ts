import type { Job } from './index.js';
import { webhookJobDeps } from '../webhooks/deps.js';
import { processPendingWebhooks } from '../webhooks/paypal.js';

/**
 * SP-059: every 5 s, process verified PayPal webhook events still `processed_at IS NULL`, oldest
 * first (`FOR UPDATE SKIP LOCKED`; `processed_at` is set in each handler's transaction).
 */
export const WEBHOOK_PROCESS_EVERY_MS = 5_000;

const job: Job = {
  name: 'webhooks.process',
  everyMs: WEBHOOK_PROCESS_EVERY_MS,
  async run() {
    const deps = webhookJobDeps();
    if (deps) await processPendingWebhooks(deps);
  },
};

export default job;
