import type { FastifyPluginAsync } from 'fastify';
import type { ServerResponse } from 'node:http';
import { requirePublisher } from '../auth/publisherAuth.js';
import type { BusEvent } from '../events/bus.js';
import { ApiError } from '../http/errors.js';

/**
 * `GET /api/publishers/me/events` (SP-025; api.md): the signed-in publisher's live dashboard
 * events as server-sent events. Only the session publisher's events, never anyone else's: the
 * stream subscribes by the session id, and nothing in the request can name another publisher.
 *
 * Frames:
 *   id: <boot>-<seq>
 *   event: hits | call.charged | payout.updated | proposal.ready | crawl.progress | …
 *   data: {"publisherId","type","ids","at"}        (ids only; the client refetches)
 *
 * - The stream opens with `retry:` and an `id:` line (no event), so even a quiet stream has a
 *   resume point for the browser's `Last-Event-ID`.
 * - `Last-Event-ID` → that publisher's events since then from the bus's 5-minute ring, or one
 *   `event: resync` (refetch everything) when they can't be replayed. The same `resync` is sent
 *   when this process's LISTEN connection drops and comes back.
 * - A `: ping` comment every 15 s keeps proxies (Render) from closing idle streams.
 */

/** Client reconnect delay sent as `retry:`. */
const RETRY_MS = 3_000;
/** A client this far behind is dropped (it reconnects with `Last-Event-ID`). */
const MAX_BUFFERED_BYTES = 1 << 20;
/**
 * Open streams per publisher (tabs, devices). One request each against the portal rate limit,
 * then long-lived, so this bounds them instead.
 */
export const MAX_STREAMS_PER_PUBLISHER = 20;
export const RESYNC_EVENT = 'resync';

function eventFrame(e: BusEvent): string {
  return `id: ${e.id}\nevent: ${e.event.type}\ndata: ${JSON.stringify(e.event)}\n\n`;
}

function resyncFrame(currentId: string): string {
  return `id: ${currentId}\nevent: ${RESYNC_EVENT}\ndata: {}\n\n`;
}

const publisherEventRoutes: FastifyPluginAsync = async (app) => {
  const bus = app.publisherEvents;
  const open = new Set<ServerResponse>();

  // Streams never end on their own; end them so `app.close()` doesn't wait on them.
  app.addHook('preClose', async () => {
    for (const res of open) res.end();
  });

  app.get('/api/publishers/me/events', async (req, reply) => {
    const publisherId = requirePublisher(req).id;
    await bus.start();
    // Checked after the only await, so the check and the subscribe below can't interleave.
    if (bus.subscribersOf(publisherId) >= MAX_STREAMS_PER_PUBLISHER) {
      throw new ApiError('RATE_LIMITED', 'Too many open live streams; close a tab and retry.');
    }

    const res = reply.raw;
    reply.hijack();
    // The client may have gone while LISTEN was connecting; its 'close' has already fired.
    if (req.raw.destroyed || req.raw.socket?.destroyed || res.destroyed) {
      res.destroy();
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Disable proxy buffering (nginx-style proxies honour this).
      'x-accel-buffering': 'no',
    });
    open.add(res);

    const write = (chunk: string) => {
      if (res.writableEnded || res.destroyed) return;
      if (res.writableLength > MAX_BUFFERED_BYTES) {
        res.destroy();
        return;
      }
      res.write(chunk);
    };

    // Subscribe, read the replay window and write it in one synchronous step, so no event can
    // land between the replay and the live feed (or in both).
    const unsubscribe = bus.subscribe(publisherId, {
      onEvent: (e) => write(eventFrame(e)),
      onResync: (id) => write(resyncFrame(id)),
    });
    const lastEventId = req.headers['last-event-id'];
    write(`retry: ${RETRY_MS}\n: connected\n`);
    if (typeof lastEventId === 'string' && lastEventId !== '') {
      const missed = bus.since(publisherId, lastEventId);
      if (missed === null) {
        write('\n' + resyncFrame(bus.currentId()));
      } else {
        write(`id: ${lastEventId}\n\n`);
        for (const e of missed) write(eventFrame(e));
      }
    } else {
      write(`id: ${bus.currentId()}\n\n`);
    }

    const heartbeat = setInterval(() => write(': ping\n\n'), bus.heartbeatMs);
    heartbeat.unref();

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      unsubscribe();
      open.delete(res);
    };
    res.on('close', cleanup);
    // If the socket died between the check above and here, 'close' has already fired.
    if (res.destroyed || req.raw.socket?.destroyed) cleanup();
  });
};

export default publisherEventRoutes;
