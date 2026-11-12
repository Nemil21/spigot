import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectEventStream,
  useEventStream,
  type EventSourceLike,
  type EventStreamHandlers,
} from './sse';

class FakeSource implements EventSourceLike {
  static all: FakeSource[] = [];
  readyState = 0;
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  closed = false;
  listeners = new Map<string, ((ev: MessageEvent) => void)[]>();
  constructor(readonly url: string) {
    FakeSource.all.push(this);
  }
  addEventListener(type: string, l: (ev: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  /** Drop; `giveUp` = the browser stopped retrying (readyState CLOSED). */
  drop(giveUp = false) {
    this.readyState = giveUp ? 2 : 0;
    this.onerror?.(new Event('error'));
  }
  emit(type: string, data: string, lastEventId = '') {
    const ev = new MessageEvent(type, { data, lastEventId });
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
}

const factory = (url: string) => new FakeSource(url);
const last = () => FakeSource.all.at(-1)!;

function handlers() {
  return {
    onEvent: vi.fn<NonNullable<EventStreamHandlers['onEvent']>>(),
    onRefetch: vi.fn(),
    onStatus: vi.fn(),
  };
}

beforeEach(() => {
  FakeSource.all = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('connectEventStream', () => {
  it('delivers named PublisherEvents with parsed JSON', () => {
    const h = handlers();
    connectEventStream('/api/publishers/me/events', h, { createSource: factory });
    last().open();
    last().emit('call.charged', '{"type":"call.charged","ids":["c1"]}', '42');
    expect(h.onEvent).toHaveBeenCalledWith({
      type: 'call.charged',
      data: { type: 'call.charged', ids: ['c1'] },
      lastEventId: '42',
    });
    expect(h.onRefetch).not.toHaveBeenCalled();
    expect(h.onStatus.mock.calls.map((c) => c[0])).toEqual(['connecting', 'open']);
  });

  it('treats a `resync` event as "refetch everything"', () => {
    const h = handlers();
    connectEventStream('/e', h, { createSource: factory });
    last().open();
    last().emit('resync', '{}');
    expect(h.onRefetch).toHaveBeenCalledTimes(1);
    expect(h.onEvent).not.toHaveBeenCalled();
  });

  it('refetches when the browser reconnects by itself, not on the first open', () => {
    const h = handlers();
    connectEventStream('/e', h, { createSource: factory });
    last().open();
    expect(h.onRefetch).not.toHaveBeenCalled();
    last().drop();
    expect(h.onStatus).toHaveBeenLastCalledWith('reconnecting');
    last().open();
    expect(h.onRefetch).toHaveBeenCalledTimes(1);
    expect(FakeSource.all).toHaveLength(1);
  });

  it('reconnects with backoff when the browser gives up, then refetches', () => {
    const h = handlers();
    connectEventStream('/e', h, { createSource: factory, baseDelayMs: 1000, maxDelayMs: 3000 });
    last().open();
    last().drop(true);
    expect(FakeSource.all[0]!.closed).toBe(true);
    vi.advanceTimersByTime(999);
    expect(FakeSource.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSource.all).toHaveLength(2);
    last().drop(true); // still down: 2 s
    vi.advanceTimersByTime(2000);
    expect(FakeSource.all).toHaveLength(3);
    last().drop(true); // capped at 3 s
    vi.advanceTimersByTime(2999);
    expect(FakeSource.all).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(FakeSource.all).toHaveLength(4);
    last().open();
    expect(h.onRefetch).toHaveBeenCalledTimes(1);
    last().drop(true); // backoff reset after a successful open
    vi.advanceTimersByTime(1000);
    expect(FakeSource.all).toHaveLength(5);
  });

  it('a first connection that never opened still refetches once it does', () => {
    const h = handlers();
    connectEventStream('/e', h, { createSource: factory, baseDelayMs: 10 });
    last().drop(true);
    vi.advanceTimersByTime(10);
    last().open();
    // Nothing was loaded from the stream before, so the first open is not a "reconnect".
    expect(h.onRefetch).not.toHaveBeenCalled();
  });

  it('stops for good on close: no timers, no events, source closed', () => {
    const h = handlers();
    const stop = connectEventStream('/e', h, { createSource: factory, baseDelayMs: 10 });
    const s = last();
    s.open();
    s.drop(true);
    stop();
    vi.advanceTimersByTime(1000);
    expect(FakeSource.all).toHaveLength(1);
    s.emit('hits', '{}');
    expect(h.onEvent).not.toHaveBeenCalled();
  });

  it('passes non-JSON data through as a string', () => {
    const h = handlers();
    connectEventStream('/e', h, { createSource: factory, events: ['ping'] });
    last().emit('ping', 'hello');
    expect(h.onEvent).toHaveBeenCalledWith({ type: 'ping', data: 'hello', lastEventId: '' });
  });
});

describe('useEventStream', () => {
  function Probe({ url, onRefetch }: { url: string | null; onRefetch: () => void }) {
    const status = useEventStream(url, { onRefetch }, { createSource: factory, enabled: true });
    return <p>status:{status}</p>;
  }

  it('connects, reports status, uses the latest handler and closes on unmount', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = render(<Probe url="/e" onRefetch={first} />);
    expect(screen.getByText('status:connecting')).toBeInTheDocument();
    act(() => last().open());
    expect(screen.getByText('status:open')).toBeInTheDocument();
    rerender(<Probe url="/e" onRefetch={second} />);
    expect(FakeSource.all).toHaveLength(1); // a new handler does not reconnect
    act(() => last().emit('resync', ''));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    unmount();
    expect(last().closed).toBe(true);
  });

  it('stays disconnected for a null url', () => {
    render(<Probe url={null} onRefetch={vi.fn()} />);
    expect(screen.getByText('status:disabled')).toBeInTheDocument();
    expect(FakeSource.all).toHaveLength(0);
  });
});
