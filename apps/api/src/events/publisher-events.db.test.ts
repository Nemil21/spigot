/**
 * SP-025 publisher SSE bus, against Postgres and real HTTP (as Holdfast HF-008): a charge committed
 * in another process reaches the stream within 2 s, publisher B never sees A's events (live or
 * replayed), rolled-back transactions emit nothing, Last-Event-ID replay / resync, heartbeat, one
 * LISTEN connection per process, LISTEN reconnect, and the per-publisher stream cap.
 * Needs TEST_DATABASE_URL; skipped when unset.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { PUBLISHER_EVENTS_CHANNEL, publisherEvent, type PublisherEventType } from '@spigot/shared';
import { SESSION_COOKIE, signSession } from '../auth/sessions.js';
import { loadConfig } from '../config.js';
import { createDb, createPool, notify, type Db } from '../db/index.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { getOrCreateAccount, platformAccounts } from '../ledger/accounts.js';
import { post } from '../ledger/ledger.js';
import { topupEntries } from '../ledger/postings.js';
import { chargeAndRecord } from '../meter/charge.js';
import { MAX_STREAMS_PER_PUBLISHER } from '../routes/publisher-events.js';
import { cases } from '../security/tenancy/publisher-events.cases.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';
import { LISTEN_APPLICATION_NAME } from './bus.js';

const SECRET = REQUIRED_ENV.SESSION_SECRET!;
const DEADLINE_MS = 2_000;
const PATH = '/api/publishers/me/events';

interface Frame {
  id: string | null;
  event: string;
  data: string;
}

/** A raw SSE client over node:http: status, comments, `id:` lines and parsed frames. */
class SseClient {
  status = 0;
  body = '';
  frames: Frame[] = [];
  comments: string[] = [];
  /** The browser's last-event-id buffer: updated by every `id:` line, with or without data. */
  lastId: string | null = null;
  private buf = '';
  private req!: http.ClientRequest;
  private waiters: (() => void)[] = [];

