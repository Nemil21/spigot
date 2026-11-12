import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type pg from 'pg';
import { audit } from '../audit/audit.js';
import type { Config } from '../config.js';
import type { Db, Tx } from '../db/index.js';
import type { PayPalOrdersClient } from '../paypal/index.js';

/**
 * PayPal webhooks (SP-059; api.md §Webhooks, data-model rule 12, features/09 §Logic 7).
 *
 * 1. `POST /webhooks/paypal` (routes/webhooks-paypal.ts) verifies the **raw** body with
 *    `pp.verifyWebhook`, then `recordWebhookEvent` inserts it into `webhook_events` (PK = PayPal's
 *    event id; a redelivery conflicts and is skipped) and answers 200. Nothing is processed in the
 *    request.
 * 2. `processPendingWebhooks` (jobs/webhook-process.job.ts, every 5 s) takes the oldest
 *    unprocessed row `FOR UPDATE SKIP LOCKED`, runs every handler for its type and sets
 *    `processed_at` **in that same transaction**. A handler that throws rolls the whole event back
 *    (left for the next tick); a process that dies after the insert loses nothing: the row blocks
 *    the redelivery and the job still processes it, once.
 * 3. Handlers are `webhooks/handlers/*.ts`, glob-loaded (add a file, never edit this one). Several
 *    handlers may take one type (SP-047a's vault decline and the generic top-up decline); each
 *    must be idempotent on its own (conditional transitions, fixed ledger keys), because PayPal
 *    can send the same fact under two event ids and the pollers race them. A type no handler
 *    takes is marked processed with a `WEBHOOK_UNHANDLED` audit row.
 */

/** A verified PayPal event as stored in `webhook_events.payload`. */
export interface PayPalWebhookEvent {
  id: string;
  event_type: string;
  resource: Record<string, unknown>;
  resource_type?: string;
  create_time?: string;
  summary?: string;
}

/** What handlers get besides the transaction: a second connection's db and the PayPal client. */
export interface WebhookContext {
  /** For handlers that must call PayPal and then write in their own transactions (capture). */
  db: Db;
  pp: PayPalOrdersClient;
  config: Config;
  log?: (msg: string, data: Record<string, unknown>) => void;
}

export interface WebhookHandler {
  /** The handler's file name (logs and results). */
  name: string;
  eventTypes: readonly string[];
  /**
   * Apply `event` inside `tx` (the transaction that sets `processed_at`). Return anything for the
   * log; throw to leave the event unprocessed for the next tick.
   */
  handle(tx: Tx, event: PayPalWebhookEvent, ctx: WebhookContext): Promise<unknown>;
}

export const HANDLERS_DIR = fileURLToPath(new URL('./handlers', import.meta.url));
const HANDLER_FILE = /\.[cm]?[jt]s$/;
const NOT_A_HANDLER = /\.d\.[cm]?ts$|\.test\.[cm]?[jt]s$/;

type HandlerShape = Pick<WebhookHandler, 'eventTypes' | 'handle'>;

function asHandler(value: unknown): HandlerShape | null {
  const h = value as Partial<HandlerShape> | null | undefined;
  return h &&
    Array.isArray(h.eventTypes) &&
    h.eventTypes.every((t) => typeof t === 'string') &&
    typeof h.handle === 'function'
    ? (h as HandlerShape)
    : null;
}

/**
 * Import every handler file in `dir`, sorted by name. A file default-exports
 * `{ eventTypes, handle }` or exports them by name (SP-047a's `auto-topup.ts` does).
 */
export async function loadWebhookHandlers(dir: string = HANDLERS_DIR): Promise<WebhookHandler[]> {
  const files = (await readdir(dir))
    .filter((f) => HANDLER_FILE.test(f) && !NOT_A_HANDLER.test(f))
    .sort();
  const handlers: WebhookHandler[] = [];
  for (const file of files) {
    const mod = (await import(pathToFileURL(join(dir, file)).href)) as Record<string, unknown>;
    const h = asHandler(mod.default) ?? asHandler(mod);
    if (!h) {
      throw new Error(`webhooks/handlers/${file} must export { eventTypes, handle }.`);
    }
    handlers.push({
      name: file.replace(HANDLER_FILE, ''),
      eventTypes: h.eventTypes,
      handle: (tx, event, ctx) => h.handle(tx, event, ctx),
    });
  }
  return handlers;
}

let loaded: Promise<WebhookHandler[]> | undefined;

/** The handlers in `webhooks/handlers/`, loaded once per process. */
export function webhookHandlers(): Promise<WebhookHandler[]> {
  loaded ??= loadWebhookHandlers().catch((err: unknown) => {
    loaded = undefined;
    throw err;
  });
  return loaded;
}

// ------------------------------------------------------------------------------- receive

/** PayPal event ids look like `WH-2WR32451HC0233532-67976317FL4543714`. */
const EVENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const EVENT_TYPE = /^[A-Z0-9._-]{1,128}$/;

