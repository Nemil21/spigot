import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent, request } from 'undici';
import { InvalidUrlError, toNormalizedUrl } from './normalizeUrl.js';

/**
 * The crawler's only way to reach a publisher's origin (SP-009a1; features/03 §Logic,
 * features/14 §Security checklist). SP-008a's robots / sitemap / verify checks and SP-009a2's
 * `fetchPage` use this; there is no second implementation.
 *
 * - DNS is resolved once per host per call and the connection is **pinned** to that IP (the
 *   socket's `lookup` returns it), so a second, rebinding answer is never used. TLS still
 *   verifies the certificate against the hostname.
 * - Private, loopback, CGNAT, link-local and metadata addresses are refused. `allowLocal`
 *   (`ALLOW_LOCAL_ORIGINS`, dev only; `loadConfig` forces it off in production) admits loopback /
 *   private / CGNAT / ULA for the local demo site, but never link-local, metadata, unspecified,
 *   multicast or reserved ranges.
 * - Redirects are followed by hand (max 3) and every hop is re-checked: scheme, credentials,
 *   address, and origin (same origin as the site, or the same host upgraded to https).
 * - No cookies are sent; `Set-Cookie` is dropped from the result. 10 s overall timeout (covers
 *   every hop and the body), 5 MB body cap.
 */

export type SafeFetchErrorCode =
  | 'INVALID_URL'
  | 'BLOCKED_ADDRESS'
  | 'OFF_ORIGIN'
  | 'TOO_MANY_REDIRECTS'
  | 'DNS_FAILED'
  | 'TIMEOUT'
  | 'BODY_TOO_LARGE'
  | 'NETWORK';

export class SafeFetchError extends Error {
  constructor(
    readonly code: SafeFetchErrorCode,
    message: string,
    readonly url: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SafeFetchError';
  }
}

/** Resolves a hostname to every address it has (IPv4 and IPv6). Injected in tests. */
export type Resolver = (hostname: string) => Promise<string[]>;

export interface SafeFetchOptions {
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  /** Every hop must be on this origin (or its https upgrade). Default: the request URL's origin. */
  origin?: string;
  /** Admit loopback / private / CGNAT / ULA addresses (`ALLOW_LOCAL_ORIGINS`). Default false. */
  allowLocal?: boolean;
  /** Overall deadline for all hops and the body. Default 10 000 ms. */
  timeoutMs?: number;
  /** Body cap in bytes. Default 5 MB. */
  maxBytes?: number;
  /** Default 3. */
  maxRedirects?: number;
  resolver?: Resolver;
  /** Test seam: replaces the address policy (default `isAddressAllowed(ip, allowLocal)`). */
  addressAllowed?: (ip: string) => boolean;
}

export interface SafeResponse {
  /** Final URL after redirects. */
  url: string;
  status: number;
  /** Lowercase names; repeated headers joined with `, `; no `set-cookie`. */
  headers: Record<string, string>;
  body: Buffer;
  /** URLs that answered with a redirect, in order. */
  redirects: string[];
  /** The IP the final hop connected to. */
  address: string;
}

export const SAFE_FETCH_DEFAULTS = {
  timeoutMs: 10_000,
  maxBytes: 5 * 1024 * 1024,
  maxRedirects: 3,
  userAgent: 'SpigotCrawler/1.0',
} as const;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DROPPED_REQUEST_HEADERS = new Set(['cookie', 'cookie2', 'host']);

// ---------------------------------------------------------------------------------------------
// Address policy

function blockList(v4: string[], v6: string[]): BlockList {
  const list = new BlockList();
  for (const cidr of v4) {
    const [net, bits] = cidr.split('/');
    list.addSubnet(net!, Number(bits), 'ipv4');
  }
  for (const cidr of v6) {
    const [net, bits] = cidr.split('/');
    list.addSubnet(net!, Number(bits), 'ipv6');
  }
  return list;
}

/** Never reachable, even with `allowLocal`: metadata, link-local, unspecified, multicast, reserved. */
const ALWAYS_BLOCKED = blockList(
  [
    '0.0.0.0/8', // "this network"; 0.0.0.0 reaches localhost on Linux
    '169.254.0.0/16', // link-local, incl. 169.254.169.254 cloud metadata
    '100.100.100.200/32', // Alibaba Cloud metadata (inside CGNAT)
    '192.0.0.0/24', // IETF protocol assignments
    '192.0.2.0/24', // TEST-NET-1
    '198.51.100.0/24', // TEST-NET-2
    '203.0.113.0/24', // TEST-NET-3
    '198.18.0.0/15', // benchmarking
    '224.0.0.0/4', // multicast
    '240.0.0.0/4', // reserved, incl. 255.255.255.255
  ],
  [
    '::/128', // unspecified
    'fe80::/10', // link-local
    'fd00:ec2::254/128', // AWS IMDS over IPv6 (inside ULA)
    'ff00::/8', // multicast
    '100::/64', // discard-only
    '2001::/32', // Teredo (tunnels to arbitrary IPv4)
    '2001:db8::/32', // documentation
  ],
);

