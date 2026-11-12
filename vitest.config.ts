import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Workspace sources. `db/` is SP-002's workspace and runs its own tests (`npm run test:db`).
const SOURCES = ['packages/*/src/**', 'apps/*/src/**', 'scripts/**'];
const DB_TESTS = '**/*.db.test.ts';

export default defineConfig({
  // Resolve workspace packages to their TypeScript sources so tests never need a prior build.
  // Aliases, not a `source` resolve condition (Holdfast's lesson: a `source` condition leaks to
  // third-party packages that also export it).
  resolve: {
    alias: [
      { find: /^@spigot\/shared$/, replacement: here('./packages/shared/src/index.ts') },
      { find: /^@spigot\/shared\/(\w+)$/, replacement: here('./packages/shared/src/$1.ts') },
      { find: /^@spigot\/gate$/, replacement: here('./packages/gate/src/index.ts') },
      { find: /^@spigot\/api\/tasks$/, replacement: here('./apps/api/src/tasks/index.ts') },
    ],
  },
  test: {
    environment: 'node',
    // @fastify/autoload imports route files itself; inlining it sends those imports through
    // Vitest's transform so `.ts` route files load under Node 22 (no native type stripping).
    server: { deps: { inline: ['@fastify/autoload'] } },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: SOURCES.map((s) => `${s}/*.test.ts`),
          // apps/web runs in its own `web` project (jsdom, React, .tsx).
          exclude: [DB_TESTS, '**/node_modules/**', '**/dist/**', 'apps/web/**'],
        },
      },
      {
        // DB-backed tests: name them `*.db.test.ts`. CI's `db` job runs this project against a
        // Postgres service; never edit ci.yml to add a test.
        extends: true,
        test: {
          name: 'db',
          include: SOURCES.map((s) => `${s}/${DB_TESTS.replace('**/', '')}`),
          exclude: ['**/node_modules/**', '**/dist/**'],
          // DB tests share one database: run files one at a time.
          fileParallelism: false,
        },
      },
      // Web app tests (SP-024a): jsdom + Testing Library, configured in apps/web.
      'apps/web/vitest.config.ts',
    ],
  },
});
