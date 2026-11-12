import { execFile, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SpigotClient, SpigotError } from '../../../../packages/sdk/typescript/src/index.js';
import {
  balanceResponse,
  changesResponse,
  insufficientBalance402Body,
  recordsResponse,
} from '../routes/v1.schemas.js';

/**
 * SP-056 smoke (unit, runs in CI): the SDK README examples, run unchanged as their own processes
 * against a local stub of `/v1`. The stub's bodies are parsed with the API's own Zod response
 * schemas, so a client written against a shape the API doesn't serve fails here.
 */

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SDK = `${ROOT}packages/sdk/`;
const TSX = `${ROOT}node_modules/.bin/tsx`;
const KEY = 'sk_spg_readme_smoke_0000000000';
const hasPython = spawnSync('python3', ['--version']).status === 0;

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: string;
}

const CALL_ID = '6f1c7a52-8d1e-4f39-9a0e-2b7d6c1e9f00';
const freshness = { crawledAt: '2026-11-11T00:00:00.000Z', sourceLastmod: null, staleSince: null };
const page = recordsResponse.parse({
  records: [
    {
      key: 'l-3',
      data: { title: 'Listing 3', bedrooms: 3, price_usd: 1800 },
      version: 1,
      freshness,
    },
    {
      key: 'l-4',
      data: { title: 'Listing 4', bedrooms: 4, price_usd: 1950 },
      version: 2,
      freshness,
    },
  ],
  next: null,
  charged: { records: 2, priceMicros: 3000 },
  balanceMicros: 19_997_000,
});
const short402 = insufficientBalance402Body.parse({
  error: { code: 'INSUFFICIENT_BALANCE', message: 'This call costs $0.0555; balance $0.0120.' },
  site: 'bluebonnet',
  datasets: [
    {
      slug: 'listings',
      type: 'Listing',
      records: 120,
      perRecordMicros: 1500,
      endpoint: 'http://x/v1/bluebonnet/datasets/listings/records',
    },
  ],
  pay: {
    method: 'prepaid_balance',
    provider: 'PayPal',
    topUpUrl: 'http://x/topup',
    mcp: 'http://x/mcp',
  },
  terms: 'http://x/terms',
  quote: { records: 37, priceMicros: 55_500 },
  balanceMicros: 12_000,
  topUpUrl: 'http://x/topup?need=55500',
});