/** The event in a verified body, or null when it isn't one PayPal event. */
export function parsePayPalEvent(body: unknown): PayPalWebhookEvent | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const e = body as Record<string, unknown>;
  if (typeof e.id !== 'string' || !EVENT_ID.test(e.id)) return null;
  if (typeof e.event_type !== 'string' || !EVENT_TYPE.test(e.event_type)) return null;
  const resource = e.resource;
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return null;
  return e as unknown as PayPalWebhookEvent;
}

/**
 * Insert a verified event (data-model rule 12). `INSERTED` → the job will process it;
 * `DUPLICATE` → PayPal redelivered an event we already hold (processed or not): nothing to do.
 */
export async function recordWebhookEvent(
  q: Pick<pg.Pool, 'query'>,
  event: PayPalWebhookEvent,
): Promise<'INSERTED' | 'DUPLICATE'> {
  const { rowCount } = await q.query(
    `INSERT INTO webhook_events (id, event_type, payload, verified)
     VALUES ($1, $2, $3, true)
     ON CONFLICT (id) DO NOTHING`,
    [event.id, event.event_type, JSON.stringify(event)],
  );
  return rowCount ? 'INSERTED' : 'DUPLICATE';
}

// ------------------------------------------------------------------------------- process

export interface ProcessedEvent {
  id: string;
  eventType: string;
  /** Each matching handler's return value, by handler name (empty → `WEBHOOK_UNHANDLED`). */
  results: Record<string, unknown>;
}

export interface ProcessResult {
  processed: ProcessedEvent[];
  /** Events whose handler threw this pass: rolled back, retried next tick. */
  failed: { id: string; error: string }[];
}

export interface ProcessOptions {
  /** Most events per call (one transaction each). Default 50. */
  limit?: number;
  /** Default: `webhookHandlers()`. */
  handlers?: WebhookHandler[];
}

/** Handlers that take `eventType`, in file-name order. */
export function handlersFor(handlers: WebhookHandler[], eventType: string): WebhookHandler[] {
  return handlers.filter((h) => h.eventTypes.includes(eventType));
}

/** Process one claimed event inside `tx`: every matching handler, then `processed_at`. */
async function processRow(
  tx: Tx,
  row: { id: string; payload: PayPalWebhookEvent },
  handlers: WebhookHandler[],
  ctx: WebhookContext,
): Promise<ProcessedEvent> {
  const event = row.payload;
  const matching = handlersFor(handlers, event.event_type);
  const results: Record<string, unknown> = {};
  for (const h of matching) results[h.name] = (await h.handle(tx, event, ctx)) ?? null;
  if (matching.length === 0) {
    await audit(tx, {
      actorType: 'PAYPAL_WEBHOOK',
      actorId: event.id,
      entity: 'webhook_events',
      action: 'WEBHOOK_UNHANDLED',
      paypalId: typeof event.resource.id === 'string' ? event.resource.id : null,
      data: { eventId: event.id, eventType: event.event_type },
    });
  }
  await tx.query(`UPDATE webhook_events SET processed_at = now() WHERE id = $1`, [row.id]);
  return { id: row.id, eventType: event.event_type, results };
}

/**
 * Drain unprocessed events, oldest first, one transaction per event. Safe to run in several
 * processes at once: a row being processed is skipped (`SKIP LOCKED`), and a committed one is no
 * longer `processed_at IS NULL`. An event whose handler throws is rolled back and skipped for the
 * rest of this call, so one bad event never blocks the queue.
 */
export async function processPendingWebhooks(
  ctx: WebhookContext,
  opts: ProcessOptions = {},
): Promise<ProcessResult> {
  const handlers = opts.handlers ?? (await webhookHandlers());
  const limit = opts.limit ?? 50;
  const out: ProcessResult = { processed: [], failed: [] };
  const skip: string[] = [];
  const log = ctx.log ?? defaultLog;

  while (out.processed.length + out.failed.length < limit) {
    // Set inside the transaction callback (so not narrowed to `null` here).
    let claimed = null as string | null;
    try {
      const done = await ctx.db.tx(async (tx) => {
        const { rows } = await tx.query<{ id: string; payload: PayPalWebhookEvent }>(
          `SELECT id, payload FROM webhook_events
            WHERE processed_at IS NULL AND NOT (id = ANY($1::text[]))
            ORDER BY received_at, id
            LIMIT 1
            FOR UPDATE SKIP LOCKED`,
          [skip],
        );
        const row = rows[0];
        if (!row) return null;
        claimed = row.id;
        return processRow(tx, row, handlers, ctx);
      });
      if (!done) break;
      out.processed.push(done);
    } catch (err) {
      if (claimed === null) throw err; // the claim itself failed (db down): let the job log it
      skip.push(claimed);
      const error = err instanceof Error ? err.message : String(err);
      out.failed.push({ id: claimed, error });
      log('paypal webhook processing failed; retried next tick', { eventId: claimed, error });
    }
  }
  return out;
}

const defaultLog = (msg: string, data: Record<string, unknown>) =>
  console.error(`[webhooks] ${msg} ${JSON.stringify(data)}`);
