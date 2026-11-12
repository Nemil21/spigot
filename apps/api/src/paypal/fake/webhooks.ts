import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { FAKE_PAYPAL_BASE, fakeError, type FakeRequest, type Handled } from './http.js';

/**
 * Fake PayPal webhooks: `emitWebhook` builds a signed delivery, and the fake
 * `verify-webhook-signature` checks it the way PayPal does.
 *
 * PayPal signs `<transmission_id>|<transmission_time>|<webhook_id>|<crc32(raw body)>`. The fake
 * signs the same string (HMAC with a per-instance key instead of PayPal's RSA certificate) and
 * verifies against the **exact bytes** of `webhook_event` in the request. A delivery re-serialised
 * with different spacing changes the CRC and comes back `FAILURE`, as it would from the sandbox.
 * Answers follow SP-003 S11: a bad signature is 200 `FAILURE`, a non-alphanumeric `webhook_id`
 * is 400 `INVALID_REQUEST`.
 */

export const FAKE_WEBHOOK_ID = 'FAKEWEBHOOK0001';

export interface FakeWebhookEvent {
  id: string;
  event_version: string;
  create_time: string;
  resource_type: string;
  resource_version?: string;
  event_type: string;
  summary: string;
  resource: Record<string, unknown>;
  links: { href: string; rel: string; method: string }[];
}

export interface FakeWebhookDelivery {
  event: FakeWebhookEvent;
  /** The body exactly as PayPal would POST it: pass this to `verifyWebhook`, unchanged. */
  rawBody: string;
  /** The `paypal-*` signature headers (lower-case) plus `content-type`. */
  headers: Record<string, string>;
}

export interface EmitWebhookOptions {
  /** `JSON.stringify` spacing of the raw body. Default none (compact, like PayPal). */
  spacing?: number | string;
  /** Event id. Default a fresh `WH-…` id (use the same id to model a redelivery). */
  id?: string;
}

export interface FakeWebhooksOptions {
  webhookId?: string;
  now?: () => Date;
}

const AUTH_ALGO = 'SHA256withRSA';
const SIGNATURE_FIELDS = [
  'auth_algo',
  'cert_url',
  'transmission_id',
  'transmission_sig',
  'transmission_time',
] as const;

/** `resource_type` PayPal puts on each event family. */
function resourceType(eventType: string): string {
  if (eventType.startsWith('PAYMENT.CAPTURE.')) {
    return eventType === 'PAYMENT.CAPTURE.REFUNDED' ? 'refund' : 'capture';
  }
  if (eventType.startsWith('PAYMENT.PAYOUTSBATCH.')) return 'payouts';
  if (eventType.startsWith('PAYMENT.PAYOUTS-ITEM.')) return 'payouts_item';
  if (eventType.startsWith('CHECKOUT.ORDER.')) return 'checkout-order';
  if (eventType.startsWith('CUSTOMER.DISPUTE.')) return 'dispute';
  if (eventType.startsWith('VAULT.')) return 'payment_token';
  return 'unknown';
}

export class FakeWebhooks {
  readonly webhookId: string;
  /** Verification requests answered (any outcome). */
  verifications = 0;
  readonly #now: () => Date;
  readonly #key = randomBytes(32);
  #seq = 0;

  constructor(opts: FakeWebhooksOptions = {}) {
    this.webhookId = opts.webhookId ?? FAKE_WEBHOOK_ID;
    this.#now = opts.now ?? (() => new Date());
  }

  /** A signed delivery of `type` carrying `resource`, as PayPal would POST it to us. */
  emitWebhook(
    type: string,
    resource: Record<string, unknown>,
    opts: EmitWebhookOptions = {},
  ): FakeWebhookDelivery {
    const id = opts.id ?? `WH-${(++this.#seq).toString(36).toUpperCase().padStart(8, '0')}-FAKE`;
    const event: FakeWebhookEvent = {
      id,
      event_version: '1.0',
      create_time: this.#now().toISOString(),
      resource_type: resourceType(type),
      resource_version: '2.0',
      event_type: type,
      summary: `Fake ${type}`,
      resource,
      links: [
        {
          href: `${FAKE_PAYPAL_BASE}/v1/notifications/webhooks-events/${id}`,
          rel: 'self',
          method: 'GET',
        },
      ],
    };
    const rawBody = JSON.stringify(event, null, opts.spacing);
    return { event, rawBody, headers: this.sign(rawBody) };
  }

