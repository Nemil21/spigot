// Canonical JSON + record hash (features/05 §Logic 1; data-model §records.hash).
// `records.hash = sha256(canonicalize(data))` over the extracted fields only: `url` and
// `updated_at` are metadata attached after hashing, so a re-crawl that changes nothing but the
// crawl time keeps the hash and makes no new version (SP-013 sets `records.updated_at` on content
// change only). The hasher is injected so this module stays free of Node APIs (apps/web).

/** Hex SHA-256 of a UTF-8 string, e.g. `nodeSha256` from apps/api/src/extract/adapters.ts. */
export type Hasher = (canonical: string) => string;

function normalize(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    return Object.is(v, -0) ? 0 : v;
  }
  if (typeof v === 'string') return v.normalize('NFC');
  if (typeof v === 'boolean') return v;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (Array.isArray(v)) return v.map(normalize);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = normalize(x);
    }
    return out;
  }
  return null; // bigint, function, symbol: not representable in JSON
}

/**
 * Deterministic JSON: object keys sorted (recursively), no whitespace, `-0` → `0`, non-finite
 * numbers → `null`, `Date` → ISO 8601, strings NFC-normalized, `undefined` keys dropped. Numbers
 * use JSON's shortest round-trip form, so `1`, `1.0` and `1e0` serialize the same.
 */
export function canonicalize(data: unknown): string {
  return JSON.stringify(normalize(data));
}

/** `sha256(canonicalize(data))`, hex. Pass the extracted fields only, never `url`/`updated_at`. */
export function recordHash(data: unknown, sha256: Hasher): string {
  return sha256(canonicalize(data));
}
