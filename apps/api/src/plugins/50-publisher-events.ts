import type { FastifyPluginAsync } from 'fastify';
import { PublisherEventBus } from '../events/bus.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** This process's publisher event bus (SP-025): one LISTEN connection, opened lazily. */
    publisherEvents: PublisherEventBus;
  }
}

/**
 * `app.publisherEvents` (SP-025). Nothing connects until the first SSE stream subscribes, so
 * building the app (and unit tests without Postgres) never opens a LISTEN connection.
 */
const publisherEvents: FastifyPluginAsync = async (app) => {
  const bus = new PublisherEventBus({ connectionString: app.config.DATABASE_URL, log: app.log });
  app.decorate('publisherEvents', bus);
  app.addHook('onClose', async () => {
    await bus.close();
  });
};

export default publisherEvents;
