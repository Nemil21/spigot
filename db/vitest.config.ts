import { defineConfig } from 'vitest/config';

// `npm run test:db` (`vitest run --dir test` in db/): schema / constraint tests against
// TEST_DATABASE_URL. Without this file Vitest would pick up the repo-root config, whose projects
// don't scan db/. App-level DB tests live next to their code (root `db` project).
export default defineConfig({
  test: {
    // Relative to `--dir test`.
    include: ['**/*.db.test.ts'],
    environment: 'node',
    fileParallelism: false,
  },
});
