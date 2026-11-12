import type { FastifyPluginAsync } from 'fastify';
import { apiKeyRateLimit, authenticateBearer, requireApiKey } from '../auth/apiKeys.js';
import { McpSessions } from '../mcp/server.js';
import { loadToolModules } from '../mcp/tools.js';

/**
 * `/mcp` (SP-022a; features/11, api.md §MCP server): Streamable HTTP for any MCP client (Claude
 * Desktop via `mcp-remote`). Every request, including each one inside a session, is
 * authenticated by API key (a revoked key is 401 on its very next request) and counted against
 * the key's MCP limit (30/min), before the MCP transport sees it.
 */
const mcp: FastifyPluginAsync = async (app) => {
  const sessions = new McpSessions(await loadToolModules(), {
    db: app.db,
    baseUrl: app.config.APP_BASE_URL,
    log: app.log.child({ mcp: true }),
  });
  app.addHook('onClose', async () => sessions.closeAll());

  app.addHook('onRequest', authenticateBearer);

  app.route({
    method: ['POST', 'GET', 'DELETE'],
    url: '/mcp',
    preHandler: apiKeyRateLimit('mcp'),
    handler: async (req, reply) => {
      const key = requireApiKey(req);
      // The SDK writes to the raw response from here on; carry the RateLimit headers over.
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) reply.raw.setHeader(name, value as string | number | string[]);
      }
      reply.hijack();
      try {
        await sessions.handle({
          raw: req.raw,
          res: reply.raw,
          body: req.body,
          auth: { buyerId: key.buyerId, apiKeyId: key.id, scopes: key.scopes },
        });
      } catch (err) {
        req.log.error({ err }, 'mcp request failed');
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
          reply.raw.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32603, message: 'Internal server error' },
              id: null,
            }),
          );
        } else if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      }
    },
  });
};

export default mcp;
