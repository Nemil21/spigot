// `spigotGate(opts)`: Express / Connect middleware (features/02 §Design). It can never take
// the publisher's site down: no network on the request path, no policy → pass, and any
// exception → pass (counted as FAIL_OPEN). Zero deps, so it types req/res structurally.

import { classify as defaultClassify, type ClassifyInput } from './classify.js';
import { startHitFlusher, type HitDecision, type HitFlusher } from './flusher.js';
import {
  startPolicyRefresher,
  type FetchLike,
  type GateLogger,
  type LoadedPolicy,
  type PolicyRefresher,
} from './refresher.js';
import {
  createSearchVerifier,
  spoofedBotName,
  type SearchVerifier,
  type SearchVerifierOptions,
} from './verifySearch.js';

export interface GateRequest {
  method?: string;
  url?: string;
  /** Express sets `path` and `ip`; plain Node requests fall back to `url` / socket. */
  path?: string;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}

export interface GateResponse {
  statusCode: number;
  readonly headersSent: boolean;
  setHeader(name: string, value: string | number | readonly string[]): unknown;
  getHeader(name: string): string | number | string[] | undefined;
  end(chunk?: Buffer): unknown;
  once(event: 'close', listener: () => void): unknown;
}

export type GateNext = (err?: unknown) => void;
export type GateHandler = (req: GateRequest, res: GateResponse, next: GateNext) => void;

export interface GateOptions {
  /** Spigot API origin (SPIGOT_API_BASE). */
  apiBase: string;
  /** Site gate key `gk_…` (SPIGOT_GATE_KEY). */
  gateKey: string;
  /**
   * Demo mode (SPIGOT_GATE_DEMO=1): requests with `X-Spigot-Sim: 1` are counted as simulated.
   * Off by default, so on a real site nobody can mark their traffic as SIM.
   */
  demo?: boolean;
  policyIntervalMs?: number;
  flushIntervalMs?: number;
  timeoutMs?: number;
  maxKeys?: number;
  fetch?: FetchLike;
  logger?: GateLogger;
  now?: () => number;
  /** Test seam: replaces `classify` (fail-open tests inject a throwing one). */
  classify?: typeof defaultClassify;
  /**
   * Reverse-DNS verification of SEARCH UAs (features/02 rule 5). On by default; `false` turns
   * it off. A SEARCH UA from an IP that failed verification is treated as SCRAPER_TOOL.
   */
  verifySearch?: false | SearchVerifierOptions;
}

export interface SpigotGate extends GateHandler {
  readonly refresher: PolicyRefresher;
  readonly flusher: HitFlusher;
  /** Null when `verifySearch: false`. */
  readonly verifier: SearchVerifier | null;
  /** Stop both background timers (tests, graceful shutdown). */
  stop(): void;
}