/** Reachable only with `allowLocal` (the local demo site in dev). */
const LOCAL = blockList(
  [
    '10.0.0.0/8',
    '100.64.0.0/10', // CGNAT
    '127.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
  ],
  [
    '::1/128',
    'fc00::/7', // unique local
    'fec0::/10', // deprecated site-local
  ],
);

/** Expand an IPv6 literal to 8 hextets (handles `::` and a trailing dotted IPv4). */
function ipv6Hextets(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const o = tail.split('.').map(Number);
    if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    s = `${s.slice(0, lastColon + 1)}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const parts = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  const nums = parts.map((p) => (/^[0-9a-f]{1,4}$/.test(p) ? parseInt(p, 16) : NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

const v4FromHextets = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

/** The IPv4 address an IPv6 address carries (mapped, compatible, NAT64, 6to4), if any. */
function embeddedIPv4(h: number[]): string | null {
  const zeros = (from: number, to: number) => h.slice(from, to).every((x) => x === 0);
  if (zeros(0, 5) && h[5] === 0xffff) return v4FromHextets(h[6]!, h[7]!); // ::ffff:a.b.c.d
  if (zeros(0, 6) && (h[6] !== 0 || h[7]! > 1)) return v4FromHextets(h[6]!, h[7]!); // ::a.b.c.d
  if (h[0] === 0x64 && h[1] === 0xff9b && zeros(2, 6)) return v4FromHextets(h[6]!, h[7]!); // NAT64
  if (h[0] === 0x2002) return v4FromHextets(h[1]!, h[2]!); // 6to4
  return null;
}

export type AddressClass = 'public' | 'local' | 'blocked';

/** Classify an IP literal. Anything unparseable is `blocked`. */
export function classifyAddress(ip: string): AddressClass {
  const family = isIP(ip);
  if (family === 4) {
    if (ALWAYS_BLOCKED.check(ip, 'ipv4')) return 'blocked';
    return LOCAL.check(ip, 'ipv4') ? 'local' : 'public';
  }
  if (family === 6) {
    const h = ipv6Hextets(ip);
    if (!h) return 'blocked';
    const v4 = embeddedIPv4(h);
    if (v4) return classifyAddress(v4);
    const canonical = h.map((x) => x.toString(16)).join(':');
    if (ALWAYS_BLOCKED.check(canonical, 'ipv6')) return 'blocked';
    return LOCAL.check(canonical, 'ipv6') ? 'local' : 'public';
  }
  return 'blocked';
}

export function isAddressAllowed(ip: string, allowLocal = false): boolean {
  const c = classifyAddress(ip);
  return c === 'public' || (c === 'local' && allowLocal);
}

// ---------------------------------------------------------------------------------------------
// Fetch

export const systemResolver: Resolver = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => a.address);
};

/** Bare hostname for DNS / `isIP`: `[::1]` → `::1`. */
const bareHost = (url: URL) => url.hostname.replace(/^\[(.*)\]$/, '$1');

/** Origins a hop may be on: `origin`, plus its https upgrade when `origin` is http. */
function allowedOrigins(origin: URL): Set<string> {
  const set = new Set([origin.origin]);
  if (origin.protocol === 'http:' && (origin.port === '' || origin.port === '80')) {
    set.add(`https://${origin.hostname}`);
  }
  return set;
}

/** Drop a response body we won't read; destroying it emits an AbortError nobody should see. */
function discard(body: NodeJS.ReadableStream & { destroy(): void }): void {
  body.on('error', () => {});
  body.destroy();
}

