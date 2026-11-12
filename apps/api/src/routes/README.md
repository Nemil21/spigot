# Routes (autoloaded)

Every `*.ts` file here is a Fastify plugin registered by `@fastify/autoload` in `server.ts`.
**Add a file; never edit `server.ts`.**

- Default-export a `FastifyPluginAsync`. Declare full paths (`/api/sites/:id`), or set a prefix
  with `export const autoPrefix = '/v1'`.
- Each file is encapsulated: hooks and decorators you add stay inside your file.
- `*.test.ts` files are ignored. Don't add an `index.ts` here (autoload would load only it).
- `app.config` is the validated `Config`.
