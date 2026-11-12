import type { RequestHandler } from 'express';

/**
 * Mount point for spigot-gate. createApp installs `gate` after the access log and before
 * every route. Until SP-006b wires `@spigot/gate` in server.ts, it is a no-op.
 */
export const noopGate: RequestHandler = (_req, _res, next) => next();
