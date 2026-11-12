import jsonpatch, { type Operation } from 'fast-json-patch';

/**
 * Deterministic claim checks (features/10 §Claims 2; SP-048a). Pure: the caller loads the call's
 * `served_record_keys`, the record's version history and its schema, and these decide whether
 * Spigot can confirm the claim without a human. `STALE` / `REMOVED` need a targeted re-fetch
 * (SP-048c) and `WRONG_VALUE` needs the publisher, so those always come back unconfirmed here.
 *
 * Everything works from `served_record_keys` + `record_versions`, never `response_body`: the body
 * is purged after 24 h (SP-019), the keys are kept 7 days, the claim window.
 */

export const CLAIM_REASONS = [
  'STALE',
  'WRONG_VALUE',
  'MISSING_FIELD',
  'DUPLICATE',
  'REMOVED',
] as const;
export type ClaimReason = (typeof CLAIM_REASONS)[number];

/** Claims are accepted for 7 days after the call. */
export const CLAIM_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface ServedKey {
  key: string;
  hash: string;
}

export interface VersionRow {
  version: number;
  op: 'add' | 'update' | 'remove';
  patch: unknown;
  hash: string | null;
}

/** `api_calls.served_record_keys` as stored (jsonb); anything malformed is dropped. */
export function parseServedKeys(raw: unknown): ServedKey[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (k): k is ServedKey =>
      typeof k === 'object' &&
      k !== null &&
      typeof (k as ServedKey).key === 'string' &&
      typeof (k as ServedKey).hash === 'string',
  );
}

/**
 * The record's data as it was when `hash` was served: replay the version patches in order and
 * stop at the first live version with that hash. `null` when no version matches (e.g. a
 * `changes.list` call, whose served hashes are of the change, not the record).
 */
export function dataAtHash(versions: readonly VersionRow[], hash: string): unknown {
  let doc: unknown = null;
  for (const v of [...versions].sort((a, b) => a.version - b.version)) {
    if (v.op === 'remove') continue; // data is kept on removal; the next `add` replaces it whole
    if (!Array.isArray(v.patch)) return null;
    try {
      doc = jsonpatch.applyPatch(
        jsonpatch.deepClone(doc),
        v.patch as Operation[],
        false,
        false,
      ).newDocument;
    } catch {
      return null;
    }
    if (v.hash === hash) return doc;
  }
  return null;
}

/**
 * The required fields a buyer was served: `required === true` **and** `visible === true` in the
 * stored schema (`schema_versions.fields`). A hidden field being null is never the buyer's loss.
 */
export function requiredVisibleFields(storedFields: unknown): string[] {
  if (!Array.isArray(storedFields)) return [];
  const out: string[] = [];
  for (const f of storedFields) {
    if (typeof f !== 'object' || f === null) continue;
    const { name, required, visible } = f as {
      name?: unknown;
      required?: unknown;
      visible?: unknown;
    };
    if (typeof name === 'string' && required === true && visible === true) out.push(name);
  }
  return out;
}

/** `MISSING_FIELD`: some required visible field was null (or absent) in the served record. */
export function missingRequired(data: unknown, required: readonly string[]): string[] {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return [];
  const rec = data as Record<string, unknown>;
  return required.filter((name) => rec[name] === null || rec[name] === undefined);
}

/**
 * `DUPLICATE`: another record served earlier in the same call has the same hash. The first
 * occurrence is the original and is never credited as its own duplicate.
 */
export function isDuplicate(served: readonly ServedKey[], key: string): boolean {
  const i = served.findIndex((s) => s.key === key);
  if (i < 0) return false;
  const { hash } = served[i]!;
  return served.slice(0, i).some((s) => s.hash === hash && s.key !== key);
}

export type CheckOutcome =
  | { confirmed: true; detail: Record<string, unknown> }
  | { confirmed: false; detail: Record<string, unknown> };

export interface CheckInput {
  reason: ClaimReason;
  key: string;
  served: readonly ServedKey[];
  versions: readonly VersionRow[];
  storedFields: unknown;
}

/** Run the deterministic check for `reason`. Unconfirmed → the claim stays `OPEN`. */
export function runCheck(input: CheckInput): CheckOutcome {
  switch (input.reason) {
    case 'MISSING_FIELD': {
      const hash = input.served.find((s) => s.key === input.key)?.hash;
      const data = hash === undefined ? null : dataAtHash(input.versions, hash);
      if (data === null)
        return { confirmed: false, detail: { check: 'MISSING_FIELD', found: false } };
      const missing = missingRequired(data, requiredVisibleFields(input.storedFields));
      return missing.length > 0
        ? { confirmed: true, detail: { check: 'MISSING_FIELD', missing } }
        : { confirmed: false, detail: { check: 'MISSING_FIELD', missing } };
    }
    case 'DUPLICATE':
      return { confirmed: isDuplicate(input.served, input.key), detail: { check: 'DUPLICATE' } };
    default:
      // STALE / REMOVED: SP-048c's re-fetch. WRONG_VALUE: triage + publisher (SP-048b).
      return { confirmed: false, detail: { check: 'NONE' } };
  }
}