/** `botName` for FAIL_OPEN rows: classify threw, so the bot is unknown. */
export const FAIL_OPEN_BOT_NAME = 'unclassified';

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function pathOf(req: GateRequest): string {
  if (typeof req.path === 'string') return req.path;
  const url = req.url ?? '/';
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/** q-value an Accept header gives `type/subtype` (most specific match wins). */
function acceptQ(accept: string, type: string, subtype: string): number {
  let best = -1;
  let q = 0;
  for (const part of accept.split(',')) {
    const [range = '', ...params] = part.trim().toLowerCase().split(';');
    const [t, s] = range.trim().split('/');
    let spec: number;
    if (t === type && s === subtype) spec = 2;
    else if (t === type && s === '*') spec = 1;
    else if (t === '*' && s === '*') spec = 0;
    else continue;
    if (spec <= best) continue;
    best = spec;
    q = 1;
    for (const p of params) {
      const [k, v] = p.trim().split('=');
      if (k === 'q') q = Number(v) || 0;
    }
  }
  return q;
}

/** True when `Accept` prefers `text/html` over `application/json`. JSON wins ties (`*\/*`, curl). */
export function prefersHtml(accept: string | undefined): boolean {
  if (!accept) return false;
  return acceptQ(accept, 'text', 'html') > acceptQ(accept, 'application', 'json');
}

function send402(req: GateRequest, res: GateResponse, loaded: LoadedPolicy): number {
  const html = prefersHtml(first(req.headers.accept));
  const body = html ? loaded.htmlBytes : loaded.jsonBytes;
  const { reply } = loaded;
  res.statusCode = 402; // never 403: well-behaved clients learn there is a paid path
  res.setHeader('Content-Type', html ? reply.contentType.html : reply.contentType.json);
  res.setHeader('Cache-Control', reply.headers['Cache-Control']);
  res.setHeader('Link', reply.headers.Link);
  if (reply.headers['Spigot-Price']) res.setHeader('Spigot-Price', reply.headers['Spigot-Price']);
  res.setHeader('Vary', 'Accept');
  res.setHeader('Content-Length', body.length);
  res.end(req.method === 'HEAD' ? undefined : body);
  return body.length;
}

function contentLength(res: GateResponse): number {
  const v = Number(res.getHeader('content-length'));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export function spigotGate(opts: GateOptions): SpigotGate {
  const refresher = startPolicyRefresher({
    apiBase: opts.apiBase,
    gateKey: opts.gateKey,
    intervalMs: opts.policyIntervalMs,
    timeoutMs: opts.timeoutMs,
    fetch: opts.fetch,
    logger: opts.logger,
  });
  const flusher = startHitFlusher({
    apiBase: opts.apiBase,
    gateKey: opts.gateKey,
    intervalMs: opts.flushIntervalMs,
    timeoutMs: opts.timeoutMs,
    maxKeys: opts.maxKeys,
    fetch: opts.fetch,
    logger: opts.logger,
    now: opts.now,
  });
  const classify = opts.classify ?? defaultClassify;
  const now = opts.now ?? Date.now;
  const demo = opts.demo === true;
  const verifier = opts.verifySearch === false ? null : createSearchVerifier(opts.verifySearch);

  // Avoided bytes for a 402 are estimated from the gated pages this gate has served
  // (data-model.md `bot_hits.bytes`); 0 until one has been served.
  let gatedBytes = 0;
  let gatedPages = 0;

  /** Classify, count and maybe answer 402. Returns true when the request should pass on. */
  function gate(req: GateRequest, res: GateResponse): boolean {
    const loaded = refresher.current;
    if (!loaded) return true; // never loaded → fail open (logged once by the refresher)

    const at = now();
    const isSimulated = demo && first(req.headers['x-spigot-sim']) === '1';
    const input: ClassifyInput = {
      ua: first(req.headers['user-agent']) ?? '',
      ip: req.ip ?? req.socket?.remoteAddress ?? '',
      path: pathOf(req),
      headers: req.headers,
    };
    const gated = loaded.policy.gatedPaths.some((re) => re.test(input.path));
    let r = classify(input, loaded.policy);
    // Rule 5: a cache read only; an unknown IP passes while its lookup runs in the background.
    // Simulated demo traffic is never verified (sim:bots sends search UAs from ordinary IPs).
    if (
      r.category === 'SEARCH' &&
      verifier !== null &&
      !isSimulated &&
      verifier.check(input.ip, r.botName) === 'FAILED'
    ) {
      r = {
        category: 'SCRAPER_TOOL',
        botName: spoofedBotName(r.botName),
        decision: gated ? loaded.policy.decisions.SCRAPER_TOOL : 'PASS',
      };
    }

    if (r.decision === 'QUOTE') {
      send402(req, res, loaded);
      const estimate = gatedPages > 0 ? Math.round(gatedBytes / gatedPages) : 0;
      flusher.add({ ...r, decision: 'QUOTE_402', bytes: estimate, isSimulated, at });
      return false;
    }

    const decision: HitDecision = r.decision;
    res.once('close', () => {
      try {
        const bytes = contentLength(res);
        if (gated && bytes > 0 && res.statusCode === 200) {
          gatedBytes += bytes;
          gatedPages += 1;
        }
        flusher.add({ ...r, decision, bytes, isSimulated, at });
      } catch {
        // counting must never throw into the response
      }
    });
    return true;
  }

  const handler: GateHandler = (req, res, next) => {
    let pass: boolean;
    try {
      pass = gate(req, res);
    } catch {
      try {
        flusher.add({
          category: 'UNKNOWN',
          botName: FAIL_OPEN_BOT_NAME,
          decision: 'FAIL_OPEN',
          bytes: 0,
          isSimulated: demo && first(req.headers['x-spigot-sim']) === '1',
        });
      } catch {
        // ignore: the request still passes
      }
      // A 402 already partly written is ours to finish; otherwise pass.
      pass = !res.headersSent;
    }
    // Outside the try: an error from downstream must not be mistaken for a gate failure.
    if (pass) next();
  };

  return Object.assign(handler, {
    refresher,
    flusher,
    verifier,
    stop() {
      refresher.stop();
      flusher.stop();
    },
  });
}
