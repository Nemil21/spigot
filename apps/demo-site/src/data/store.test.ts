import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SNAPSHOT_FILE, openStore } from './store.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('store', () => {
  it('boots from the seed and writes a JSON snapshot into the data dir', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bluebonnet-'));
    dirs.push(dir);
    const store = await openStore({ dataDir: path.join(dir, 'nested'), scale: 0.05 });
    const snap = JSON.parse(await readFile(path.join(dir, 'nested', SNAPSHOT_FILE), 'utf8'));
    expect(snap.listings).toHaveLength(117);
    expect(snap.listings[0].slug).toBe(store.listings[0]!.slug);
    expect(store.listing(store.listings[5]!.slug)).toBe(store.listings[5]);
    expect(store.openHouse(1)?.id).toBe(1);
    expect(store.agent('nobody')).toBeUndefined();
  });
});