  static open(
    port: number,
    opts: { cookie?: string; lastEventId?: string; path?: string } = {},
  ): Promise<SseClient> {
    const c = new SseClient();
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.lastEventId) headers['last-event-id'] = opts.lastEventId;
    return new Promise((resolve, reject) => {
      c.req = http.get({ host: '127.0.0.1', port, path: opts.path ?? PATH, headers }, (res) => {
        c.status = res.statusCode ?? 0;
        res.setEncoding('utf8');
        let first = true;
        res.on('data', (chunk: string) => {
          if (c.status !== 200) c.body += chunk;
          else c.push(chunk);
          if (first) {
            first = false;
            if (c.status === 200) resolve(c);
          }
        });
        // Non-SSE responses (401/429) end with a JSON body.
        res.on('end', () => resolve(c));
      });
      c.req.on('error', reject);
    });
  }

  private push(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n\n')) >= 0) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      let event = 'message';
      let id: string | null = null;
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) this.comments.push(line.slice(1).trim());
        else if (line.startsWith('id: ')) id = this.lastId = line.slice(4);
        else if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data.push(line.slice(6));
      }
      if (data.length) this.frames.push({ id, event, data: data.join('\n') });
    }
    for (const w of this.waiters.splice(0)) w();
  }

  /** Resolve once `pred` holds, or reject after `ms`. */
  async until(pred: () => boolean, ms = DEADLINE_MS): Promise<void> {
    const deadline = Date.now() + ms;
    while (!pred()) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out; frames: ${JSON.stringify(this.frames)}`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, left);
        this.waiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
  }

  ofType(type: string): Frame[] {
    return this.frames.filter((f) => f.event === type);
  }

  /** Events that aren't `resync`. */
  get events(): Frame[] {
    return this.frames.filter((f) => f.event !== 'resync');
  }

  close(): void {
    this.req.destroy();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const env = (databaseUrl: string) => ({ ...REQUIRED_ENV, DATABASE_URL: databaseUrl });

describe.skipIf(!testDatabaseUrl)('SP-025 publisher SSE event bus (Postgres)', () => {
  let tdb: TestDatabase;
  let db: Db;
  let app: FastifyInstance;
  let port: number;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.url, { max: 4, applicationName: 'sp025-test' }));
    app = await buildServer(loadConfig(env(tdb.url)), { logger: false });
    app.publisherEvents.heartbeatMs = 100;
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
  }, 60_000);

  afterAll(async () => {
    // Streams may still be open: close() must not hang on them.
    await app?.close();
    await db?.pool.end();
    await tdb?.drop();
  });

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.pool.query(sql, params)).rows as T[];

  const cookieFor = (publisherId: string) =>
    `${SESSION_COOKIE.publisher}=${signSession(SECRET, 'publisher', publisherId)}`;

  async function newPublisher() {
    const tag = randomUUID().slice(0, 8);
    const [pub] = await q<{ id: string }>(
      `INSERT INTO publishers (name, email, payout_email) VALUES ($1, $2, $2) RETURNING id`,
      [`Pub ${tag}`, `pub-${tag}@example.com`],
    );
    return { id: pub!.id, cookie: cookieFor(pub!.id) };
  }

  /** Emit one committed event, as producers do (notify inside their transaction). */
  const publish = (publisherId: string, type: PublisherEventType = 'hits', ids: string[] = []) =>
    db.tx((tx) => notify(tx, PUBLISHER_EVENTS_CHANNEL, publisherEvent(publisherId, type, ids)));

  /** A publisher with a dataset, and a buyer with an API key and `balanceMicros`. */
  async function chargeWorld(balanceMicros: number) {
    const pub = await newPublisher();
    const tag = randomUUID().slice(0, 8);
    const [site] = await q<{ id: string }>(
      `INSERT INTO sites (publisher_id, origin, verify_token, crawl_key_hash, gate_key_hash)
       VALUES ($1, $2, 'v', 'c', 'g') RETURNING id`,
      [pub.id, `https://${tag}.example.com`],
    );
    const [ds] = await q<{ id: string }>(
      `INSERT INTO datasets (site_id, slug, type_name) VALUES ($1, 'listings', 'Listing') RETURNING id`,
      [site!.id],
    );
    const [buyer] = await q<{ id: string }>(`INSERT INTO buyers (name) VALUES ($1) RETURNING id`, [
      `Buyer ${tag}`,
    ]);
    const [key] = await q<{ id: string }>(
      `INSERT INTO api_keys (buyer_id, prefix, key_hash) VALUES ($1, $2, $3) RETURNING id`,
      [buyer!.id, tag, `hash-${randomUUID()}`],
    );
    if (balanceMicros > 0) {
      await db.tx(async (tx) => {
        const account = await getOrCreateAccount(tx, 'BUYER_BALANCE', buyer!.id);
        const { paypalCash } = await platformAccounts(tx);
        await post(tx, {
          kind: 'TOPUP',
          idempotencyKey: `topup:${randomUUID()}`,
          entries: topupEntries({ buyer: account, paypalCash }, balanceMicros),
        });
      });
    }
    const charge = (count = 2) => {
      const records = Array.from({ length: count }, (_, i) => ({
        key: `listings/${i}`,
        data: { i },
      }));
      return chargeAndRecord(
        { db, buyerId: buyer!.id, apiKeyId: key!.id, channel: 'REST' },
        {
          dataset: { id: ds!.id },
          endpoint: 'records.search',
          idempotencyKey: randomUUID(),
          request: { limit: count },
          body: { records },
          servedKeys: records.map((r) => ({ key: r.key, hash: `h${r.key}` })),
          unitPriceMicros: 1500,
          count,
          isSimulated: false,
        },
      );
    };
    return { pub, charge };
  }

  it('a charge committed in another process reaches the stream within 2 s', async () => {
    const { pub, charge } = await chargeWorld(1_000_000);
    // The stream is served by a second API process; the charge commits in this one.
    const child: ChildProcess = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--conditions=source',
        fileURLToPath(new URL('../test/sse-instance.ts', import.meta.url)),
      ],
      { env: { ...process.env, ...env(tdb.url) }, stdio: ['ignore', 'pipe', 'inherit'] },
    );
    try {
      const port2 = await new Promise<number>((resolve, reject) => {
        let out = '';
        child.stdout!.on('data', (d: Buffer) => {
          out += d.toString();
          const m = /PORT=(\d+)/.exec(out);
          if (m) resolve(Number(m[1]));
        });
        child.once('exit', (code) => reject(new Error(`instance 2 exited (${code})`)));
      });
      const client = await SseClient.open(port2, { cookie: pub.cookie });
      expect(client.status).toBe(200);

      const t0 = Date.now();
      const result = await charge();
      expect(result.status).toBe(200);
      await client.until(() => client.ofType('call.charged').length === 1);
      expect(Date.now() - t0).toBeLessThan(DEADLINE_MS);

      const data = JSON.parse(client.ofType('call.charged')[0]!.data);
      expect(data).toEqual({
        publisherId: pub.id,
        type: 'call.charged',
        ids: [result.callId],
        at: expect.any(String),
      });
      client.close();
    } finally {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      await exited;
    }
  }, 30_000);

  it("publisher B never receives publisher A's events, live or replayed", async () => {
    const a = await newPublisher();
    const b = await newPublisher();
    const streamA = await SseClient.open(port, { cookie: a.cookie });
    // Naming A in the query changes nothing: B's stream is B's.
    const streamB = await SseClient.open(port, {
      cookie: b.cookie,
      path: `${PATH}?publisherId=${a.id}`,
    });
    expect([streamA.status, streamB.status]).toEqual([200, 200]);
    const resumeB = streamB.lastId!;

    for (const t of [
      'hits',
      'call.charged',
      'payout.updated',
      'proposal.ready',
      'crawl.progress',
    ] as const) {
      await publish(a.id, t, [randomUUID()]);
    }
    await publish(b.id, 'hits', ['b-only']);

    await streamA.until(() => streamA.events.length === 5);
    await streamB.until(() => streamB.events.length === 1);
    await sleep(200);
    expect(streamB.events.map((f) => JSON.parse(f.data).ids)).toEqual([['b-only']]);
    expect(streamA.events.every((f) => JSON.parse(f.data).publisherId === a.id)).toBe(true);
    streamB.close();

    // B reconnecting with Last-Event-ID gets its own missed event only, not A's.
    const replayB = await SseClient.open(port, { cookie: b.cookie, lastEventId: resumeB });
    await replayB.until(() => replayB.events.length === 1);
    await sleep(100);
    expect(replayB.events.map((f) => JSON.parse(f.data).publisherId)).toEqual([b.id]);
    expect(replayB.ofType('resync')).toHaveLength(0);
    replayB.close();
    streamA.close();
  });

  it('runs the tenancy cases: no session → 401 with the error envelope', async () => {
    expect(cases.map((c) => c.url)).toEqual([PATH]);
    const anon = await SseClient.open(port);
    expect(anon.status).toBe(401);
    expect(JSON.parse(anon.body)).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    const forged = await SseClient.open(port, {
      cookie: `${SESSION_COOKIE.publisher}=${signSession('y'.repeat(32), 'publisher', randomUUID())}`,
    });
    expect(forged.status).toBe(401);
  });

  it('a rolled-back transaction emits nothing (direct notify, and a charge refused for balance)', async () => {
    const { pub, charge } = await chargeWorld(0);
    const client = await SseClient.open(port, { cookie: pub.cookie });

    await expect(
      db.tx(async (tx) => {
        await notify(
          tx,
          PUBLISHER_EVENTS_CHANNEL,
          publisherEvent(pub.id, 'call.charged', ['rolled-back']),
        );
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    // The metering transaction rolls back on a short balance: 402, no charge, no event.
    expect((await charge()).status).toBe(402);

    await publish(pub.id, 'hits', ['committed']);
    await client.until(() => client.events.length > 0);
    // NOTIFY delivers in commit order, so a rolled-back event would already be here.
    await sleep(200);
    expect(client.events.map((f) => [f.event, JSON.parse(f.data).ids])).toEqual([
      ['hits', ['committed']],
    ]);
    client.close();
  });

  it('Last-Event-ID replays missed events in order; an unknown id gets a resync', async () => {
    const pub = await newPublisher();
    const first = await SseClient.open(port, { cookie: pub.cookie });
    await publish(pub.id, 'hits', ['1']);
    await first.until(() => first.events.length === 1);
    const seen = first.lastId!;
    first.close();
    await sleep(50);

    await publish(pub.id, 'hits', ['2']);
    await publish(pub.id, 'proposal.ready', ['3']);
    await sleep(200);

    const resumed = await SseClient.open(port, { cookie: pub.cookie, lastEventId: seen });
    await resumed.until(() => resumed.events.length === 2);
    expect(resumed.events.map((f) => JSON.parse(f.data).ids[0])).toEqual(['2', '3']);
    const ids = resumed.events.map((f) => Number(f.id!.split('-')[1]));
    expect(ids[0]! > Number(seen.split('-')[1])).toBe(true);
    expect(ids[1]! > ids[0]!).toBe(true);
    // Live events continue after the replay.
    await publish(pub.id, 'hits', ['4']);
    await resumed.until(() => resumed.events.length === 3);
    resumed.close();

    for (const bad of ['deadbeef-1', 'garbage', `${seen.split('-')[0]}-999999999`]) {
      const c = await SseClient.open(port, { cookie: pub.cookie, lastEventId: bad });
      await c.until(() => c.ofType('resync').length === 1);
      expect(c.lastId).toBe(app.publisherEvents.currentId());
      expect(c.events).toHaveLength(0);
      c.close();
    }
  });

  it('sends heartbeat comments on idle streams', async () => {
    const pub = await newPublisher();
    const client = await SseClient.open(port, { cookie: pub.cookie });
    await client.until(() => client.comments.filter((c) => c === 'ping').length >= 2, 1_000);
    client.close();
  });

  it('many streams share one LISTEN connection and all receive the event', async () => {
    const pubs = await Promise.all(Array.from({ length: 5 }, () => newPublisher()));
    const clients = await Promise.all(
      pubs.flatMap((p) =>
        Array.from({ length: 5 }, () => SseClient.open(port, { cookie: p.cookie })),
      ),
    );
    expect(clients.every((c) => c.status === 200)).toBe(true);
    const [{ count }] = (await q<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = $1`,
      [LISTEN_APPLICATION_NAME],
    )) as [{ count: number }];
    expect(count).toBe(1);

    await Promise.all(pubs.map((p) => publish(p.id, 'payout.updated', [p.id])));
    await Promise.all(clients.map((c) => c.until(() => c.events.length === 1)));
    for (const c of clients) c.close();
  });

  it(`caps open streams per publisher at ${MAX_STREAMS_PER_PUBLISHER} (429), freeing a slot on close`, async () => {
    const pub = await newPublisher();
    const clients = await Promise.all(
      Array.from({ length: MAX_STREAMS_PER_PUBLISHER }, () =>
        SseClient.open(port, { cookie: pub.cookie }),
      ),
    );
    expect(clients.every((c) => c.status === 200)).toBe(true);
    const over = await SseClient.open(port, { cookie: pub.cookie });
    expect(over.status).toBe(429);
    // Another publisher is unaffected.
    const other = await newPublisher();
    const theirs = await SseClient.open(port, { cookie: other.cookie });
    expect(theirs.status).toBe(200);
    theirs.close();

    clients.pop()!.close();
    await sleep(100);
    const again = await SseClient.open(port, { cookie: pub.cookie });
    expect(again.status).toBe(200);
    for (const c of [...clients, again]) c.close();
    await sleep(100);
    expect(app.publisherEvents.subscribersOf(pub.id)).toBe(0);
  });

  it('reconnects a dropped LISTEN connection, tells streams to resync, then delivers again', async () => {
    const pub = await newPublisher();
    const client = await SseClient.open(port, { cookie: pub.cookie });
    const before = client.lastId!;
    const opened = app.publisherEvents.connectionsOpened;

    await q(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = $1`,
      [LISTEN_APPLICATION_NAME],
    );
    await client.until(() => client.ofType('resync').length === 1, 5_000);
    expect(app.publisherEvents.connectionsOpened).toBe(opened + 1);
    // Events from before the gap can no longer be proven complete: that id now resyncs.
    expect(app.publisherEvents.since(pub.id, before)).toBeNull();

    await publish(pub.id, 'crawl.progress', ['run']);
    await client.until(() => client.ofType('crawl.progress').length === 1);
    client.close();
  }, 15_000);
});
