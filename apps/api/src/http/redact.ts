import type { FastifyServerOptions } from 'fastify';

/**
 * Log redaction (features/14 §Security checklist: "Logs redact API keys, emails and PayPal
 * tokens"). Pino's `redact` paths cover known headers; the patterns below cover values anywhere in
 * a log line: message strings, merged objects and the request URL (`?token=` on the top-up return
 * link, a key pasted into a query string by mistake).
 */

export const REDACTED = '[redacted]';

const PATTERNS: [RegExp, string][] = [
  // Credentials in query strings or form bodies: ?token=…, &code=…, access_token=…
  [
    /\b(token|code|key|access_token|refresh_token|id_token|client_secret)=[^&\s#"']+/gi,
    `$1=${REDACTED}`,
  ],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, `Bearer ${REDACTED}`],
  [/\bBasic\s+[A-Za-z0-9+/=]{8,}/g, `Basic ${REDACTED}`],
  // Spigot keys: buyer API keys, per-site gate and crawl keys. The prefix stays for debugging.
  [/\bsk_spg_[A-Za-z0-9_-]+/g, `sk_spg_${REDACTED}`],
  [/\b(gk|ck)_[A-Za-z0-9_-]{4,}/g, `$1_${REDACTED}`],
  // PayPal OAuth access tokens and EC- approval tokens.
  [/\bA21AA[A-Za-z0-9_.-]{8,}/g, REDACTED],
  [/\bEC-[A-Z0-9]{8,}\b/g, REDACTED],
  // Email addresses (also URL-encoded: a%40b.com).
  [/[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
];

/** Object keys whose values are always secret or personal, whatever they look like. */
const SECRET_KEY =
  /^(email|payout_?email|payer_?email|receiver|password|password_?hash|secret|token|access_?token|refresh_?token|id_?token|authorization|cookie|set-cookie|session|x-spigot-key)$/i;
/** Keys that name a secret anywhere in them: `PAYPAL_CLIENT_SECRET`, `webhookSecret`, `apiKey` … */
const SECRET_KEY_PART = /secret|password|passwd|api_?key|gate_?key|crawl_?key|private_?key/i;

export function redactString(s: string): string {
  let out = s;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** Deep copy with secrets replaced. Errors keep their message and stack (both redacted). */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object' || depth > 6) return value;
  if (value instanceof Error) {
    const copy: Record<string, unknown> = {
      type: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
    for (const [k, v] of Object.entries(value)) copy[k] = redactEntry(k, v, depth);
    return copy;
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  // Class instances (Fastify's request and reply, streams …) go to pino's serializers untouched.
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = redactEntry(k, v, depth);
  return out;
}

function redactEntry(key: string, value: unknown, depth: number): unknown {
  if (
    (SECRET_KEY.test(key) || SECRET_KEY_PART.test(key)) &&
    value !== null &&
    value !== undefined
  ) {
    return REDACTED;
  }
  return redactValue(value, depth + 1);
}

/**
 * Fastify logger options: header redaction, value redaction on every log call and a redacted
 * `req.url`. `stream` lets tests capture the log lines.
 */
export function loggerOptions(
  level: string,
  stream?: NodeJS.WritableStream,
): NonNullable<FastifyServerOptions['logger']> {
  return {
    level,
    ...(stream ? { stream } : {}),
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-spigot-key"]',
        'res.headers["set-cookie"]',
      ],
      censor: REDACTED,
    },
    serializers: {
      req(req: { method?: string; url?: string; hostname?: string }) {
        return { method: req.method, url: redactString(req.url ?? ''), hostname: req.hostname };
      },
    },
    hooks: {
      logMethod(args, method) {
        const redacted = (args as unknown[]).map((a) => redactValue(a));
        return method.apply(this, redacted as Parameters<typeof method>);
      },
    },
  };
}
