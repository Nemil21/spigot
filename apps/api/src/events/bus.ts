import { randomBytes } from 'node:crypto';
import pg from 'pg';
import {
  parsePublisherEvent,
  PUBLISHER_EVENTS_CHANNEL,
  type PublisherEvent,
} from '@spigot/shared/events';

/**
 * The LISTEN side of the publisher event bus (SP-025; api.md `GET /api/publishers/me/events`).
 *
 * Producers `notify(tx, PUBLISHER_EVENTS_CHANNEL, publisherEvent(…))` inside their business
 * transaction: Postgres delivers on COMMIT, to every listening connection in every process, and
 * drops it on ROLLBACK. Each API process holds exactly **one** dedicated LISTEN connection (not a
 * pool client, not one per stream), opened on the first subscriber, and fans events out in memory
 * by `publisherId`.
 *
 * Every event gets an id `<boot>-<seq>`: `seq` is monotonic in this process, `boot` is random per
 * process, so a `Last-Event-ID` from another process (or from before a restart) is never mistaken
 * for one of ours. The last 5 minutes are kept in a ring for `Last-Event-ID` replay; anything we
 * can't prove complete (unknown boot, aged out, or a LISTEN gap) answers "resync" (refetch all).
 */

export const LISTEN_APPLICATION_NAME = 'spigot-listen';
/** How long events stay replayable for `Last-Event-ID`. */
export const RING_MS = 5 * 60_000;
/** Hard cap on ring size, whatever the rate (a burst of `hits` must not grow memory unbounded). */
export const RING_MAX = 10_000;
export const HEARTBEAT_MS = 15_000;

export interface BusEvent {
  /** SSE `id:` (`<boot>-<seq>`). */
  id: string;
  seq: number;
  event: PublisherEvent;
}

/**
 * Event ids and the replay window. Pure (time is passed in), so it is unit-tested on its own.
 *
 * `floor` is the highest seq that is no longer replayable (aged out, evicted, or lost in a LISTEN
 * gap). A client that last saw seq `n` can be replayed exactly when `floor <= n <= seq`.
 */
export class EventRing {
  readonly boot: string;
  private seq = 0;
  private floor = 0;
  private readonly items: (BusEvent & { t: number })[] = [];

  constructor(
    private readonly windowMs = RING_MS,
    private readonly max = RING_MAX,
    boot = randomBytes(4).toString('hex'),
  ) {
    this.boot = boot;
  }

  /** The id of the newest event (or `<boot>-0`): a resume point for a fresh stream. */
  currentId(): string {
    return `${this.boot}-${this.seq}`;
  }

  get size(): number {
    return this.items.length;
  }

  push(event: PublisherEvent, now: number): BusEvent {
    this.seq += 1;
    const e = { id: `${this.boot}-${this.seq}`, seq: this.seq, event };
    this.items.push({ ...e, t: now });
    this.prune(now);
    return e;
  }

  /**
   * Events may have been lost (LISTEN dropped). Lost events never got a seq, so the gap takes one
   * itself: every id up to and including the current one now resyncs, and the resync frame's id
   * (`currentId()` after this) is a complete resume point.
   */
  gap(): void {
    this.seq += 1;
    this.floor = this.seq;
    this.items.length = 0;
  }

  /**
   * One publisher's events after `lastEventId`, oldest first; `null` means the client must resync
   * (the id isn't ours, is malformed, is in the future, or events after it are gone).
   */
  since(publisherId: string, lastEventId: string, now: number): BusEvent[] | null {
    this.prune(now);
    const m = /^([0-9a-f]+)-(\d{1,15})$/.exec(lastEventId.trim());
    if (!m || m[1] !== this.boot) return null;
    const last = Number(m[2]);
    if (last < this.floor || last > this.seq) return null;
    const out: BusEvent[] = [];
    for (const { t: _t, ...e } of this.items) {
      if (e.seq > last && e.event.publisherId === publisherId) out.push(e);
    }
    return out;
  }

  private prune(now: number): void {
    let drop = 0;
    while (
      drop < this.items.length &&
      (this.items.length - drop > this.max || now - this.items[drop]!.t > this.windowMs)
    ) {
      drop += 1;
    }
    if (drop === 0) return;
    this.floor = this.items[drop - 1]!.seq;
    this.items.splice(0, drop);
  }
}

export interface BusSubscriber {
  onEvent(e: BusEvent): void;
  /** The LISTEN connection came back after a drop: events may have been missed, refetch. */
  onResync(currentId: string): void;
}

export interface BusLogger {
  warn(obj: object, msg: string): void;
}

export interface PublisherEventBusOptions {
  connectionString: string;
  /** Reconnect delays in ms; the last one repeats. */
  backoffMs?: number[];
  /** SSE heartbeat interval for streams on this bus (tests shorten it). */
  heartbeatMs?: number;
  log?: BusLogger;
  ring?: EventRing;
  now?: () => number;
}

