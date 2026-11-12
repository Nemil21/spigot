import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  classifyAddress,
  isAddressAllowed,
  safeFetch,
  SafeFetchError,
  type Resolver,
} from './safeFetch.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

interface TestServer {
  port: number;
  hits: IncomingMessage[];
  close(): Promise<void>;
}

async function listen(host: string, handler: Handler, port = 0): Promise<TestServer> {
  const hits: IncomingMessage[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(req);
    handler(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  return {
    port: (server.address() as AddressInfo).port,
    hits,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof SafeFetchError) return err.code;
    throw err;
  }
  return 'OK';
}

describe('classifyAddress', () => {
  it.each([
    ['93.184.216.34', 'public'],
    ['8.8.8.8', 'public'],
    ['2606:4700:4700::1111', 'public'],
    ['127.0.0.1', 'local'],
    ['127.255.0.9', 'local'],
    ['10.1.2.3', 'local'],
    ['172.16.0.1', 'local'],
    ['172.31.255.255', 'local'],
    ['192.168.1.1', 'local'],
    ['100.64.0.1', 'local'], // CGNAT
    ['100.127.255.254', 'local'],
    ['::1', 'local'],
    ['fd12:3456::1', 'local'],
    ['169.254.169.254', 'blocked'], // cloud metadata
    ['169.254.0.1', 'blocked'],
    ['100.100.100.200', 'blocked'], // Alibaba metadata
    ['fd00:ec2::254', 'blocked'], // AWS IMDS v6
    ['0.0.0.0', 'blocked'],
    ['224.0.0.1', 'blocked'],
    ['255.255.255.255', 'blocked'],
    ['::', 'blocked'],
    ['fe80::1', 'blocked'],
    ['fe80::1%lo0', 'blocked'],
    ['ff02::1', 'blocked'],
    ['::ffff:169.254.169.254', 'blocked'], // IPv4-mapped
    ['::ffff:a9fe:a9fe', 'blocked'],
    ['::ffff:127.0.0.1', 'local'],
    ['::ffff:8.8.8.8', 'public'],
    ['64:ff9b::a9fe:a9fe', 'blocked'], // NAT64 of 169.254.169.254
    ['2002:7f00:1::', 'local'], // 6to4 of 127.0.0.1
    ['2001:0:4136:e378::1', 'blocked'], // Teredo
    ['not-an-ip', 'blocked'],
  ])('%s is %s', (ip, cls) => {
    expect(classifyAddress(ip)).toBe(cls);
  });

  it('allowLocal admits local ranges but never metadata or link-local', () => {
    expect(isAddressAllowed('127.0.0.1')).toBe(false);
    expect(isAddressAllowed('127.0.0.1', true)).toBe(true);
    expect(isAddressAllowed('100.64.0.1', true)).toBe(true);
    expect(isAddressAllowed('169.254.169.254', true)).toBe(false);
    expect(isAddressAllowed('fe80::1', true)).toBe(false);
    expect(isAddressAllowed('8.8.8.8')).toBe(true);
  });
});

describe('safeFetch', () => {
  // `::1` plays a public origin (`public.test`) via the addressAllowed seam; 127.0.0.1 is the
  // private target an attacker wants to reach. Both bind the same port so a rebinding answer
  // would land on the private server.
  let pub: TestServer;
  let priv: TestServer;
  let origin: string;
  let resolver: ReturnType<typeof vi.fn<Resolver>>;
  const asPublic = (ip: string) => ip === '::1' || isAddressAllowed(ip);
  let onHang: (() => void) | undefined;

  beforeAll(async () => {
    priv = await listen('127.0.0.1', (_req, res) => res.end('secret'));
    pub = await listen(
      '::1',
      (req, res) => {
        const u = new URL(req.url!, 'http://x');
        const go = (location: string, status = 302) => {
          res.writeHead(status, { location, connection: 'close' });
          res.end();
        };
        switch (u.pathname) {
          case '/ok':
            res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'sid=1' });
            res.end(`cookie=${req.headers.cookie ?? ''};ua=${req.headers['user-agent']}`);
            return;
          case '/to-metadata':
            return go('http://169.254.169.254/latest/meta-data/');
          case '/to-loopback':
            return go(`http://127.0.0.1:${priv.port}/secret`);
          case '/to-localhost-name':
            return go(`http://localhost:${priv.port}/secret`);
          case '/to-other-origin':
            return go(`http://other.test:${pub.port}/ok`);
          case '/hop':
            return go(
              Number(u.searchParams.get('n')) > 1
                ? `/hop?n=${Number(u.searchParams.get('n')) - 1}`
                : '/ok',
              301,
            );
          case '/big':
            res.writeHead(200);
            res.write(Buffer.alloc(800, 'a'));
            res.end(Buffer.alloc(800, 'b')); // chunked, no content-length
            return;
          case '/big-declared':
            res.writeHead(200, { 'content-length': '5000' });
            res.end(Buffer.alloc(5000));
            return;
          case '/hang':
            onHang?.();
            return; // never answers
          default:
            res.writeHead(404);
            res.end();
        }
      },
      0,
    );
    // Rebind the private server to the same port as the public one (both specific addresses).
    await priv.close();
    priv = await listen('127.0.0.1', (_req, res) => res.end('secret'), pub.port);
    origin = `http://public.test:${pub.port}`;
  });

  afterAll(async () => {
    await Promise.all([pub?.close(), priv?.close()]);
  });

  const opts = () => {
    resolver = vi.fn<Resolver>(async (host) => {
      if (host === 'public.test' || host === 'other.test') return ['::1'];
      if (host === 'localhost') return ['127.0.0.1'];
      throw new Error('ENOTFOUND');
    });
    return { resolver, addressAllowed: asPublic };
  };

  it('fetches a public origin, sends no cookies and drops Set-Cookie', async () => {
    const res = await safeFetch(`${origin}/ok`, {
      ...opts(),
      headers: { Cookie: 'a=b', 'X-Spigot-Key': 'k' },
    });
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('cookie=;ua=SpigotCrawler/1.0');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.address).toBe('::1');
    expect(pub.hits.at(-1)!.headers['x-spigot-key']).toBe('k');
  });

  it('never fetches http://169.254.169.254/, even with allowLocal', async () => {
    for (const allowLocal of [false, true]) {
      const r = vi.fn<Resolver>();
      expect(
        await codeOf(
          safeFetch('http://169.254.169.254/latest/meta-data/', { allowLocal, resolver: r }),
        ),
      ).toBe('BLOCKED_ADDRESS');
      expect(r).not.toHaveBeenCalled();
    }
    expect(await codeOf(safeFetch('http://[::ffff:169.254.169.254]/', { allowLocal: true }))).toBe(
      'BLOCKED_ADDRESS',
    );
  });

  it('blocks a redirect from a public URL to 169.254.169.254', async () => {
    expect(await codeOf(safeFetch(`${origin}/to-metadata`, opts()))).toBe('BLOCKED_ADDRESS');
  });

  it('blocks a redirect from a public URL to 127.0.0.1 without touching it', async () => {
    const before = priv.hits.length;
    expect(await codeOf(safeFetch(`${origin}/to-loopback`, opts()))).toBe('BLOCKED_ADDRESS');
    expect(priv.hits.length).toBe(before);
  });

  it('blocks a redirect to another origin (no DNS lookup for it)', async () => {
    const o = opts();
    expect(await codeOf(safeFetch(`${origin}/to-other-origin`, o))).toBe('OFF_ORIGIN');
    expect(await codeOf(safeFetch(`${origin}/to-localhost-name`, o))).toBe('OFF_ORIGIN');
    expect(resolver.mock.calls.map((c) => c[0])).toEqual(['public.test', 'public.test']);
  });

  it('blocks a host whose name resolves to a private address', async () => {
    const before = priv.hits.length;
    const r: Resolver = async () => ['127.0.0.1'];
    expect(await codeOf(safeFetch(`http://evil.test:${priv.port}/`, { resolver: r }))).toBe(
      'BLOCKED_ADDRESS',
    );
    // Any disallowed answer in a multi-address response blocks the host.
    const mixed: Resolver = async () => ['::1', '10.0.0.1'];
    expect(
      await codeOf(safeFetch(`${origin}/ok`, { resolver: mixed, addressAllowed: asPublic })),
    ).toBe('BLOCKED_ADDRESS');
    expect(priv.hits.length).toBe(before);
  });

  it('pins the first answer: a rebinding second lookup (public → private) is never used', async () => {
    const before = { pub: pub.hits.length, priv: priv.hits.length };
    const answers = [['::1'], ['127.0.0.1'], ['127.0.0.1']];
    const rebinding = vi.fn<Resolver>(async () => answers.shift()!);
    // Two same-origin redirects with `Connection: close`: three fresh sockets to rebind.test.
    // `rebind.test` doesn't resolve in system DNS, so any lookup but the pinned one would fail.
    const res = await safeFetch(`http://rebind.test:${pub.port}/hop?n=2`, {
      resolver: rebinding,
      addressAllowed: asPublic,
    });
    expect(res.status).toBe(200);
    expect(res.redirects).toHaveLength(2);
    expect(rebinding).toHaveBeenCalledTimes(1);
    expect(pub.hits.length - before.pub).toBe(3);
    expect(priv.hits.length).toBe(before.priv);

    // The next call resolves afresh and gets the private answer: blocked before connecting.
    expect(
      await codeOf(
        safeFetch(`http://rebind.test:${pub.port}/ok`, {
          resolver: rebinding,
          addressAllowed: asPublic,
        }),
      ),
    ).toBe('BLOCKED_ADDRESS');
    expect(priv.hits.length).toBe(before.priv);
  });

  it('follows up to 3 redirects on the same origin, then refuses', async () => {
    const res = await safeFetch(`${origin}/hop?n=3`, opts());
    expect(res.status).toBe(200);
    expect(res.url).toBe(`${origin}/ok`);
    expect(res.redirects).toEqual([`${origin}/hop?n=3`, `${origin}/hop?n=2`, `${origin}/hop?n=1`]);
    expect(await codeOf(safeFetch(`${origin}/hop?n=4`, opts()))).toBe('TOO_MANY_REDIRECTS');
  });

  it('enforces the origin option on the first hop too', async () => {
    expect(
      await codeOf(safeFetch(`${origin}/ok`, { ...opts(), origin: 'https://site.test' })),
    ).toBe('OFF_ORIGIN');
  });

  it('caps the body (streamed and declared)', async () => {
    expect(await codeOf(safeFetch(`${origin}/big`, { ...opts(), maxBytes: 1000 }))).toBe(
      'BODY_TOO_LARGE',
    );
    expect(await codeOf(safeFetch(`${origin}/big-declared`, { ...opts(), maxBytes: 1000 }))).toBe(
      'BODY_TOO_LARGE',
    );
    expect((await safeFetch(`${origin}/big`, opts())).body.length).toBe(1600);
  });

  it('times out after exactly timeoutMs while the server hangs', async () => {
    // Only the timers are fake; the socket to /hang is real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const arrived = new Promise<void>((r) => (onHang = r));
      let code: string | undefined;
      const done = codeOf(safeFetch(`${origin}/hang`, { ...opts(), timeoutMs: 200 })).then(
        (c) => (code = c),
      );
      await arrived;
      await vi.advanceTimersByTimeAsync(199);
      expect(code).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(code).toBe('TIMEOUT');
    } finally {
      onHang = undefined;
      vi.useRealTimers();
    }
  });

  it('allowLocal reaches a loopback origin (the local demo site); default refuses it', async () => {
    const url = `http://127.0.0.1:${priv.port}/`;
    expect(await codeOf(safeFetch(url))).toBe('BLOCKED_ADDRESS');
    const res = await safeFetch(url, { allowLocal: true });
    expect(res.body.toString()).toBe('secret');
    expect(
      await codeOf(
        safeFetch(`http://localhost:${priv.port}/`, { resolver: async () => ['127.0.0.1'] }),
      ),
    ).toBe('BLOCKED_ADDRESS');
  });

  it('rejects non-http schemes and credentials', async () => {
    expect(await codeOf(safeFetch('file:///etc/passwd'))).toBe('INVALID_URL');
    expect(await codeOf(safeFetch('http://user:pw@public.test/'))).toBe('INVALID_URL');
  });
});
