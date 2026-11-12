import type { RequestHandler } from 'express';

export interface AccessLogEntry {
  ts: string;
  method: string;
  path: string;
  status: number;
  ua: string;
  /** Requests in flight when this one started, including itself. */
  inflight: number;
  ms: number;
}

export interface AccessLog {
  middleware: RequestHandler;
  stats(): { inFlight: number; maxInFlight: number; total: number };
  reset(): void;
}

/**
 * One JSON line per request to stdout, plus a concurrent-request gauge. SP-009a2 uses
 * `maxInFlight` (or the `inflight` field in the log) to prove the crawler stays ≤ 2 concurrent.
 */
export function createAccessLog(write: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): AccessLog {
  let inFlight = 0;
  let maxInFlight = 0;
  let total = 0;

  const middleware: RequestHandler = (req, res, next) => {
    const started = performance.now();
    inFlight += 1;
    total += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const atStart = inFlight;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      inFlight -= 1;
      const entry: AccessLogEntry = {
        ts: new Date().toISOString(),
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ua: req.get('user-agent') ?? '',
        inflight: atStart,
        ms: Math.round(performance.now() - started),
      };
      write(JSON.stringify(entry));
    };
    res.on('finish', finish);
    res.on('close', finish);
    next();
  };

  return {
    middleware,
    stats: () => ({ inFlight, maxInFlight, total }),
    reset: () => {
      maxInFlight = inFlight;
      total = 0;
    },
  };
}
