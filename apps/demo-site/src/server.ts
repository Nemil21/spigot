import { createApp } from './app.js';
import { DEFAULT_DATA_DIR, openStore } from './data/store.js';
import { gateFromEnv, noopGate } from './gate.js';

const port = Number(process.env.PORT ?? 4100);
const scale = process.env.DEMO_SEED_SCALE ? Number(process.env.DEMO_SEED_SCALE) : 1;
const dataDir = process.env.DEMO_DATA_DIR || DEFAULT_DATA_DIR;

const store = await openStore({ dataDir, scale });
// spigot-gate (SP-006b): fails open, so the site serves normally if Spigot is down or unset.
const gate = gateFromEnv(process.env);
if (!gate) console.log('spigot-gate off: set SPIGOT_API_BASE and SPIGOT_GATE_KEY to enable it');
const app = createApp({
  store,
  gate: gate?.handler ?? noopGate,
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
  process.on(sig, () => {
    gate?.stop();
    // Last counts out (2 s timeout, never rejects), then close.
    void (gate?.flush() ?? Promise.resolve()).finally(() => server.close(() => process.exit(0)));
  });
}
