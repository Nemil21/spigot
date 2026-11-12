import { MissingFeatureConfigError } from '../config.js';
import { callError, isTransient, type PayPalTransport } from './transport.js';

/**
 * Webhook signature check (api.md `pp.verifyWebhook`; SP-059).
 *
 * PayPal signs the delivery over the **raw body** (its CRC32 is part of the signed string), so the
 * event must reach `verify-webhook-signature` byte for byte as delivered. Parsing it and letting
 * `JSON.stringify` rebuild it can change spacing, key order or number formatting, and then
 * verification fails. This module never re-serialises the event: it splices the raw body into the
 * request JSON as a string.
 *
 * SP-003 S11 (dry run): a bad signature is **HTTP 200 with `verification_status: FAILURE`**, so the
 * field decides, never the status code; a `webhook_id` that isn't alphanumeric is 400
 * `INVALID_REQUEST` before any signature check.
 */

/** Webhook headers as Fastify / Node give them (any case). */
export type WebhookHeaders = Record<string, string | string[] | undefined>;

/** Request field → delivery header. */
export const WEBHOOK_SIGNATURE_HEADERS = {
  auth_algo: 'paypal-auth-algo',
  cert_url: 'paypal-cert-url',
  transmission_id: 'paypal-transmission-id',
  transmission_sig: 'paypal-transmission-sig',
  transmission_time: 'paypal-transmission-time',
} as const;

const WEBHOOK_ID = /^[A-Za-z0-9]+$/;

function header(headers: WebhookHeaders, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    const v = Array.isArray(value) ? value[0] : value;
    return v?.trim() || undefined;
  }
  return undefined;
}

/** True when `rawBody` is one JSON object (what PayPal delivers). */
function isJsonObject(rawBody: string): boolean {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/**
 * The `verify-webhook-signature` request body with `webhook_event` = `rawBody` verbatim. Exported
 * for tests and for SP-059's S11 script.
 */
export function verifyRequestBody(
  fields: Record<keyof typeof WEBHOOK_SIGNATURE_HEADERS, string>,
  webhookId: string,
  rawBody: string,
): string {
  const head = Object.entries({ ...fields, webhook_id: webhookId })
    .map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`)
    .join(',');
  return `{${head},"webhook_event":${rawBody}}`;
}

/**
 * `POST /v1/notifications/verify-webhook-signature` for one delivery. Pass the request body exactly
 * as received (Fastify raw body for the webhook route), never `JSON.stringify(request.body)`.
 *
 * Returns true only for `verification_status: SUCCESS`. Missing signature headers or a body that
 * isn't a JSON object → false without calling PayPal. No answer / 5xx / 429 → throws a TRANSIENT
 * `PayPalCallError`, so the route answers 5xx and PayPal redelivers. Any other refusal → false.
 * Throws `MissingFeatureConfigError` when `PAYPAL_WEBHOOK_ID` is unset or not alphanumeric (PayPal
 * would 400 every delivery).
 */
export async function verifyWebhook(
  http: PayPalTransport,
  webhookId: string | undefined,
  headers: WebhookHeaders,
  rawBody: string,
): Promise<boolean> {
  if (!webhookId || !WEBHOOK_ID.test(webhookId)) {
    throw new MissingFeatureConfigError('PayPal webhooks', ['PAYPAL_WEBHOOK_ID']);
  }
  const fields = {} as Record<keyof typeof WEBHOOK_SIGNATURE_HEADERS, string>;
  for (const [field, name] of Object.entries(WEBHOOK_SIGNATURE_HEADERS)) {
    const value = header(headers, name);
    if (!value) return false;
    fields[field as keyof typeof WEBHOOK_SIGNATURE_HEADERS] = value;
  }
  if (typeof rawBody !== 'string' || !isJsonObject(rawBody)) return false;

  // Not a money mutation: no PayPal-Request-Id.
  const res = await http.request(
    'verify_webhook',
    'POST',
    '/v1/notifications/verify-webhook-signature',
    { rawBody: verifyRequestBody(fields, webhookId, rawBody) },
  );
  if (res.http >= 200 && res.http < 300) return res.json.verification_status === 'SUCCESS';
  if (isTransient(res)) throw callError('verify_webhook', res);
  return false;
}
