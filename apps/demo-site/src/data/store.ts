import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { applyEntry, planMutation, planReset, type LogEntry, type MutateEntry, type MutateOptions, type ResetEntry } from './mutations.js';
import { countsForScale, generateSeed } from './seed.js';
import type { Agent, BlogPost, Listing, OpenHouse, SiteData } from './types.js';

/** Default data directory: apps/demo-site/data (git-ignored). Render mounts a disk via DEMO_DATA_DIR. */
export const DEFAULT_DATA_DIR = fileURLToPath(new URL('../../data', import.meta.url));
export const SNAPSHOT_FILE = 'bluebonnet.json';
/** Append-only JSON Lines log of demo mutations (and the last reset), replayed on boot. */
export const LOG_FILE = 'mutations.jsonl';

export interface StoreOptions {
  /** Where the mutation log and snapshot live. Without it, mutations are in-memory only (tests). */
  dataDir?: string;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export interface StoreState {
  scale: number;
  counts: ReturnType<Store['counts']>;
  seedCounts: { listings: number; agents: number; openHouses: number };
  /** Entries since boot of the log: at most one reset (first) followed by mutations. */
  log: LogEntry[];
  mutations: number;
  lastResetAt: string | null;
}

/**
 * The demo site's own data. This is the "publisher's" store, deliberately separate from
 * Spigot's Postgres. State = seed (+ SP-004b's mutation log, replayed in openStore).
 */
export class Store {
  readonly data: SiteData;
  private listingsBySlug = new Map<string, Listing>();
  private agentsBySlug = new Map<string, Agent>();
  private openHousesById = new Map<number, OpenHouse>();
  private blogBySlug = new Map<string, BlogPost>();
  private readonly dataDir: string | undefined;
  private readonly now: () => Date;
  private log: LogEntry[] = [];
  /** Serializes writes: one mutate / reset at a time, each fully persisted before the next plans. */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(data: SiteData, { dataDir, now = () => new Date() }: StoreOptions = {}) {
    this.data = data;
    this.dataDir = dataDir;
    this.now = now;
    this.reindex();
  }

  /** Boot-time replay of the persisted log (openStore). */
  replay(entries: LogEntry[]): void {
    for (const e of entries) applyEntry(this.data, e);
    this.log = [...entries];
    this.reindex();
  }

  /**
   * Write path for `demo:mutate` / `POST /admin/mutate`. Plans against the current data, appends
   * the entry to the log (durable first), then applies it. Throws MutationError on bad options.
   */
  mutate(opts: MutateOptions): Promise<MutateEntry> {
    return this.serialize(async () => {
      const entry = planMutation(this.data, opts, this.now());
      if (this.dataDir) await appendLine(path.join(this.dataDir, LOG_FILE), entry);
      applyEntry(this.data, entry);
      this.log.push(entry);
      this.reindex();
      await this.persistSnapshot();
      return entry;
    });
  }

  /**
   * `POST /admin/reset`: rebuild from the seed and replace the log with a single reset entry
   * that carries the reverted pages' new lastmod (so a restart keeps it).
   */
  reset(): Promise<ResetEntry> {
    return this.serialize(async () => {
      const entry = planReset(this.data, this.log, this.now());
      if (this.dataDir) await writeLines(path.join(this.dataDir, LOG_FILE), [entry]);
      applyEntry(this.data, entry);
      this.log = [entry];
      this.reindex();
      await this.persistSnapshot();
      return entry;
    });
  }

  state(): StoreState {
    const reset = this.log.find((e): e is ResetEntry => e.kind === 'reset');
    const seed = countsForScale(this.data.scale);
    return {
      scale: this.data.scale,
      counts: this.counts(),
      seedCounts: seed,
      log: this.log,
      mutations: this.log.filter((e) => e.kind === 'mutate').length,
      lastResetAt: reset?.at ?? null,
    };
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writes.then(fn, fn);
    this.writes = run.catch(() => undefined);
    return run;
  }

  private async persistSnapshot(): Promise<void> {
    if (this.dataDir) await writeSnapshot(this, this.dataDir);
  }

