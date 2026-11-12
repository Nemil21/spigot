import { createHash } from 'node:crypto';
import type { Tx } from '../db/tx.js';
import { transition } from '../db/transition.js';
import { ApiError } from '../http/errors.js';

/**
 * Client idempotency for paid calls (data-model rule 4, features/07 §`chargeAndRecord`).
 * `unique(api_key_id, idempotency_key)` on `api_calls` is the lock: the first insert wins, and
 * everyone else with the same key either replays the stored response, gets a 409, or (after a
 * 402) re-attempts the charge on the same row.
 */

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** JSON with object keys sorted at every level, so `{a,b}` and `{b,a}` hash the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      );
    }
    return v;
  });
}

/** `api_calls.request_hash`: sha256 of the canonical request. */
export function requestHash(request: unknown): string {
  return sha256(canonicalJson(request ?? null));
}

export const AUTO_KEY_BUCKET_MS = 60_000;

/**
 * The key for a call whose client sent no `Idempotency-Key`: `auto:` + sha256(key id, request
 * hash, minute bucket). The bucket is deliberate: an accidental double-send within the minute is
 * charged once, but a buyer polling the same query a minute later gets fresh data, not a replay.
 */
export function autoKey(apiKeyId: string, reqHash: string, now: Date = new Date()): string {
  const bucket = Math.floor(now.getTime() / AUTO_KEY_BUCKET_MS);
  return `auto:${sha256(`${apiKeyId}\n${reqHash}\n${bucket}`)}`;
}

const CLIENT_KEY_RE = /^[\x21-\x7e]{1,255}$/;

/** A client-sent key: 1–255 printable ASCII characters, else `400 VALIDATION_ERROR`. */
export function checkClientKey(key: string): string {
  if (!CLIENT_KEY_RE.test(key)) {
    throw new ApiError(
      'VALIDATION_ERROR',
      'Idempotency-Key must be 1-255 printable ASCII characters.',
    );
  }
  return key;
}

/** States whose stored response is final: a retry replays it and never charges again. */
const REPLAYABLE = ['CHARGED', 'NOT_CHARGED', 'PARTIALLY_CREDITED', 'CREDITED'];
/** Not terminal: a retry with the same key and request re-runs the charge on the same row. */
const RETRYABLE = ['PAYMENT_REQUIRED', 'REJECTED'] as const;

export interface NewCall {
  buyerId: string;
  apiKeyId: string;
  channel: 'REST' | 'MCP';
  datasetId: string;
  endpoint: string;
  idempotencyKey: string;
  requestHash: string;
  isSimulated: boolean;
  simulatedAt: Date | null;
}

export interface StoredCall {
  id: string;
  status: string;
  requestHash: string | null;
  httpStatus: number | null;
  responseBody: unknown;
  priceMicros: number;
}

export type CallClaim =
  /** This request owns a `RECEIVED` row (fresh insert, or a re-attempt after a 402). */
  | { kind: 'owned'; callId: string; reattempt: boolean }
  /** A finished call with the same key and request: return its stored response, free. */
  | { kind: 'replay'; call: StoredCall };

/**
 * Insert the `api_calls` row as `RECEIVED`, or resolve the conflict with the existing row:
 * - different `request_hash` → `409 IDEMPOTENCY_MISMATCH`;
 * - finished (`CHARGED`, `NOT_CHARGED`, credited) → replay; if the body was purged (24 h) →
 *   `409 IDEMPOTENCY_KEY_EXPIRED`, never a second charge;
 * - `PAYMENT_REQUIRED` / `REJECTED` → claim it back to `RECEIVED` with a conditional update. Two
 *   racing retries: the loser's UPDATE waits on the winner's row lock, then matches nothing, and
 *   the loop re-reads the winner's committed outcome.
 *
 * A concurrent insert with the same key blocks this INSERT until that transaction ends, so a
 * committed row is always visible to the SELECT that follows (READ COMMITTED).
 */
export async function claimCall(tx: Tx, call: NewCall): Promise<CallClaim> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO api_calls (buyer_id, api_key_id, channel, dataset_id, endpoint, idempotency_key,
                              request_hash, is_simulated, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9::timestamptz, now()))
       ON CONFLICT ON CONSTRAINT api_calls_api_key_id_idempotency_key_key DO NOTHING
       RETURNING id`,
      [
        call.buyerId,
        call.apiKeyId,
        call.channel,
        call.datasetId,
        call.endpoint,
        call.idempotencyKey,
        call.requestHash,
        call.isSimulated,
        call.simulatedAt,
      ],
    );
    if (inserted.rows[0]) return { kind: 'owned', callId: inserted.rows[0].id, reattempt: false };

    const { rows } = await tx.query<StoredCall>(
      `SELECT id, status, request_hash AS "requestHash", http_status AS "httpStatus",
              response_body AS "responseBody", price_micros AS "priceMicros"
       FROM api_calls WHERE api_key_id = $1 AND idempotency_key = $2`,
      [call.apiKeyId, call.idempotencyKey],
    );
    const existing = rows[0];
    // The conflicting insert rolled back between our INSERT and SELECT: try the insert again.
    if (!existing) continue;

    if (existing.requestHash !== call.requestHash) {
      throw new ApiError(
        'IDEMPOTENCY_MISMATCH',
        'This Idempotency-Key was already used for a different request.',
      );
    }
    if (REPLAYABLE.includes(existing.status)) {
      if (existing.responseBody === null || existing.responseBody === undefined) {
        throw new ApiError(
          'IDEMPOTENCY_KEY_EXPIRED',
          'The stored response for this Idempotency-Key has expired. Send a new key to buy again.',
        );
      }
      return { kind: 'replay', call: existing };
    }
    if ((RETRYABLE as readonly string[]).includes(existing.status)) {
      const claimed = await transition(tx, 'api_calls', existing.id, RETRYABLE, 'RECEIVED', {
        http_status: null,
        response_body: null,
      });
      if (claimed) return { kind: 'owned', callId: existing.id, reattempt: true };
      // Another retry claimed it first and has committed its outcome: re-read it.
      continue;
    }
    // RECEIVED is never committed (every path ends the row in another state in the same txn).
    throw new ApiError('STATE_CONFLICT', 'This call is still being processed. Retry shortly.');
  }
  throw new ApiError('STATE_CONFLICT', 'This call is still being processed. Retry shortly.');
}
