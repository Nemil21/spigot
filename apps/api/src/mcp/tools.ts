// The MCP tool registry (SP-022a). Tools are files in `mcp/tools/*.ts`, each default-exporting a
// `ToolModule` that registers its tools on a session's `McpServer`. The hot-spot rule as for
// routes: add a file, never edit this one or `server.ts` (SP-022b adds `balance.ts`, SP-048c
// `claims.ts`).
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  ServerNotification,
  ServerRequest,
  RequestId,
} from '@modelcontextprotocol/sdk/types.js';
import type { FastifyBaseLogger } from 'fastify';
import type { ApiKeyScope } from '../auth/apiKeys.js';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';

/** What every tool gets from the app (one per process). */
export interface ToolDeps {
  db: Db;
  /** `APP_BASE_URL`, for 402 links and terms URLs. */
  baseUrl: string;
  log: FastifyBaseLogger;
  /** Clock for the auto idempotency key's minute bucket (tests). */
  now?: () => Date;
}

/** A tool file's default export. */
export type ToolModule = (server: McpServer, deps: ToolDeps) => void;

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** `authInfo.extra` as `routes/mcp.ts` sets it from the authenticated API key. */
export interface CallerAuth {
  buyerId: string;
  apiKeyId: string;
  scopes: ApiKeyScope[];
}

/** Who is calling, from this HTTP request's API key (re-checked on every request, SP-007b). */
export interface Caller extends CallerAuth {
  /** `Mcp-Session-Id`; undefined on a session-less request. */
  sessionId: string | undefined;
  requestId: RequestId;
}

export function callerOf(extra: ToolExtra): Caller {
  const auth = extra.authInfo?.extra as Partial<CallerAuth> | undefined;
  if (!auth?.buyerId || !auth.apiKeyId) {
    throw new ApiError('UNAUTHENTICATED', 'Send your Spigot API key as a Bearer token.');
  }
  return {
    buyerId: auth.buyerId,
    apiKeyId: auth.apiKeyId,
    scopes: auth.scopes ?? [],
    sessionId: extra.sessionId,
    requestId: extra.requestId,
  };
}

/** Every data tool needs the key's `read` scope (a `topup`-only key can't buy data). */
export function requireRead(caller: Caller): void {
  if (!caller.scopes.includes('read')) {
    throw new ApiError('FORBIDDEN', 'This API key lacks the "read" scope.', {
      requiredScope: 'read',
    });
  }
}

const PLAIN_ID = /^[\x21-\x7e]{1,128}$/;

/**
 * The idempotency key for a paid tool call (features/11 §Logic 4):
 * - the agent's `idempotencyKey`, when it sent one;
 * - else `mcp:<session id>:<jsonrpc id>` when the request belongs to a session, so a client
 *   resending the same JSON-RPC message is never charged twice, and two sessions that both
 *   number their requests from 1 never collide;
 * - else undefined: `paidRead` falls back to SP-016's `autoKey` (request hash + minute bucket),
 *   so a session-less client whose ids restart at 1 never replays an older call.
 * An id that isn't short printable ASCII is hashed, to fit the 255-char key rule.
 */
export function idempotencyKeyFor(caller: Caller, clientKey?: string): string | undefined {
  if (clientKey !== undefined) return clientKey;
  if (!caller.sessionId) return undefined;
  const id = String(caller.requestId);
  const part = PLAIN_ID.test(id) ? id : `h${createHash('sha256').update(id).digest('hex')}`;
  return `mcp:${caller.sessionId}:${part}`;
}

export const TOOLS_DIR = fileURLToPath(new URL('./tools', import.meta.url));
const IS_TOOL = /\.[cm]?[jt]s$/;
const NOT_A_TOOL = /\.test\.[cm]?[jt]s$|\.d\.[cm]?ts$|\.map$/;

/** Imports every tool file in `dir` once, in file-name order. */
export async function loadToolModules(dir = TOOLS_DIR): Promise<ToolModule[]> {
  const files = readdirSync(dir)
    .filter((f) => IS_TOOL.test(f) && !NOT_A_TOOL.test(f))
    .sort();
  const modules: ToolModule[] = [];
  for (const f of files) {
    const mod = (await import(pathToFileURL(join(dir, f)).href)) as { default?: unknown };
    if (typeof mod.default !== 'function') {
      throw new Error(`mcp/tools/${f} must default-export a ToolModule`);
    }
    modules.push(mod.default as ToolModule);
  }
  return modules;
}
