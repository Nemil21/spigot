// The MCP server on `/mcp` (features/11 §Logic 1; SP-022a): `@modelcontextprotocol/sdk` over
// Streamable HTTP, in session mode. `initialize` opens a session (`Mcp-Session-Id`) with its own
// `McpServer` and transport; every later request on it must carry the same API key that opened
// it. Auth and the rate limit run in `routes/mcp.ts` before anything here, on every request.
//
// Sessions live in memory, like the rate limiter: correct for the one API instance we deploy. A
// restart drops them; the client gets 404 for its session id and re-initializes (the spec's
// reconnect path), and tool idempotency never depends on a session surviving.
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { CallerAuth, ToolDeps, ToolModule } from './tools.js';

export const SERVER_INFO = { name: 'spigot', version: '1.0.0' } as const;

const INSTRUCTIONS =
  'Spigot sells clean, typed records from websites, paid from your prepaid Spigot balance ' +
  '(funded with PayPal). Start with list_datasets, then describe_dataset for the fields you can ' +
  'filter on. quote is free and tells you what a search would cost; search_records and ' +
  'get_changes charge per record or change returned, and nothing when none match.';

/** A session idle this long is closed (the client re-initializes on its next request). */
export const SESSION_IDLE_MS = 30 * 60_000;
/** Open sessions per API key; opening one more closes that key's least recently used. */
export const MAX_SESSIONS_PER_KEY = 20;

interface Session {
  id: string;
  apiKeyId: string;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastSeen: number;
  /** JSON-RPC request ids being answered now, each with a promise of its HTTP response ending. */
  inFlight: Map<string, Promise<void>>;
}

/** One session's server: every tool module registered on a fresh `McpServer`. */
export function createMcpServer(modules: readonly ToolModule[], deps: ToolDeps): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  for (const register of modules) register(server, deps);
  return server;
}

/** What `/mcp` needs from the authenticated request. */
export interface McpRequest {
  raw: IncomingMessage;
  res: ServerResponse;
  body: unknown;
  auth: CallerAuth;
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

/** The ids of the JSON-RPC requests (not notifications or responses) in a POST body. */
export function requestIds(body: unknown): string[] {
  const msgs = Array.isArray(body) ? body : [body];
  const ids: string[] = [];
  for (const m of msgs) {
    if (m && typeof m === 'object' && 'method' in m && 'id' in m) {
      const id = (m as { id: unknown }).id;
      if (typeof id === 'string' || typeof id === 'number') ids.push(`${typeof id}:${id}`);
    }
  }
  return ids;
}

function sessionHeader(raw: IncomingMessage): string | undefined {
  const v = raw.headers['mcp-session-id'];
  return Array.isArray(v) ? v[0] : v;
}

/** `AuthInfo` for the SDK: it hands `extra` to every tool call of this HTTP request. */
function authInfo(auth: CallerAuth): AuthInfo {
  // `token` is required by the type; the key itself never leaves the auth hook.
  return {
    token: 'redacted',
    clientId: auth.apiKeyId,
    scopes: [...auth.scopes],
    extra: { ...auth },
  };
}

export class McpSessions {
  private readonly sessions = new Map<string, Session>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly modules: readonly ToolModule[],
    private readonly deps: ToolDeps,
    private readonly clock: () => number = () => Date.now(),
  ) {
    this.sweeper = setInterval(() => void this.sweep(), 60_000);
    this.sweeper.unref();
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Handle one `/mcp` request (POST, GET or DELETE). The caller has hijacked the reply. */
  async handle(req: McpRequest): Promise<void> {
    (req.raw as IncomingMessage & { auth?: AuthInfo }).auth = authInfo(req.auth);
    const sessionId = sessionHeader(req.raw);

    if (sessionId !== undefined) {
      const s = this.sessions.get(sessionId);
      // Another key's session is reported exactly like an unknown one: never confirm it exists.
      if (!s || s.apiKeyId !== req.auth.apiKeyId) {
        return jsonRpcError(req.res, 404, -32001, 'Session not found. Initialize a new session.');
      }
      s.lastSeen = this.clock();
      if (req.raw.method === 'POST') await this.queueBehindSameIds(s, req);
      return s.transport.handleRequest(req.raw, req.res, req.body);
    }

    if (req.raw.method === 'POST' && isInitializeRequest(req.body)) {
      return this.open(req);
    }

    if (req.raw.method === 'POST') {
      // No session: answer this one message statelessly. Paid tools then use `autoKey`.
      return this.oneShot(req);
    }
    return jsonRpcError(req.res, 400, -32000, 'Mcp-Session-Id header is required.');
  }

  /**
   * A client resending a JSON-RPC message while the first copy is still running (a retry after
   * a timeout) reuses its id. The SDK transport routes a response by id, so two copies in flight
   * at once would leave one HTTP request unanswered. The copy waits for the first to finish,
   * then runs and replays the stored result (free) via the `mcp:<session>:<id>` key.
   */
  private async queueBehindSameIds(s: Session, req: McpRequest): Promise<void> {
    const ids = requestIds(req.body);
    if (ids.length === 0) return;
    for (;;) {
      const busy = ids.map((id) => s.inFlight.get(id)).filter((p) => p !== undefined);
      if (busy.length === 0) break;
      await Promise.all(busy);
    }
    const done = new Promise<void>((resolve) => req.res.once('close', () => resolve()));
    for (const id of ids) s.inFlight.set(id, done);
    void done.then(() => {
      for (const id of ids) if (s.inFlight.get(id) === done) s.inFlight.delete(id);
    });
  }

  private async open(req: McpRequest): Promise<void> {
    const server = createMcpServer(this.modules, this.deps);
    const apiKeyId = req.auth.apiKeyId;
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // Plain JSON responses: no tool streams progress, and JSON survives every proxy.
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        this.sessions.set(id, {
          id,
          apiKeyId,
          transport,
          server,
          lastSeen: this.clock(),
          inFlight: new Map(),
        });
        this.capKey(apiKeyId);
      },
      onsessionclosed: (id) => {
        this.sessions.delete(id);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) this.sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    await transport.handleRequest(req.raw, req.res, req.body);
  }

  private async oneShot(req: McpRequest): Promise<void> {
    const server = createMcpServer(this.modules, this.deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    req.res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, req.res, req.body);
  }

  /** Close this key's least recently used sessions beyond `MAX_SESSIONS_PER_KEY`. */
  private capKey(apiKeyId: string): void {
    const mine = [...this.sessions.values()]
      .filter((s) => s.apiKeyId === apiKeyId)
      .sort((a, b) => a.lastSeen - b.lastSeen);
    for (const s of mine.slice(0, Math.max(0, mine.length - MAX_SESSIONS_PER_KEY))) {
      void this.closeSession(s);
    }
  }

  private async closeSession(s: Session): Promise<void> {
    this.sessions.delete(s.id);
    await s.transport.close().catch(() => {});
    await s.server.close().catch(() => {});
  }

  /** Close idle sessions. */
  async sweep(): Promise<void> {
    const cutoff = this.clock() - SESSION_IDLE_MS;
    const idle = [...this.sessions.values()].filter((s) => s.lastSeen < cutoff);
    await Promise.all(idle.map((s) => this.closeSession(s)));
  }

  async closeAll(): Promise<void> {
    clearInterval(this.sweeper);
    await Promise.all([...this.sessions.values()].map((s) => this.closeSession(s)));
  }
}