  /** Rebuild lookups after the data arrays change (SP-004b's write path calls this). */
  reindex(): void {
    this.listingsBySlug = new Map(this.data.listings.map((l) => [l.slug, l]));
    this.agentsBySlug = new Map(this.data.agents.map((a) => [a.slug, a]));
    this.openHousesById = new Map(this.data.openHouses.map((o) => [o.id, o]));
    this.blogBySlug = new Map(this.data.blogPosts.map((p) => [p.slug, p]));
  }

  get listings(): readonly Listing[] {
    return this.data.listings;
  }
  get agents(): readonly Agent[] {
    return this.data.agents;
  }
  get openHouses(): readonly OpenHouse[] {
    return this.data.openHouses;
  }
  get blogPosts(): readonly BlogPost[] {
    return this.data.blogPosts;
  }

  listing(slug: string): Listing | undefined {
    return this.listingsBySlug.get(slug);
  }
  agent(slug: string): Agent | undefined {
    return this.agentsBySlug.get(slug);
  }
  openHouse(id: number): OpenHouse | undefined {
    return this.openHousesById.get(id);
  }
  blogPost(slug: string): BlogPost | undefined {
    return this.blogBySlug.get(slug);
  }

  listingsForAgent(agentSlug: string): Listing[] {
    return this.data.listings.filter((l) => l.agent_slug === agentSlug);
  }
  openHousesForListing(listingSlug: string): OpenHouse[] {
    return this.data.openHouses.filter((o) => o.listing_slug === listingSlug);
  }

  /** Neighbourhoods that have at least one listing, sorted, for the search form. */
  neighbourhoods(): string[] {
    return [...new Set(this.data.listings.map((l) => l.neighbourhood))].sort();
  }

  counts(): { listings: number; agents: number; openHouses: number; blogPosts: number } {
    return {
      listings: this.data.listings.length,
      agents: this.data.agents.length,
      openHouses: this.data.openHouses.length,
      blogPosts: this.data.blogPosts.length,
    };
  }
}

export function createStore(scale = 1): Store {
  return new Store(generateSeed(scale));
}

export interface OpenStoreOptions {
  dataDir?: string;
  scale?: number;
  now?: () => Date;
}

/**
 * Boot path: rebuild from the deterministic seed, replay the mutation log from `dataDir`
 * (so a restart or redeploy keeps mutations), then write a JSON snapshot of the result to
 * `dataDir/bluebonnet.json`.
 */
export async function openStore({ dataDir = DEFAULT_DATA_DIR, scale = 1, now }: OpenStoreOptions = {}): Promise<Store> {
  const store = new Store(generateSeed(scale), { dataDir, now });
  const file = path.join(dataDir, LOG_FILE);
  const { entries, torn } = await readLog(file);
  store.replay(entries);
  // Rewrite without the torn line so the next append starts on a clean line.
  if (torn) await writeLines(file, entries);
  await writeSnapshot(store, dataDir);
  return store;
}

/** Reads the JSONL log. A torn final line (crash mid-append) is dropped; corruption elsewhere throws. */
export async function readLog(file: string): Promise<{ entries: LogEntry[]; torn: boolean }> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], torn: false };
    throw err;
  }
  let torn = false;
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const entries: LogEntry[] = [];
  lines.forEach((line, i) => {
    try {
      entries.push(JSON.parse(line) as LogEntry);
    } catch (err) {
      if (i === lines.length - 1 && !text.endsWith('\n')) {
        console.warn(`${file}: dropping a torn last line`);
        torn = true;
        return;
      }
      throw new Error(`${file}:${i + 1}: not valid JSON`, { cause: err });
    }
  });
  return { entries, torn };
}

async function appendLine(file: string, entry: LogEntry): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const fh = await open(file, 'a');
  try {
    await fh.appendFile(`${JSON.stringify(entry)}\n`);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Atomically replaces the log (reset, or dropping a torn line). */
async function writeLines(file: string, entries: LogEntry[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
  await rename(tmp, file);
}

export async function writeSnapshot(store: Store, dataDir: string): Promise<string> {
  await mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, SNAPSHOT_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(store.data, null, 2));
  await rename(tmp, file);
  return file;
}
