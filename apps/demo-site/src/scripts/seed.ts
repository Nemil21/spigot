// Writes the seed snapshot to DEMO_DATA_DIR (default apps/demo-site/data) and prints counts.
// The site itself re-seeds on boot; this is for inspecting the generated data (e.g. the
// "no real phone numbers or emails" grep check).
import { DEFAULT_DATA_DIR, createStore, writeSnapshot } from '../data/store.js';
import { scaleFromEnv } from '../data/seed.js';

const scale = scaleFromEnv(process.env);
const store = createStore(scale);
const file = await writeSnapshot(store, process.env.DEMO_DATA_DIR || DEFAULT_DATA_DIR);
console.log(JSON.stringify({ file, scale, ...store.counts() }));