const DEFAULT_BACKOFF_MS = [250, 1_000, 2_000, 5_000, 15_000];

export class PublisherEventBus {
  readonly ring: EventRing;
  heartbeatMs: number;
  /** LISTEN connections opened over this bus's lifetime (reconnects included). */
  connectionsOpened = 0;
  private readonly subscribers = new Map<string, Set<BusSubscriber>>();
  private readonly now: () => number;
  private client: pg.Client | null = null;
  private connecting: Promise<void> | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private closed = false;

  constructor(private readonly opts: PublisherEventBusOptions) {
    this.ring = opts.ring ?? new EventRing();
    this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Open the LISTEN connection if it isn't open. Resolves once listening, or after a failed
   * attempt (which then retries in the background; subscribers get a resync when it connects).
   */
  start(): Promise<void> {
    if (this.closed || this.client) return Promise.resolve();
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  get connected(): boolean {
    return this.client !== null;
  }

  get subscriberCount(): number {
    let n = 0;
    for (const set of this.subscribers.values()) n += set.size;
    return n;
  }

  /** Open subscriptions for one publisher (each SSE stream is one). */
  subscribersOf(publisherId: string): number {
    return this.subscribers.get(publisherId)?.size ?? 0;
  }

  /** Subscribe to one publisher's events; returns the unsubscribe function. */
  subscribe(publisherId: string, subscriber: BusSubscriber): () => void {
    let set = this.subscribers.get(publisherId);
    if (!set) {
      set = new Set();
      this.subscribers.set(publisherId, set);
    }
    set.add(subscriber);
    return () => {
      const current = this.subscribers.get(publisherId);
      if (!current) return;
      current.delete(subscriber);
      if (current.size === 0) this.subscribers.delete(publisherId);
    };
  }

  /** See `EventRing.since`. */
  since(publisherId: string, lastEventId: string): BusEvent[] | null {
    return this.ring.since(publisherId, lastEventId, this.now());
  }

  currentId(): string {
    return this.ring.currentId();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.subscribers.clear();
    const client = this.client;
    this.client = null;
    if (client) await client.end().catch(() => {});
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({
      connectionString: this.opts.connectionString,
      application_name: LISTEN_APPLICATION_NAME,
      keepAlive: true,
    });
    // Without a listener an 'error' event would crash the process.
    client.on('error', (err) => this.dropped(client, err));
    client.on('end', () => this.dropped(client));
    client.on('notification', (msg) => {
      if (msg.channel === PUBLISHER_EVENTS_CHANNEL) this.dispatch(msg.payload);
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${PUBLISHER_EVENTS_CHANNEL}`);
    } catch (err) {
      client.removeAllListeners('end');
      await client.end().catch(() => {});
      this.opts.log?.warn({ err: (err as Error).message }, 'publisher events: LISTEN failed');
      this.ring.gap();
      this.scheduleReconnect();
      return;
    }
    if (this.closed) {
      await client.end().catch(() => {});
      return;
    }
    this.client = client;
    this.connectionsOpened += 1;
    this.attempt = 0;
    // Events committed while we weren't listening are lost and never got a seq: close the gap now,
    // so any id handed out during the outage resyncs and the resync frame carries a post-gap id.
    this.ring.gap();
    // Anyone already subscribed was waiting through a gap (a drop, or a failed first attempt).
    this.resyncAll();
  }

  private dropped(client: pg.Client, err?: Error): void {
    if (this.client !== client) return;
    this.client = null;
    client.removeAllListeners('notification');
    client.end().catch(() => {});
    this.ring.gap();
    if (this.closed) return;
    this.opts.log?.warn({ err: err?.message }, 'publisher events: LISTEN connection dropped');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.retryTimer) return;
    const backoff = this.opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    const delay = backoff[Math.min(this.attempt, backoff.length - 1)] ?? 1_000;
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.start();
    }, delay);
    this.retryTimer.unref();
  }

  private dispatch(payload: string | undefined): void {
    const event = payload ? parsePublisherEvent(payload) : null;
    if (!event) {
      this.opts.log?.warn({}, 'publisher events: dropped a malformed event');
      return;
    }
    const e = this.ring.push(event, this.now());
    const set = this.subscribers.get(event.publisherId);
    if (!set) return;
    for (const s of [...set]) {
      try {
        s.onEvent(e);
      } catch (err) {
        this.opts.log?.warn({ err: (err as Error).message }, 'publisher events: subscriber threw');
      }
    }
  }

  private resyncAll(): void {
    const id = this.ring.currentId();
    for (const set of this.subscribers.values()) {
      for (const s of [...set]) {
        try {
          s.onResync(id);
        } catch {
          // A broken stream cleans itself up on close.
        }
      }
    }
  }
}
