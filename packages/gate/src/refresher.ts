// Policy refresher (features/02 §Design): fetches `GET {apiBase}/api/gate/policy` at boot and
// every 60 s in the background, 2 s timeout, keeping the last good policy. Never on the request
// path: the middleware only reads `state.current`.

import { build402, type Built402 } from './body402.js';
import { parsePolicy, type Policy } from './policy.js';

export interface GateLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface RefresherOptions {
  /** Spigot API origin, e.g. `https://spigot.onrender.com` (SPIGOT_API_BASE). */
  apiBase: string;
  /** Site gate key `gk_…` (SPIGOT_GATE_KEY). Sent as a Bearer token; never logged. */
  gateKey: string;
  intervalMs?: number;
  timeoutMs?: number;
  fetch?: FetchLike;
  logger?: GateLogger;
}

/** A loaded policy with its 402 response prebuilt (static bytes, built once per load). */
export interface LoadedPolicy {
  policy: Policy;
  reply: Built402;
  jsonBytes: Buffer;
  htmlBytes: Buffer;
}

export interface PolicyRefresher {
  /** The last good policy, or null if none has ever loaded (→ the gate passes everything). */
  readonly current: LoadedPolicy | null;
  /** Fetch once now. Resolves true when a new policy was loaded; never rejects. */
  refresh(): Promise<boolean>;
  stop(): void;
}

export const POLICY_INTERVAL_MS = 60_000;
export const GATE_TIMEOUT_MS = 2_000;
// A policy is a few KB; refuse anything absurd rather than parse it.
const MAX_POLICY_BYTES = 256 * 1024;

export const consoleLogger: GateLogger = {
  info: (m) => console.log(`[spigot-gate] ${m}`),
  warn: (m) => console.warn(`[spigot-gate] ${m}`),
};

export function gateUrl(apiBase: string, path: string): string {
  return `${apiBase.replace(/\/+$/, '')}${path}`;
}

/** Compile a policy wire object and prebuild its 402 bodies. Throws on a malformed policy. */
export function loadPolicy(wire: unknown): LoadedPolicy {
  const policy = parsePolicy(wire);
  const reply = build402(policy);
  return {
    policy,
    reply,
    jsonBytes: Buffer.from(reply.json, 'utf8'),
    htmlBytes: Buffer.from(reply.html, 'utf8'),
  };
}

export function startPolicyRefresher(opts: RefresherOptions): PolicyRefresher {
  const url = gateUrl(opts.apiBase, '/api/gate/policy');
  const timeoutMs = opts.timeoutMs ?? GATE_TIMEOUT_MS;
  const doFetch: FetchLike = opts.fetch ?? ((u, init) => fetch(u, init));
  const log = opts.logger ?? consoleLogger;

  let current: LoadedPolicy | null = null;
  let inflight: Promise<boolean> | null = null;
  // Log transitions only, so a down API doesn't print a line every minute.
  let failing = false;

  async function fetchOnce(): Promise<boolean> {
    try {
      const res = await doFetch(url, {
        headers: { authorization: `Bearer ${opts.gateKey}`, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_POLICY_BYTES) throw new Error('policy response too large');
      const loaded = loadPolicy(JSON.parse(text));
      const changed = current?.policy.policyVersion !== loaded.policy.policyVersion;
      current = loaded;
      if (failing || changed) log.info(`policy v${loaded.policy.policyVersion} loaded`);
      failing = false;
      return true;
    } catch (err) {
      if (!failing) {
        const why = err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error';
        log.warn(
          current
            ? `policy refresh failed (${why}); keeping v${current.policy.policyVersion}`
            : `policy not loaded (${why}); passing every request until it loads`,
        );
      }
      failing = true;
      return false;
    }
  }

  function refresh(): Promise<boolean> {
    // One fetch at a time: a slow API never stacks up requests.
    inflight ??= fetchOnce().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  void refresh();
  const timer = setInterval(() => void refresh(), opts.intervalMs ?? POLICY_INTERVAL_MS);
  timer.unref();

  return {
    get current() {
      return current;
    },
    refresh,
    stop: () => clearInterval(timer),
  };
}