  /** Signature headers for any raw body (for tests that build their own payloads). */
  sign(rawBody: string, transmissionId: string = randomUUID()): Record<string, string> {
    const transmissionTime = this.#now().toISOString();
    return {
      'content-type': 'application/json',
      'paypal-auth-algo': AUTH_ALGO,
      'paypal-cert-url': `${FAKE_PAYPAL_BASE}/v1/notifications/certs/CERT-FAKE`,
      'paypal-transmission-id': transmissionId,
      'paypal-transmission-time': transmissionTime,
      'paypal-transmission-sig': this.#signature(
        transmissionId,
        transmissionTime,
        this.webhookId,
        rawBody,
      ),
    };
  }

  // ------------------------------------------------------------------ HTTP

  static route(method: string, path: string): { op: 'verify_webhook'; id: string } | null {
    return method === 'POST' && path === '/v1/notifications/verify-webhook-signature'
      ? { op: 'verify_webhook', id: '' }
      : null;
  }

  handle(req: FakeRequest): Handled | null {
    if (!FakeWebhooks.route(req.method, req.path)) return null;
    this.verifications++;
    let parsed: Record<string, unknown>;
    try {
      const v: unknown = JSON.parse(req.rawBody);
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
      parsed = v as Record<string, unknown>;
    } catch {
      return fakeError(400, 'INVALID_REQUEST', 'MALFORMED_REQUEST_JSON');
    }
    const webhookId = parsed.webhook_id;
    if (typeof webhookId !== 'string' || !/^[a-zA-Z0-9]+$/.test(webhookId)) {
      // S11: the sandbox rejects this before looking at the signature.
      return fakeError(400, 'INVALID_REQUEST', 'must match "^[a-zA-Z0-9]+$"');
    }
    for (const field of SIGNATURE_FIELDS) {
      if (typeof parsed[field] !== 'string' || !parsed[field]) {
        return fakeError(400, 'INVALID_REQUEST', 'MISSING_REQUIRED_PARAMETER');
      }
    }
    const rawEvent = topLevelValueText(req.rawBody, 'webhook_event');
    if (rawEvent === null || !rawEvent.startsWith('{')) {
      return fakeError(400, 'INVALID_REQUEST', 'MISSING_REQUIRED_PARAMETER');
    }
    const ok =
      webhookId === this.webhookId &&
      parsed.auth_algo === AUTH_ALGO &&
      this.#matches(
        parsed.transmission_sig as string,
        this.#signature(
          parsed.transmission_id as string,
          parsed.transmission_time as string,
          webhookId,
          rawEvent,
        ),
      );
    return { http: 200, body: { verification_status: ok ? 'SUCCESS' : 'FAILURE' } };
  }

  #signature(transmissionId: string, time: string, webhookId: string, rawBody: string): string {
    const crc = crc32(Buffer.from(rawBody, 'utf8'));
    return createHmac('sha256', this.#key)
      .update(`${transmissionId}|${time}|${webhookId}|${crc}`)
      .digest('base64');
  }

  #matches(given: string, expected: string): boolean {
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

// ---------------------------------------------------------------- raw JSON scanning

const WS = new Set([' ', '\t', '\n', '\r']);

function skipWs(t: string, i: number): number {
  while (i < t.length && WS.has(t[i]!)) i++;
  return i;
}

function skipString(t: string, i: number): number {
  for (i++; i < t.length; i++) {
    if (t[i] === '\\') i++;
    else if (t[i] === '"') return i + 1;
  }
  throw new SyntaxError('unterminated string');
}

function skipValue(t: string, i: number): number {
  const c = t[i];
  if (c === '"') return skipString(t, i);
  if (c === '{' || c === '[') {
    let depth = 0;
    while (i < t.length) {
      const ch = t[i];
      if (ch === '"') {
        i = skipString(t, i);
        continue;
      }
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    throw new SyntaxError('unterminated value');
  }
  while (i < t.length && !WS.has(t[i]!) && t[i] !== ',' && t[i] !== '}' && t[i] !== ']') i++;
  return i;
}

/**
 * The exact source text of a top-level key's value in a JSON object, or null. The fake verifier
 * uses it to see `webhook_event` byte for byte as the client sent it.
 */
export function topLevelValueText(text: string, key: string): string | null {
  try {
    let i = skipWs(text, 0);
    if (text[i] !== '{') return null;
    i = skipWs(text, i + 1);
    while (i < text.length && text[i] !== '}') {
      const keyStart = i;
      i = skipString(text, i);
      const name: unknown = JSON.parse(text.slice(keyStart, i));
      i = skipWs(text, i);
      if (text[i] !== ':') return null;
      i = skipWs(text, i + 1);
      const valueStart = i;
      i = skipValue(text, i);
      if (name === key) return text.slice(valueStart, i);
      i = skipWs(text, i);
      if (text[i] === ',') i = skipWs(text, i + 1);
    }
    return null;
  } catch {
    return null;
  }
}
