// Type coercion for extracted values (features/04 §3). Every parser here is strict and
// deterministic (no `Date.parse`, which is engine- and timezone-dependent); a failed coercion
// yields `null`, never a throw.
import type { FieldType } from './spec.js';

export type Scalar = string | number | boolean;
/** A value as it moves through sources and transforms. */
export type Value = Scalar | null | Value[];
/** A coerced field value as stored in `records.data`. */
export type FieldValue = Scalar | string[] | null;

// `URL` is in browsers and Node but not in the ES2022 lib this package builds against, so it is
// looked up on globalThis instead of declared (a global declaration would clash with lib.dom).
interface UrlLike {
  href: string;
  protocol: string;
  pathname: string;
}
type UrlCtor = new (input: string, base?: string) => UrlLike;
const URLCtor = (globalThis as unknown as { URL: UrlCtor }).URL;

const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Strict decimal: `"1875"`, `" 2.5 "`, `"-3"`; not `"1,875"`, `"0x10"`, `""` or `"12 sq ft"`. */
export function parseNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!NUMBER_RE.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** An absolute http(s) URL, normalized; `base` resolves relative input. */
export function parseHttpUrl(v: unknown, base?: string): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  try {
    const u = base === undefined ? new URLCtor(s) : new URLCtor(s, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Last non-empty path segment of an absolute URL (`/listings/2br-x-4471/` → `2br-x-4471`). */
export function lastPathSegment(url: string): string | null {
  try {
    const segments = new URLCtor(url).pathname.split('/').filter(Boolean);
    return segments[segments.length - 1] ?? null;
  } catch {
    return null;
  }
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10,
  nov: 11, dec: 12, january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8,
  september: 9, october: 10, november: 11, december: 12,
};

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function validYmd(y: number, m: number, d: number): boolean {
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function ymd(y: number, m: number, d: number): string | null {
  return validYmd(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null;
}

/**
 * `YYYY-MM-DD`. Accepts ISO dates, the date part of an ISO datetime (as written, no timezone
 * shift), `YYYY/M/D`, US `M/D/YYYY`, `Dec 1, 2026`, `Tuesday, December 1st, 2026`, `1 Dec 2026`.
 */
export function parseDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/\s+/g, ' ');
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(s);
  if (m) return ymd(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (m) return ymd(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return ymd(Number(m[3]), Number(m[1]), Number(m[2]));
  m = /^(?:[a-z]+,? )?([a-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/i.exec(s);
  if (m) {
    const month = MONTHS[m[1]!.toLowerCase()];
    return month ? ymd(Number(m[3]), month, Number(m[2])) : null;
  }
  m = /^(?:[a-z]+,? )?(\d{1,2})(?:st|nd|rd|th)? ([a-z]{3,9})\.?,? (\d{4})$/i.exec(s);
  if (m) {
    const month = MONTHS[m[2]!.toLowerCase()];
    return month ? ymd(Number(m[3]), month, Number(m[1])) : null;
  }
  return null;
}

const DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * UTC ISO 8601 (`2026-12-06T19:00:00.000Z`). Input is ISO 8601 with optional seconds, fraction
 * and offset; no offset means UTC, and a bare date means midnight UTC.
 */
export function parseDateTime(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = DATETIME_RE.exec(v.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [h, mi, sec] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
  const ms = m[7] ? Math.floor(Number(`0.${m[7]}`) * 1000) : 0;
  if (!validYmd(y, mo, d) || h > 23 || mi > 59 || sec > 59) return null;
  let offsetMin = 0;
  const tz = m[8];
  if (tz && tz.toUpperCase() !== 'Z') {
    const sign = tz[0] === '-' ? -1 : 1;
    const digits = tz.slice(1).replace(':', '');
    const oh = Number(digits.slice(0, 2));
    const om = Number(digits.slice(2));
    if (oh > 23 || om > 59) return null;
    offsetMin = sign * (oh * 60 + om);
  }
  const t = Date.UTC(y, mo - 1, d, h, mi, sec, ms) - offsetMin * 60_000;
  return new Date(t).toISOString();
}

const BOOL_WORDS: Record<string, boolean> = {
  true: true, yes: true, y: true, '1': true,
  false: false, no: false, n: false, '0': false,
};

function first(v: Value): Value {
  return Array.isArray(v) ? (v.length ? first(v[0]!) : null) : v;
}

function toStringValue(v: Value): string | null {
  if (typeof v === 'string') return v.trim() ? v : null;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  if (typeof v === 'boolean') return String(v);
  return null;
}

/** Coerce a transformed value to its declared type; anything that doesn't fit becomes `null`. */
export function coerce(value: Value, type: FieldType): FieldValue {
  if (type === 'string[]') {
    const items: string[] = [];
    const collect = (x: Value) => {
      if (Array.isArray(x)) x.forEach(collect);
      else {
        const s = toStringValue(x);
        if (s !== null) items.push(s);
      }
    };
    collect(value);
    return items.length ? items : null;
  }
  const v = first(value);
  switch (type) {
    case 'string':
      return toStringValue(v);
    case 'integer': {
      const n = parseNumber(v);
      return n !== null && Number.isSafeInteger(n) ? n : null;
    }
    case 'number':
      return parseNumber(v);
    case 'boolean':
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : null;
      if (typeof v === 'string') return BOOL_WORDS[v.trim().toLowerCase()] ?? null;
      return null;
    case 'date':
      return parseDate(v);
    case 'datetime':
      return parseDateTime(v);
    case 'url':
      return parseHttpUrl(v);
  }
}
