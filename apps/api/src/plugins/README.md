# App-wide plugins (autoloaded, not encapsulated)

Each `*.ts` file here default-exports a Fastify plugin that `server.ts` registers **before** the
routes, without encapsulation, so its hooks and decorators apply to every route (e.g. SP-007a's
cookies, sessions, CSRF and rate limits). Add a file; never edit `server.ts`.

Order between files is alphabetical: prefix with a number (`10-cookies.ts`, `20-auth.ts`) when one
plugin depends on another. `*.test.ts` files are ignored.
