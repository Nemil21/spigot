import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Same licence fallback as vite.config.ts, from the shell env only (CI has no key).
const agKey = process.env.VITE_AG_GRID_LICENSE_KEY || process.env.AG_GRID_LICENSE_KEY || '';

export default defineConfig({
  plugins: [react()],
  define: { 'import.meta.env.VITE_AG_GRID_LICENSE_KEY': JSON.stringify(agKey) },
  resolve: {
    alias: [
      {
        find: /^@spigot\/shared$/,
        replacement: fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      },
      {
        find: /^@spigot\/shared\/(.*)$/,
        replacement: fileURLToPath(new URL('../../packages/shared/src/$1.ts', import.meta.url)),
      },
    ],
  },
  test: {
    // The root vitest.config.ts runs this as the `web` project (`npm test`).
    name: 'web',
    include: ['src/**/*.test.{ts,tsx}'],
    // `*.db.test.ts` need Postgres and run in the root `db` project (e.g. pages/login.db.test.ts).
    exclude: ['src/**/*.db.test.ts'],
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
  },
});
