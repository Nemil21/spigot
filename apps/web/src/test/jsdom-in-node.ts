// Test-only helper (never bundled): it needs Node's URL.
// eslint-disable-next-line no-restricted-imports
import { URL as NodeURL } from 'node:url';
import { builtinEnvironments } from 'vitest/environments';

/**
 * Browser globals for a test that also boots the API in-process (`*.db.test.ts` under apps/web).
 * Import it first. Such a file runs in the `node` environment on purpose: under
 * `@vitest-environment jsdom` Vite applies its web transform to every module, which rewrites the
 * API's `new URL('./routes', import.meta.url)` into a page URL and breaks its autoloader.
 */
await builtinEnvironments.jsdom.setup(globalThis, {
  jsdom: { url: 'http://localhost:3000/' },
});
// jsdom's URL class isn't accepted by Node's fileURLToPath; Node's is a full WHATWG URL.
globalThis.URL = NodeURL as unknown as typeof URL;
