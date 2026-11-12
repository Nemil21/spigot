import type { FastifyPluginAsync } from 'fastify';
import { renderOpenApiYaml } from '../openapi/generate.js';

/**
 * `GET /v1/openapi.yaml` (features/11 §Logic 9; SP-023): the OpenAPI 3.1 document for `/v1`,
 * generated from the routes' Zod schemas (`openapi/generate.ts`) with `servers` set to this
 * deployment's `APP_BASE_URL`. Public, no key; linked from W13 (`/c/:site`). Rendered once at
 * boot: no DB, nothing per request. Its own file rather than `v1.ts` (hot-spot rule: add a file).
 */
const v1OpenApiRoutes: FastifyPluginAsync = async (app) => {
  const yaml = renderOpenApiYaml({ serverUrl: app.config.APP_BASE_URL });

  app.get('/v1/openapi.yaml', async (_req, reply) =>
    reply
      .type('application/yaml; charset=utf-8')
      .header('Cache-Control', 'public, max-age=300')
      .header('Access-Control-Allow-Origin', '*')
      .send(yaml),
  );
};

export default v1OpenApiRoutes;
