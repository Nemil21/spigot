import { spigotGate, type GateLogger } from '@spigot/gate';
import type { RequestHandler } from 'express';

/**
 * Mount point for spigot-gate. createApp installs `gate` after the access log and before
 * every route; with no gate configured it is this no-op.
 */
export const noopGate: RequestHandler = (_req, _res, next) => next();

export interface DemoGate {
  handler: RequestHandler;
  /** Post buffered hit counts now (they also flush every 10 s). Never rejects. */
  flush(): Promise<void>;
  stop(): void;
}

/**
 * spigot-gate from env: `SPIGOT_API_BASE` + `SPIGOT_GATE_KEY` (both come from connecting the
 * site in Spigot), `SPIGOT_GATE_DEMO=1` to honour `X-Spigot-Sim: 1`. Either key missing → the
 * no-op gate, so the site serves normally before it is connected.
 */
export function gateFromEnv(env: NodeJS.ProcessEnv, logger?: GateLogger): DemoGate | null {
  const apiBase = env.SPIGOT_API_BASE?.trim();
  const gateKey = env.SPIGOT_GATE_KEY?.trim();
  if (!apiBase || !gateKey) return null;
  const gate = spigotGate({ apiBase, gateKey, demo: env.SPIGOT_GATE_DEMO === '1', logger });
  return {
    handler: (req, res, next) => gate(req, res, next),
    flush: () => gate.flusher.flush(),
    stop: () => gate.stop(),
  };
}
