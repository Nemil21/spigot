import type pg from 'pg';
import { tryAdvisoryLock } from './locks.js';

/**
 * In-process interval jobs that run once per tick across every API process (SP-002).
 *
 * Time is cut into ticks of `everyMs` (tick = floor(epochMs / everyMs)); each process wakes at
 * every tick boundary and:
 *   1. takes the session lock `job:<name>` with `pg_try_advisory_lock` (busy -> skip, so a
 *      slow run never overlaps the next one, in this process or another);
 *   2. claims the tick in `job_ticks` (`last_tick < tick`), so a process whose timer fires a
 *      little later than another's doesn't run the same tick again;
 *   3. runs `fn`.
 * Jobs self-register from `jobs/*.job.ts` (SP-001a's loader calls this).
 */
export interface JobHandle {
  /** Stop scheduling and wait for an in-flight run to finish. */
  stop(): Promise<void>;
}

export interface RunEveryOptions {
  /** Called when `fn` throws. Default: log the job name and error message. */
  onError?: (err: unknown) => void;
  /** Called after each tick this process ran (tests and metrics). */
  onRun?: (tick: number) => void;
  /** Called once this process's attempt at a tick has finished: ran, skipped or failed (tests). */
  onSettled?: (tick: number) => void;
}

const NAME_RE = /^[a-z][a-z0-9_.:-]*$/i;

/**
 * One tick of one job: lock, claim the tick, run. Returns `true` if this call ran `fn`,
 * `false` if another run holds the lock or the tick was already run.
 */
export async function runJobTick(
  pool: pg.Pool,
  name: string,
  tick: number,
  fn: () => Promise<void>,
): Promise<boolean> {
  const lock = await tryAdvisoryLock(pool, `job:${name}`);
  if (!lock) return false;
  try {
    const claimed = await lock.client.query(
      `INSERT INTO job_ticks (name, last_tick) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET last_tick = EXCLUDED.last_tick, last_run_at = now()
         WHERE job_ticks.last_tick < EXCLUDED.last_tick`,
      [name, tick],
    );
    if (claimed.rowCount === 0) return false;
    await fn();
    return true;
  } finally {
    await lock.release();
  }
}

export function runEvery(
  pool: pg.Pool,
  name: string,
  everyMs: number,
  fn: () => Promise<void>,
  opts: RunEveryOptions = {},
): JobHandle {
  if (!NAME_RE.test(name)) throw new Error(`runEvery: bad job name ${name}`);
  if (!Number.isInteger(everyMs) || everyMs < 10) throw new Error(`runEvery: bad interval ${everyMs}`);
  const onError =
    opts.onError ??
    ((err: unknown) => console.error(`[job ${name}] ${err instanceof Error ? err.message : String(err)}`));

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;

  async function tick(t: number): Promise<void> {
    if (await runJobTick(pool, name, t, fn)) opts.onRun?.(t);
  }

  function schedule(): void {
    if (stopped) return;
    const delay = everyMs - (Date.now() % everyMs);
    timer = setTimeout(() => {
      // setTimeout never fires early, so floor() lands on the tick that just started.
      const t = Math.floor(Date.now() / everyMs);
      if (!inFlight) {
        inFlight = tick(t)
          .catch(onError)
          .finally(() => {
            inFlight = undefined;
            opts.onSettled?.(t);
          });
      }
      schedule();
    }, delay);
    timer.unref();
  }

  schedule();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}
