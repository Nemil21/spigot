import type { FastifyInstance } from 'fastify';

export type RouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RegisteredRoute {
  method: RouteMethod;
  /** As registered, with `:param` segments (e.g. `/api/sites/:id/crawl`). */
  url: string;
}

const METHODS = new Set<string>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Every route the app registered (HEAD / OPTIONS dropped), rebuilt from Fastify's
 * `printRoutes({ commonPrefix: false })` tree after `app.ready()`: each line is
 * `<indent>├── <segment> (GET, POST)`, indented 4 columns per level, and a node's full path is its
 * parent's plus its segment (the same parse SP-023's openapi test uses).
 */
export function routeTable(app: FastifyInstance): RegisteredRoute[] {
  const prefix: string[] = [];
  const out: RegisteredRoute[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const m = /^(.*?)[├└]── (\S+)(?: \(([^)]+)\))?$/.exec(line);
    if (!m) continue;
    const depth = m[1]!.length / 4;
    prefix.length = depth;
    const url = (prefix[depth - 1] ?? '') + m[2]!;
    prefix[depth] = url;
    for (const method of (m[3] ?? '').split(', ')) {
      if (!METHODS.has(method)) continue;
      // The tree drops the `/` before a wildcard (`/app` → `*` is `/app/*`): use the registered form.
      const registered = [url, url.replace(/([^/])\*$/, '$1/*')].find((u) =>
        app.hasRoute({ method: method as RouteMethod, url: u }),
      );
      out.push({ method: method as RouteMethod, url: registered ?? url });
    }
  }
  return out;
}
