import type { FastifyPluginAsync } from 'fastify';
import { MissingFeatureConfigError } from '../config.js';
import { ApiError } from '../http/errors.js';
import type { WebhookHeaders } from '../paypal/index.js';
import { webhookVerifier } from '../webhooks/deps.js';
import { parsePayPalEvent, recordWebhookEvent } from '../webhooks/paypal.js';

export const PAYPAL_WEBHOOK_PATH = '/webhooks/paypal';

/**
 * `POST /webhooks/paypal` (SP-059; api.md §Webhooks):
 * 1. Verify the signature over the **raw** body: this plugin (encapsulated, so only this route)
 *    keeps every body as the exact string PayPal sent; re-serialised JSON can fail verification.
 *    Bad or missing signature → 401, nothing stored. Verification couldn't run (PayPal down,
 *    `PAYPAL_WEBHOOK_ID` unset) → 5xx, so PayPal redelivers.
 * 2. Insert into `webhook_events` (PK = event id); a redelivery conflicts → 200, skipped.
 * 3. Answer 200 at once. `jobs/webhook-process.job.ts` processes it (durable: a crash after the
 *    insert loses nothing).
 * No session, CSRF or Idempotency-Key: the PayPal signature is the authentication.
 */
const paypalWebhookRoutes: FastifyPluginAsync = async (app) => {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });

  app.post(PAYPAL_WEBHOOK_PATH, async (req, reply) => {
    const rawBody = typeof req.body === 'string' ? req.body : '';
    let verified: boolean;
    try {
      verified = await webhookVerifier(app.config).verifyWebhook(
        req.headers as WebhookHeaders,
        rawBody,
      );
    } catch (err) {
      req.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'paypal webhook verification unavailable',
      );
      if (err instanceof MissingFeatureConfigError) {
        throw new ApiError('PAYPAL_ERROR', 'PayPal webhooks are not configured.');
      }
      throw new ApiError('PAYPAL_ERROR', 'Webhook verification is unavailable.');
    }
    if (!verified) throw new ApiError('UNAUTHENTICATED', 'Invalid webhook signature.');

    // Verified, so PayPal sent it: parse only now, and store the parsed event.
    const event = parsePayPalEvent(JSON.parse(rawBody));
    if (!event) throw new ApiError('VALIDATION_ERROR', 'Not a PayPal webhook event.');
    const recorded = await recordWebhookEvent(app.db.pool, event);
    req.log.info(
      { eventId: event.id, eventType: event.event_type, recorded },
      'paypal webhook received',
    );
    return reply.code(200).send({ received: true, duplicate: recorded === 'DUPLICATE' });
  });
};

export default paypalWebhookRoutes;
