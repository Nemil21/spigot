import { Faker, en } from '@faker-js/faker';
import { BLOG_POSTS } from './blog.js';
import type { Agent, Listing, OpenHouse, SiteData } from './types.js';
import {
  BROKERAGES,
  CITY_PRICE_FACTOR,
  CITY_WEIGHTS,
  FEATURES,
  LANGUAGES,
  NEARBY,
  NEIGHBOURHOODS,
  OPEN_HOUSE_NOTES,
  PETS,
  POSTAL_PREFIX,
  RENT_BAND,
  STREET_NAMES,
  STREET_SUFFIXES,
  TITLE_ADJECTIVES,
  UNIT_KINDS,
} from './vocab.js';

/** Fixed faker seed: the same counts and slugs on every run. @faker-js/faker is pinned exactly. */
export const SEED = 20261221;

export const BASE_COUNTS = { listings: 2341, agents: 88, openHouses: 40 } as const;

/** Every Nth listing is forced into the demo query population (city=Austin, ≥ 3 beds, < $2,000). */
export const FOCUS_EVERY = 32;

/** "Now" for the seed, so updated_at is deterministic. */
const SEED_NOW = Date.parse('2026-11-10T15:00:00Z');
const DAY_MS = 86_400_000;

export function countsForScale(scale: number): { listings: number; agents: number; openHouses: number } {
  if (!Number.isFinite(scale) || scale <= 0) throw new Error(`DEMO_SEED_SCALE must be a positive number, got ${scale}`);
  const n = (base: number) => Math.max(1, Math.round(base * scale));
  return { listings: n(BASE_COUNTS.listings), agents: n(BASE_COUNTS.agents), openHouses: n(BASE_COUNTS.openHouses) };
}

/**
 * The seed scale from the environment. `DEMO_LISTINGS=10` asks for exactly that many listings (agents and open
 * houses scale with it, at least 1 each), for a short live crawl; it wins over `DEMO_SEED_SCALE`. Neither set: scale 1.
 */
export function scaleFromEnv(env: Readonly<Record<string, string | undefined>>): number {
  const listings = env.DEMO_LISTINGS?.trim();
  if (listings) {
    const n = Number(listings);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`DEMO_LISTINGS must be a positive integer, got ${listings}`);
    return n / BASE_COUNTS.listings;
  }
  return env.DEMO_SEED_SCALE ? Number(env.DEMO_SEED_SCALE) : 1;
}

/** The demo query from the video: "3-bed under $2k in Austin". SP-004b's --focus picks from it. */
export function isFocusListing(l: Pick<Listing, 'city' | 'bedrooms' | 'price_usd'>): boolean {
  return l.city === 'Austin' && l.bedrooms >= 3 && l.price_usd < 2000;
}

export function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function generateSeed(scale = 1): SiteData {
  const counts = countsForScale(scale);
  const f = new Faker({ locale: [en] });
  f.seed(SEED);

  const agents = generateAgents(f, counts.agents);
  const listings = generateListings(f, counts.listings, agents);
  const openHouses = generateOpenHouses(f, counts.openHouses, listings);
  return { scale, listings, agents, openHouses, blogPosts: BLOG_POSTS.map((p) => ({ ...p })) };
}

function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function pastTimestamp(f: Faker, maxDaysAgo: number): string {
  return isoSeconds(SEED_NOW - f.number.int({ min: 0, max: maxDaysAgo * 24 * 60 }) * 60_000);
}

function generateAgents(f: Faker, count: number): Agent[] {
  const agents: Agent[] = [];
  const used = new Set<string>();
  const allHoods = Object.values(NEIGHBOURHOODS).flat();
  for (let i = 0; i < count; i++) {
    const first = f.person.firstName();
    const last = f.person.lastName();
    const name = `${first} ${last}`;
    let slug = slugify(name);
    if (used.has(slug)) slug = `${slug}-${i + 1}`;
    used.add(slug);
    // 555-0100..0199 is the fictional range; with ≤ 100 agents every number is unique.
    const phone = `(512) 555-01${String(i % 100).padStart(2, '0')}`;
    const email = `${slugify(first)}.${slugify(last)}.${i + 1}@example.com`.replace(/-/g, '');
    const languages = ['English', ...f.helpers.arrayElements(LANGUAGES.slice(1), { min: 0, max: 2 })];
    const neighbourhoods = f.helpers.arrayElements(allHoods, { min: 2, max: 4 });
    const years = f.number.int({ min: 1, max: 24 });
    agents.push({
      slug,
      name,
      brokerage: f.helpers.arrayElement(BROKERAGES),
      phone,
      email,
      license_no: `TX-DEMO-${String(100000 + i * 37).padStart(6, '0')}`,
      years_experience: years,
      languages,
      neighbourhoods,
      bio: `${first} has helped renters find homes in ${neighbourhoods.join(', ')} for ${years} year${years === 1 ? '' : 's'}.`,
      updated_at: pastTimestamp(f, 120),
    });
  }
  return agents;
}

