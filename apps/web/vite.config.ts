import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defaultClientConditions, defineConfig, loadEnv } from 'vite';

// The repo-root .env (git-ignored) is the single env file for every workspace.
const envDir = fileURLToPath(new URL('../..', import.meta.url));

// The API (apps/api/src/routes/web.ts) serves dist/ same-origin, so `base` is `/` and every API
// call is relative. No dev server is used by tickets (laptop rule); `vite build` + Testing Library.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir, '');
  // AG Grid licence: VITE_AG_GRID_LICENSE_KEY, falling back to the server's AG_GRID_LICENSE_KEY.
  // It has to reach the browser to remove the watermark, so it is public by design.
  const agKey = env.VITE_AG_GRID_LICENSE_KEY || env.AG_GRID_LICENSE_KEY || '';
  return {
    envDir,
    plugins: [react(), tailwindcss()],
    // `source` resolves @spigot/shared to its TypeScript sources. No Node polyfills are
    // configured: if shared ever imports a Node built-in, this build breaks (SP-001d).
    resolve: { conditions: ['source', ...defaultClientConditions] },
    define: { 'import.meta.env.VITE_AG_GRID_LICENSE_KEY': JSON.stringify(agKey) },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      // AG Grid / AG Charts are large by nature; they load lazily, off the first paint.
      chunkSizeWarningLimit: 6000,
    },
  };
});
