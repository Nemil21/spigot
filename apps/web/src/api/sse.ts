import { PUBLISHER_EVENT_TYPES } from '@spigot/shared/events';
import { useEffect, useRef, useState } from 'react';
import { fixturesEnabled } from './fixtures';

/**
 * Server-sent events (SP-024a; features/13 edge case "SSE disconnect"). Same origin, so the session
 * cookie goes along without `withCredentials`.
 *
 * Events carry ids only and the screen refetches (packages/shared/src/events.ts). Two situations
 * mean events may have been missed, and both call `onRefetch` ("refetch everything"):
 *   - the stream comes back after a drop (the browser's own retry sends `Last-Event-ID`; ours is a
 *     fresh connection), and
 *   - the server sends a `resync` event (e.g. its LISTEN connection dropped, SP-025).
 *
 * The browser's EventSource retries by itself while `readyState` is CONNECTING. If it gives up
 * (CLOSED: a non-200 or a non-event-stream response, e.g. during a deploy) we reconnect with
 * capped exponential backoff.
 */
export type EventStreamStatus = 'connecting' | 'open' | 'reconnecting' | 'disabled';

export const RESYNC_EVENT = 'resync';

export interface EventStreamMessage {
  /** The SSE `event:` name (`message` when the frame had none). */
  type: string;
  /** Parsed JSON `data:`, or the raw string when it isn't JSON. */
  data: unknown;
  lastEventId: string;
}

export interface EventStreamHandlers {
  onEvent?: (msg: EventStreamMessage) => void;
  /** Refetch everything: after a reconnect, or on a `resync` event. */
  onRefetch?: () => void;
  onStatus?: (status: EventStreamStatus) => void;
}

export interface EventStreamOptions {
  /** Named events to listen for. Default: every PublisherEvent type. */
  events?: readonly string[];
  /** First manual-reconnect delay; doubles up to `maxDelayMs`. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  createSource?: EventSourceFactory;
}

/** The slice of EventSource we use, so tests can pass a fake. */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((ev: Event) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
  addEventListener(type: string, listener: (ev: MessageEvent) => void): void;
  close(): void;
}
export type EventSourceFactory = (url: string) => EventSourceLike;

const CLOSED = 2;
const defaultFactory: EventSourceFactory = (url) => new EventSource(url);

/** Connects and keeps the stream alive. Returns a function that closes it for good. */
export function connectEventStream(
  url: string,
  handlers: EventStreamHandlers,
  opts: EventStreamOptions = {},
): () => void {
  const {
    events = PUBLISHER_EVENT_TYPES,
    baseDelayMs = 1_000,
    maxDelayMs = 30_000,
    createSource = defaultFactory,
  } = opts;

  let source: EventSourceLike | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let everOpened = false;
  let attempt = 0;

  const status = (s: EventStreamStatus) => handlers.onStatus?.(s);

  const onFrame = (ev: MessageEvent) => {
    if (stopped) return;
    const type = ev.type || 'message';
    if (type === RESYNC_EVENT) {
      handlers.onRefetch?.();
      return;
    }
    handlers.onEvent?.({ type, data: parse(ev.data), lastEventId: ev.lastEventId ?? '' });
  };

  const open = () => {
    if (stopped) return;
    const s = createSource(url);
    source = s;
    s.onopen = () => {
      if (stopped || source !== s) return;
      attempt = 0;
      status('open');
      if (everOpened) handlers.onRefetch?.();
      everOpened = true;
    };
    s.onerror = () => {
      if (stopped || source !== s) return;
      if (s.readyState !== CLOSED) {
        // The browser is retrying by itself; onopen fires again when it's back.
        status('reconnecting');
        return;
      }
      s.close();
      source = null;
      status('reconnecting');
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      attempt += 1;
      timer = setTimeout(() => {
        timer = null;
        open();
      }, delay);
    };
    s.addEventListener('message', onFrame);
    s.addEventListener(RESYNC_EVENT, onFrame);
    for (const name of events) s.addEventListener(name, onFrame);
  };

  status('connecting');
  open();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    source?.close();
    source = null;
  };
}

function parse(data: unknown): unknown {
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

/**
 * React hook over `connectEventStream`. Pass `null` to stay disconnected. Handlers may change on
 * every render without reconnecting. In fixture mode (`VITE_FIXTURES=1`) nothing connects and the
 * status is `disabled`.
 */
export function useEventStream(
  url: string | null,
  handlers: EventStreamHandlers,
  opts: EventStreamOptions & { enabled?: boolean } = {},
): EventStreamStatus {
  const enabled = (opts.enabled ?? !fixturesEnabled()) && url !== null;
  const [status, setStatus] = useState<EventStreamStatus>(enabled ? 'connecting' : 'disabled');
  const ref = useRef(handlers);
  ref.current = handlers;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const eventsKey = (opts.events ?? PUBLISHER_EVENT_TYPES).join(',');

  useEffect(() => {
    if (!enabled || url === null) {
      setStatus('disabled');
      return;
    }
    return connectEventStream(
      url,
      {
        onEvent: (m) => ref.current.onEvent?.(m),
        onRefetch: () => ref.current.onRefetch?.(),
        onStatus: (s) => {
          setStatus(s);
          ref.current.onStatus?.(s);
        },
      },
      optsRef.current,
    );
    // eventsKey: reconnect only when the set of event names actually changes.
  }, [url, enabled, eventsKey]);

  return status;
}