function roundTo(n: number, step: number): number {
  return Math.round(n / step) * step;
}

function generateListings(f: Faker, count: number, agents: Agent[]): Listing[] {
  const listings: Listing[] = [];
  for (let i = 0; i < count; i++) {
    const id = i + 1;
    const focus = i % FOCUS_EVERY === 0;
    const city = focus ? 'Austin' : f.helpers.weightedArrayElement(CITY_WEIGHTS);
    const neighbourhood = f.helpers.arrayElement(NEIGHBOURHOODS[city]!);
    const bedrooms = focus
      ? f.helpers.arrayElement([3, 3, 3, 4])
      : f.helpers.weightedArrayElement([
          { weight: 10, value: 0 },
          { weight: 30, value: 1 },
          { weight: 32, value: 2 },
          { weight: 20, value: 3 },
          { weight: 8, value: 4 },
        ]);
    const [lo, hi] = RENT_BAND[bedrooms]!;
    const price_usd = focus
      ? roundTo(f.number.int({ min: 1650, max: 1995 }), 5)
      : roundTo(f.number.int({ min: lo, max: hi }) * CITY_PRICE_FACTOR[city]!, 5);
    const bathrooms = bedrooms <= 1 ? 1 : f.helpers.arrayElement(bedrooms === 2 ? [1, 1.5, 2] : [2, 2.5, 3]);
    const sqft = roundTo(f.number.int({ min: 420 + bedrooms * 320, max: 650 + bedrooms * 430 }), 5);
    const streetNo = f.number.int({ min: 100, max: 9899 });
    const street = `${f.helpers.arrayElement(STREET_NAMES)} ${f.helpers.arrayElement(STREET_SUFFIXES)}`;
    const unit = f.datatype.boolean(0.55) ? ` ${f.helpers.arrayElement(UNIT_KINDS)} ${f.number.int({ min: 1, max: 340 })}` : '';
    const street_address = `${streetNo} ${street}${unit}`;
    const postal_code = `${POSTAL_PREFIX[city]}${String(f.number.int({ min: 1, max: 99 })).padStart(2, '0')}`;
    const bedsLabel = bedrooms === 0 ? 'Studio' : `${bedrooms}-bed`;
    const title = `${f.helpers.arrayElement(TITLE_ADJECTIVES)} ${bedsLabel} in ${neighbourhood}`;
    const description = `${bedsLabel === 'Studio' ? 'A studio' : `A ${bedrooms}-bedroom home`} on ${street} with ${f.helpers
      .arrayElements(FEATURES, 2)
      .join(' and ')}, ${f.helpers.arrayElement(NEARBY)}.`;
    const status = !focus && f.datatype.boolean(0.06) ? 'leased' : 'available';
    const updated_at = pastTimestamp(f, 90);
    const available_from = new Date(SEED_NOW + f.number.int({ min: 0, max: 75 }) * DAY_MS).toISOString().slice(0, 10);
    const slug = `${bedrooms === 0 ? 'studio' : `${bedrooms}br`}-${slugify(neighbourhood)}-${slugify(street)}-${id}`;
    listings.push({
      id,
      slug,
      title,
      description,
      price_usd,
      bedrooms,
      bathrooms,
      sqft,
      street_address,
      city,
      state: 'TX',
      postal_code,
      neighbourhood,
      available_from,
      pets_allowed: f.helpers.weightedArrayElement(PETS),
      status,
      agent_slug: f.helpers.arrayElement(agents).slug,
      created_at: isoSeconds(Date.parse(updated_at) - f.number.int({ min: 0, max: 60 }) * DAY_MS),
      updated_at,
    });
  }
  return listings;
}

function generateOpenHouses(f: Faker, count: number, listings: Listing[]): OpenHouse[] {
  const available = listings.filter((l) => l.status === 'available');
  const picked = f.helpers.arrayElements(available, Math.min(count, available.length));
  // Weekends from Sat 2026-12-05 to Sun 2027-01-10; all in CST (UTC-6).
  const firstSaturday = Date.parse('2026-12-05T00:00:00Z');
  return picked.map((listing, i) => {
    const week = f.number.int({ min: 0, max: 5 });
    const day = new Date(firstSaturday + (week * 7 + f.number.int({ min: 0, max: 1 })) * DAY_MS).toISOString().slice(0, 10);
    const startHour = f.helpers.arrayElement([10, 11, 12, 13, 14]);
    const hours = f.helpers.arrayElement([1, 2]);
    const hh = (h: number) => String(h).padStart(2, '0');
    return {
      id: i + 1,
      listing_slug: listing.slug,
      host_agent_slug: listing.agent_slug,
      starts_at: `${day}T${hh(startHour)}:00:00-06:00`,
      ends_at: `${day}T${hh(startHour + hours)}:00:00-06:00`,
      notes: f.helpers.arrayElement(OPEN_HOUSE_NOTES),
      updated_at: pastTimestamp(f, 20),
    };
  });
}
