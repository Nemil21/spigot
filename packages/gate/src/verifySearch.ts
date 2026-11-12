// Reverse-DNS verification for search crawlers (features/02 §Classification rules 5, SP-051).
// A SEARCH UA is only trusted once its IP reverse-resolves to the crawler's domain and that
// hostname forward-resolves back to the same IP. It is never on the request path: `check` is
// a synchronous cache read; an unknown IP passes and a lookup is started in the background.
// Verdicts are cached per (bot, IP) for 24 h in a bounded LRU. Zero deps: `node:dns/promises`.

import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';

/** What the gate should do with a SEARCH UA from this IP right now. */
export type SearchVerdict = 'VERIFIED' | 'FAILED' | 'PENDING';

/** The three DNS calls the verifier makes. `node:dns/promises`' `Resolver` fits. */
export interface DnsResolver {
  reverse(ip: string): Promise<string[]>;
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

/**
 * Allowed reverse-DNS domains per SEARCH `botName` (bots.ts). A hostname matches a domain
 * when it equals it or ends with `.` + it.
 */
export const SEARCH_DOMAINS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Googlebot: ['googlebot.com', 'google.com'],
  Bingbot: ['search.msn.com'],
  Applebot: ['applebot.apple.com'],
  DuckDuckBot: ['duckduckgo.com'],
  YandexBot: ['yandex.ru', 'yandex.net', 'yandex.com'],
});

/** `botName` reported for a SEARCH UA whose IP failed verification. */
export function spoofedBotName(botName: string): string {
  return `${botName} (unverified)`;
}

export interface SearchVerifierOptions {
  resolver?: DnsResolver;
  /** Per-query DNS timeout for the default resolver. */
  timeoutMs?: number;
  /** How long VERIFIED and FAILED verdicts are kept. */
  ttlMs?: number;
  /** How long to wait before retrying after a transient DNS error (the IP keeps passing). */
  retryMs?: number;
  /** LRU bound on cached (bot, IP) entries. */
  maxEntries?: number;
  /** Lookups in flight at once; beyond this an unknown IP passes and is tried on a later hit. */
  maxConcurrent?: number;
  domains?: Readonly<Record<string, readonly string[]>>;
  now?: () => number;
}

export interface SearchVerifier {
  /**
   * Synchronous, no I/O beyond starting a background lookup. Unknown, in-flight and
   * unverifiable IPs return PENDING (the caller passes the request).
   */
  check(ip: string, botName: string): SearchVerdict;
  /** Resolves when every lookup started so far has settled (tests, shutdown). */
  idle(): Promise<void>;
  readonly size: number;
}

export const SEARCH_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULTS = {
  timeoutMs: 3_000,
  retryMs: 5 * 60 * 1000,
  maxEntries: 10_000,
  maxConcurrent: 8,
};

// DNS answers that say "no such record": the IP has no PTR or the name no A/AAAA.
const DEFINITE_MISS = new Set(['ENOTFOUND', 'ENODATA', 'NOTFOUND', 'NODATA']);

type Outcome = 'VERIFIED' | 'FAILED' | 'RETRY';
interface Entry {
  state: 'VERIFIED' | 'FAILED' | 'RETRY' | 'IN_FLIGHT';
  expiresAt: number;
}

/** `::ffff:1.2.3.4` → `1.2.3.4`; anything else unchanged. */
export function normalizeIp(ip: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return m ? m[1]! : ip;
}

/**
 * Loopback, private, link-local, CGNAT and unique-local addresses. A real crawler never comes
 * from one; a site behind a proxy without `trust proxy` sees every request from one, and
 * failing that IP would 402 all search traffic. So these are never verified (they pass).
 */
export function isNonPublicIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    return (
      lower === '::' ||
      lower === '::1' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      /^fe[89ab]/.test(lower)
    );
  }
  return true; // not an IP at all: nothing to verify
}

function hostMatches(hostname: string, domains: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

function errCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code.replace(/^dns\./i, '').toUpperCase() : '';
}

/** Reverse + forward-confirm one IP. Never throws. */
export async function verifyIp(
  resolver: DnsResolver,
  ip: string,
  domains: readonly string[],
): Promise<Outcome> {
  let hosts: string[];
  try {
    hosts = await resolver.reverse(ip);
  } catch (err) {
    return DEFINITE_MISS.has(errCode(err)) ? 'FAILED' : 'RETRY';
  }
  const candidates = hosts.filter((h) => hostMatches(h, domains));
  if (candidates.length === 0) return 'FAILED';

  // IPv6 compares lowercased text: Node's resolver and req.ip both use the compressed form.
  const v6 = isIP(ip) === 6;
  let transient = false;
  for (const host of candidates) {
    try {
      const addrs = await (v6 ? resolver.resolve6(host) : resolver.resolve4(host));
      const want = v6 ? ip.toLowerCase() : ip;
      if (addrs.some((a) => (v6 ? a.toLowerCase() : a) === want)) return 'VERIFIED';
    } catch (err) {
      if (!DEFINITE_MISS.has(errCode(err))) transient = true;
    }
  }
  return transient ? 'RETRY' : 'FAILED';
}

export function createSearchVerifier(opts: SearchVerifierOptions = {}): SearchVerifier {
  const ttlMs = opts.ttlMs ?? SEARCH_VERIFY_TTL_MS;
  const retryMs = opts.retryMs ?? DEFAULTS.retryMs;
  const maxEntries = Math.max(1, opts.maxEntries ?? DEFAULTS.maxEntries);
  const maxConcurrent = Math.max(1, opts.maxConcurrent ?? DEFAULTS.maxConcurrent);
  const domains = opts.domains ?? SEARCH_DOMAINS;
  const now = opts.now ?? Date.now;
  let resolver = opts.resolver;

  // Map iteration order is insertion order: re-inserting on use makes it an LRU.
  const cache = new Map<string, Entry>();
  const inFlight = new Set<Promise<void>>();

  function put(key: string, entry: Entry): void {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value as string;
      cache.delete(oldest);
    }
  }

  function start(key: string, ip: string, allowed: readonly string[]): void {
    if (inFlight.size >= maxConcurrent) return; // try again on a later hit
    resolver ??= new Resolver({ timeout: opts.timeoutMs ?? DEFAULTS.timeoutMs, tries: 2 });
    put(key, { state: 'IN_FLIGHT', expiresAt: Number.POSITIVE_INFINITY });
    const p: Promise<void> = verifyIp(resolver, ip, allowed)
      .catch((): Outcome => 'RETRY')
      .then((outcome) => {
        const at = now();
        put(key, { state: outcome, expiresAt: at + (outcome === 'RETRY' ? retryMs : ttlMs) });
      })
      .finally(() => inFlight.delete(p));
    inFlight.add(p);
  }

  return {
    check(rawIp, botName) {
      const allowed = domains[botName];
      if (!allowed) return 'PENDING';
      const ip = normalizeIp(rawIp);
      if (isNonPublicIp(ip)) return 'PENDING';

      const key = `${botName} ${ip}`;
      const hit = cache.get(key);
      if (hit && hit.expiresAt > now()) {
        if (hit.state === 'VERIFIED' || hit.state === 'FAILED') {
          put(key, hit); // refresh LRU position
          return hit.state;
        }
        return 'PENDING'; // in flight or waiting out a transient error
      }
      start(key, ip, allowed);
      return 'PENDING';
    },
    async idle() {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
    get size() {
      return cache.size;
    },
  };
}
