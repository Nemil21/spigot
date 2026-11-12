import PQueue from 'p-queue';

/**
 * Per-host politeness queue (SP-009a2; features/03 §Logic 3.4, 7). One queue per origin host in
 * this process, shared by every run and every `fetchPage`, so the crawler never has more than
 * `concurrency` (2) requests in flight to a host, and two request **starts** are at least
 * `minGapMs` apart. `backoffUntil` (from a 429/503 `Retry-After`) holds every start for that
 * host until the given time.
 *
 * Only the network request runs inside the queue; DB writes and hooks happen after the slot is
 * released, so slow extraction never holds a connection slot to the origin.
 */

export const HOST_CONCURRENCY = 2;

export interface HostQueueOptions {
  minGapMs: number;
  /** Default 2; the crawler never asks for more. */
  concurrency?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface HostQueueStats {
  active: number;
  maxActive: number;
  started: number;
  waiting: number;
}

export const realSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

export class HostQueue {
  /** Changeable between runs (a verified origin running our gate gets a shorter gap). */
  minGapMs: number;
  /** Consecutive 429/503 answers from this host; any other answer resets it. */
  rateLimitStreak = 0;

  private readonly queue: PQueue;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private nextStartAt = 0;
  private notBefore = 0;
  private active = 0;
  private maxActive = 0;
  private started = 0;

  constructor(
    readonly host: string,
    opts: HostQueueOptions,
  ) {
    const concurrency = Math.min(opts.concurrency ?? HOST_CONCURRENCY, HOST_CONCURRENCY);
    this.queue = new PQueue({ concurrency });
    this.minGapMs = opts.minGapMs;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? realSleep;
  }

  /** Run `fn` when a slot is free and the gap / back-off allow a new request to start. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    return this.queue.add(async () => {
      await this.waitForStart();
      this.active += 1;
      this.started += 1;
      this.maxActive = Math.max(this.maxActive, this.active);
      try {
        return await fn();
      } finally {
        this.active -= 1;
      }
    }) as Promise<T>;
  }

  /** No request to this host starts before `at` (epoch ms). Never shortens an existing hold. */
  backoffUntil(at: number): void {
    this.notBefore = Math.max(this.notBefore, at);
  }

  stats(): HostQueueStats {
    return {
      active: this.active,
      maxActive: this.maxActive,
      started: this.started,
      waiting: this.queue.size,
    };
  }

  /** Wait until every queued and running request has finished. */
  onIdle(): Promise<void> {
    return this.queue.onIdle();
  }

  private async waitForStart(): Promise<void> {
    // Reserve a start slot, sleep to it, and re-check: a Retry-After that arrived meanwhile wins.
    for (;;) {
      const now = this.now();
      const slot = Math.max(now, this.nextStartAt, this.notBefore);
      if (slot <= now) {
        this.nextStartAt = now + this.minGapMs;
        return;
      }
      this.nextStartAt = slot + this.minGapMs;
      await this.sleep(slot - now);
      if (this.now() >= this.notBefore) return;
    }
  }
}

const queues = new Map<string, HostQueue>();

/** The process-wide queue for `host` (lowercase host[:port]); created on first use. */
export function hostQueueFor(host: string, opts: HostQueueOptions): HostQueue {
  const key = host.toLowerCase();
  let q = queues.get(key);
  if (!q) {
    q = new HostQueue(key, opts);
    queues.set(key, q);
  } else {
    q.minGapMs = opts.minGapMs;
  }
  return q;
}

/** Tests only: forget every host queue. */
export function resetHostQueues(): void {
  queues.clear();
}
