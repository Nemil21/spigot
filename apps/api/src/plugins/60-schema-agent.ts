import type { FastifyPluginAsync } from 'fastify';
import { startSchemaAgent } from '../schema-agent/runtime.js';

/**
 * SP-012a: start the schema agent with the app's db and config. Subscribes to the crawler's
 * `onDiscoveryDone` hook (discovery crawl → proposals) and enables the resume job. Unsubscribes
 * when the app closes.
 */
const schemaAgentPlugin: FastifyPluginAsync = async (app) => {
  const stop = startSchemaAgent({ db: app.db, config: app.config, log: app.log });
  app.addHook('onClose', async () => stop());
};

export default schemaAgentPlugin;
