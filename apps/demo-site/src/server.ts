import { createApp } from './app.js';
import { DEFAULT_DATA_DIR, openStore } from './data/store.js';
import { noopGate } from './gate.js';

const port = Number(process.env.PORT ?? 4100);
const scale = process.env.DEMO_SEED_SCALE ? Number(process.env.DEMO_SEED_SCALE) : 1;
const dataDir = process.env.DEMO_DATA_DIR || DEFAULT_DATA_DIR;

const store = await openStore({ dataDir, scale });
// SP-006b replaces noopGate with spigot-gate here.
const app = createApp({
  store,
  gate: noopGate,
  verifyToken: process.env.SPIGOT_VERIFY_TOKEN || undefined,
  adminToken: process.env.DEMO_ADMIN_TOKEN || undefined,
});

const server = app.listen(port, () => {
  const c = store.counts();
  console.log(
    `Bluebonnet Rentals (fictional demo) on :${port}: ${c.listings} listings, ${c.agents} agents, ${c.openHouses} open houses; data in ${dataDir}; ${store.state().mutations} demo mutation(s) replayed; admin ${process.env.DEMO_ADMIN_TOKEN ? 'on' : 'off'}`,
  );
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
