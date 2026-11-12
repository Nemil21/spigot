import { defineConfig } from 'vitest/config';

// Lets `npm test -w @spigot/demo-site` run on its own; the root vitest config picks up
// the same `src/**/*.test.ts` files once the workspace skeleton (SP-001a) lands.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