describe('SP-056 SDK README examples against a local server', { timeout: 60_000 }, () => {
  let server: Server;
  let baseUrl: string;
  const seen: Seen[] = [];

  function handle(req: IncomingMessage, res: ServerResponse, body: string) {
    const url = new URL(req.url ?? '/', 'http://stub');
    seen.push({
      method: req.method ?? '',
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      body,
    });
    const json = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === '/v1/bluebonnet/datasets/listings/records') {
      if (req.headers.authorization !== `Bearer ${KEY}`) return json(402, short402);
      if (url.searchParams.get('max_price_micros') === '1') return json(402, short402);
      return json(200, page, {
        'Spigot-Charged-Micros': '3000',
        'Spigot-Balance-Micros': String(page.balanceMicros),
        'Spigot-Records': '2',
        'Spigot-Call-Id': CALL_ID,
        ...(req.headers['idempotency-key'] === 'retry-1' ? { 'Spigot-Replay': 'true' } : {}),
      });
    }
    if (url.pathname === '/v1/bluebonnet/datasets/listings/changes') {
      return json(
        200,
        changesResponse.parse({
          changes: [],
          next: '42',
          hasMore: false,
          charged: { changes: 0, priceMicros: 0 },
          balanceMicros: 1,
        }),
      );
    }
    if (url.pathname === '/v1/balance') {
      return json(
        200,
        balanceResponse.parse({
          balanceMicros: 1,
          autoTopup: {
            enabled: false,
            thresholdMicros: 0,
            amountCents: 0,
            remainingThisMonthCents: 0,
            hasSavedMethod: false,
          },
        }),
      );
    }
    if (url.pathname === '/v1/claims' && req.method === 'POST') {
      return json(201, {
        claimId: '0b0b0b0b-0000-4000-8000-000000000000',
        status: 'OPEN',
        creditMicros: 0,
      });
    }
    return json(404, { error: { code: 'NOT_FOUND', message: 'nope' } });
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => handle(req, res, body));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    seen.length = 0;
  });

  const env = () => ({ ...process.env, SPIGOT_KEY: KEY, SPIGOT_URL: baseUrl });

  function expectReadmeSearch() {
    expect(seen).toHaveLength(1);
    const [req] = seen;
    expect(req!.method).toBe('GET');
    expect(req!.path).toBe('/v1/bluebonnet/datasets/listings/records');
    expect(req!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(Object.fromEntries(req!.query)).toEqual({
      'bedrooms[gte]': '3',
      'price_usd[lt]': '2000',
    });
  }

  it('the TypeScript README example runs and prints the records and the charge', async () => {
    const { stdout } = await run(
      TSX,
      ['--tsconfig', `${SDK}typescript/tsconfig.json`, `${SDK}typescript/examples/readme.ts`],
      { env: env(), cwd: ROOT },
    );
    expect(stdout.trim()).toBe('2 listings, charged $0.0030');
    expectReadmeSearch();
  });

  it.skipIf(!hasPython)(
    'the Python README example runs and prints the records and the charge',
    async () => {
      const { stdout } = await run('python3', ['examples/readme.py'], {
        env: { ...env(), PYTHONPATH: `${SDK}python`, PYTHONDONTWRITEBYTECODE: '1' },
        cwd: `${SDK}python`,
      });
      expect(stdout.trim()).toBe('2 listings, charged $0.0030');
      expectReadmeSearch();
    },
  );

  it('the README code blocks are the example files', () => {
    const readme = readFileSync(`${SDK}README.md`, 'utf8');
    const block = (lang: string) =>
      readme.match(new RegExp('```' + lang + '\\n([\\s\\S]*?)```'))?.[1];
    expect(block('ts')).toBe(readFileSync(`${SDK}typescript/examples/readme.ts`, 'utf8'));
    expect(block('python')).toBe(readFileSync(`${SDK}python/examples/readme.py`, 'utf8'));
  });

  describe('client behaviour', () => {
    const client = () => new SpigotClient({ apiKey: KEY, baseUrl });

    it('maps Spigot-Call-Id and Spigot-Replay, and sends Idempotency-Key and max_price_micros', async () => {
      const first = await client().records.search(
        'bluebonnet',
        'listings',
        { 'city[in]': ['Austin', 'Waco'] },
        {
          limit: 2,
          idempotencyKey: 'once-1',
          maxPriceMicros: 100_000,
        },
      );
      expect(first).toMatchObject({
        callId: CALL_ID,
        replay: false,
        charged: { records: 2, priceMicros: 3000 },
      });
      expect(seen[0]!.headers['idempotency-key']).toBe('once-1');
      expect(Object.fromEntries(seen[0]!.query)).toEqual({
        'city[in]': 'Austin,Waco',
        limit: '2',
        max_price_micros: '100000',
      });

      const replay = await client().records.search(
        'bluebonnet',
        'listings',
        {},
        { idempotencyKey: 'retry-1' },
      );
      expect(replay.replay).toBe(true);
    });

    it('a 402 throws SpigotError with the code and the top-up link', async () => {
      const err = await client()
        .records.search('bluebonnet', 'listings', {}, { maxPriceMicros: 1 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SpigotError);
      expect(err).toMatchObject({
        status: 402,
        code: 'INSUFFICIENT_BALANCE',
        topUpUrl: 'http://x/topup?need=55500',
        message: 'This call costs $0.0555; balance $0.0120.',
      });
    });

    it('without a key sends no Authorization header and gets the 402 with pay.topUpUrl', async () => {
      const err = await new SpigotClient({ baseUrl }).records
        .search('bluebonnet', 'listings')
        .catch((e: unknown) => e);
      expect(seen[0]!.headers.authorization).toBeUndefined();
      expect(err).toMatchObject({ code: 'INSUFFICIENT_BALANCE', status: 402 });
    });

    it('changes, balance and claims hit the documented paths', async () => {
      const c = client();
      await c.changes.list('bluebonnet', 'listings', { since: '0', includeRecord: true });
      await c.balance.get();
      const claim = await c.claims.create({ callId: CALL_ID, recordKey: 'l-3', reason: 'STALE' });
      expect(claim.status).toBe('OPEN');
      expect(seen.map((s) => `${s.method} ${s.path}?${s.query}`)).toEqual([
        'GET /v1/bluebonnet/datasets/listings/changes?since=0&include=record',
        'GET /v1/balance?',
        'POST /v1/claims?',
      ]);
      expect(JSON.parse(seen[2]!.body)).toEqual({
        callId: CALL_ID,
        recordKey: 'l-3',
        reason: 'STALE',
      });
      expect(seen[2]!.headers['content-type']).toBe('application/json');
    });

    it('a non-JSON error body still throws SpigotError', async () => {
      const c = new SpigotClient({
        baseUrl,
        fetch: async () => new Response('<html>502</html>', { status: 502 }),
      });
      await expect(c.balance.get()).rejects.toMatchObject({ status: 502, code: 'HTTP_502' });
    });

    it('encodes path segments', async () => {
      const err = await client()
        .records.get('blue bonnet', 'list/ings', 'a/b?c')
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'NOT_FOUND' });
      expect(seen[0]!.path).toBe('/v1/blue%20bonnet/datasets/list%2Fings/records/a%2Fb%3Fc');
    });
  });
});
