import { mkdir, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { generateSeed } from './seed.js';
import type { Agent, BlogPost, Listing, OpenHouse, SiteData } from './types.js';

/** Default data directory: apps/demo-site/data (git-ignored). Render mounts a disk via DEMO_DATA_DIR. */
export const DEFAULT_DATA_DIR = fileURLToPath(new URL('../../data', import.meta.url));
export const SNAPSHOT_FILE = 'bluebonnet.json';

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

  constructor(data: SiteData) {
    this.data = data;
    this.reindex();
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
}

/**
 * Boot path: rebuild from the deterministic seed, then (SP-004b) replay the mutation log
 * from `dataDir`, then write a JSON snapshot of the result to `dataDir/bluebonnet.json`.
 */
export async function openStore({ dataDir = DEFAULT_DATA_DIR, scale = 1 }: OpenStoreOptions = {}): Promise<Store> {
  const store = createStore(scale);
  await writeSnapshot(store, dataDir);
  return store;
}

export async function writeSnapshot(store: Store, dataDir: string): Promise<string> {
  await mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, SNAPSHOT_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(store.data, null, 2));
  await rename(tmp, file);
  return file;
}