export async function safeFetch(input: string, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const timeoutMs = opts.timeoutMs ?? SAFE_FETCH_DEFAULTS.timeoutMs;
  const maxBytes = opts.maxBytes ?? SAFE_FETCH_DEFAULTS.maxBytes;
  const maxRedirects = opts.maxRedirects ?? SAFE_FETCH_DEFAULTS.maxRedirects;
  const resolver = opts.resolver ?? systemResolver;
  const allowed = opts.addressAllowed ?? ((ip: string) => isAddressAllowed(ip, opts.allowLocal));

  let url: URL;
  let origins: Set<string>;
  try {
    url = toNormalizedUrl(input);
    origins = allowedOrigins(toNormalizedUrl(opts.origin ?? url.origin));
  } catch (err) {
    throw new SafeFetchError('INVALID_URL', (err as Error).message, input, { cause: err });
  }

  const headers: Record<string, string> = {
    'user-agent': SAFE_FETCH_DEFAULTS.userAgent,
    'accept-encoding': 'identity',
  };
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    if (!DROPPED_REQUEST_HEADERS.has(k.toLowerCase())) headers[k.toLowerCase()] = v;
  }

  // hostname → pinned IP for this call. The socket's lookup only ever answers from here.
  const pinned = new Map<string, { address: string; family: 4 | 6 }>();
  const agent = new Agent({
    allowH2: false,
    connect: {
      lookup: ((hostname, options, cb) => {
        const pin = pinned.get(hostname.toLowerCase());
        if (!pin) return cb(new Error(`no pinned address for ${hostname}`), '', 0);
        // net.connect asks for `all` when autoSelectFamily is on (Node's default).
        if (options?.all) (cb as unknown as (e: null, a: (typeof pin)[]) => void)(null, [pin]);
        else cb(null, pin.address, pin.family);
      }) satisfies LookupFunction,
    },
  });

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const fail = (code: SafeFetchErrorCode, message: string, at: URL, cause?: unknown): never => {
    throw new SafeFetchError(code, message, at.toString(), { cause });
  };

  /** Check a hop before any connection is made; returns the IP it will connect to. */
  const checkHop = async (hop: URL): Promise<string> => {
    const host = bareHost(hop);
    // An IP literal is judged first so a redirect to e.g. 169.254.169.254 reports BLOCKED_ADDRESS;
    // a hostname is origin-checked before any DNS query is made for it.
    if (isIP(host) && !allowed(host)) {
      fail('BLOCKED_ADDRESS', `address ${host} is not allowed`, hop);
    }
    if (!origins.has(hop.origin)) fail('OFF_ORIGIN', `${hop.origin} is not the site's origin`, hop);
    if (isIP(host)) return host;
    const key = host.toLowerCase();
    const existing = pinned.get(key);
    if (existing) return existing.address;
    let addresses: string[];
    try {
      addresses = await resolver(host);
    } catch (err) {
      return fail('DNS_FAILED', `could not resolve ${host}`, hop, err);
    }
    if (!addresses.length) fail('DNS_FAILED', `${host} has no addresses`, hop);
    // Refuse the host if any answer is disallowed: round-robin could hand the socket either one.
    const bad = addresses.find((a) => !isIP(a) || !allowed(a));
    if (bad !== undefined) fail('BLOCKED_ADDRESS', `${host} resolves to a disallowed address`, hop);
    const address = addresses[0]!;
    pinned.set(key, { address, family: isIP(address) as 4 | 6 });
    return address;
  };

  const redirects: string[] = [];
  let method = opts.method ?? 'GET';
  try {
    for (;;) {
      const address = await checkHop(url);
      let res: Awaited<ReturnType<typeof request>>;
      try {
        res = await request(url, {
          method,
          headers,
          dispatcher: agent,
          signal: controller.signal,
        });
      } catch (err) {
        if (timedOut) fail('TIMEOUT', `timed out after ${timeoutMs} ms`, url, err);
        return fail('NETWORK', `request failed: ${(err as Error).message}`, url, err);
      }

      const location = res.headers.location;
      if (REDIRECT_STATUSES.has(res.statusCode) && location) {
        discard(res.body);
        if (redirects.length >= maxRedirects) {
          fail('TOO_MANY_REDIRECTS', `more than ${maxRedirects} redirects`, url);
        }
        redirects.push(url.toString());
        let next: URL;
        try {
          next = toNormalizedUrl(Array.isArray(location) ? location[0]! : location, url);
        } catch (err) {
          return fail('INVALID_URL', 'redirect to an invalid URL', url, err);
        }
        if (res.statusCode === 303 && method !== 'HEAD') method = 'GET';
        url = next;
        continue;
      }

      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        discard(res.body);
        fail('BODY_TOO_LARGE', `body is ${declared} bytes (cap ${maxBytes})`, url);
      }
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const chunk of res.body) {
          size += (chunk as Buffer).length;
          if (size > maxBytes) {
            discard(res.body);
            fail('BODY_TOO_LARGE', `body exceeds ${maxBytes} bytes`, url);
          }
          chunks.push(chunk as Buffer);
        }
      } catch (err) {
        if (err instanceof SafeFetchError) throw err;
        if (timedOut) fail('TIMEOUT', `timed out after ${timeoutMs} ms`, url, err);
        return fail('NETWORK', `reading the body failed: ${(err as Error).message}`, url, err);
      }

      const outHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined || k === 'set-cookie') continue;
        outHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
      }
      return {
        url: url.toString(),
        status: res.statusCode,
        headers: outHeaders,
        body: Buffer.concat(chunks),
        redirects,
        address,
      };
    }
  } catch (err) {
    if (err instanceof SafeFetchError) throw err;
    if (err instanceof InvalidUrlError) {
      throw new SafeFetchError('INVALID_URL', err.message, url.toString(), { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
    await agent.destroy().catch(() => {});
  }
}
