import { defineConfig } from 'vitest/config';

// `npm run test:db`: schema / constraint tests against TEST_DATABASE_URL (SP-002 adds them under
// db/test). App-level DB tests live next to their code as `*.db.test.ts` (root `db` project).
export default defineConfig({
  test: {
    include: ['test/**/*.db.test.ts'],
    environment: 'node',
    fileParallelism: false,
    passWithNoTests: true,
  },
});
