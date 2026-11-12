export type ListingStatus = 'available' | 'leased';

export interface Listing {
  id: number;
  slug: string;
  title: string;
  description: string;
  price_usd: number;
  bedrooms: number;
  bathrooms: number;
  sqft: number;
  street_address: string;
  city: string;
  state: 'TX';
  postal_code: string;
  neighbourhood: string;
  /** ISO date (YYYY-MM-DD). HTML only, never in JSON-LD. */
  available_from: string;
  /** HTML only, never in JSON-LD. */
  pets_allowed: 'Yes' | 'No' | 'Cats only' | 'Dogs only';
  status: ListingStatus;
  agent_slug: string;
  created_at: string;
  updated_at: string;
}

export interface Agent {
  slug: string;
  name: string;
  brokerage: string;
  /** Always in the fictional 555-01xx range. */
  phone: string;
  /** Always @example.com. */
  email: string;
  license_no: string;
  years_experience: number;
  languages: string[];
  neighbourhoods: string[];
  bio: string;
  updated_at: string;
}

export interface OpenHouse {
  id: number;
  listing_slug: string;
  host_agent_slug: string;
  /** ISO datetime with the America/Chicago offset, e.g. 2026-12-12T11:00:00-06:00. */
  starts_at: string;
  ends_at: string;
  notes: string;
  updated_at: string;
}

export interface BlogPost {
  slug: string;
  title: string;
  published_on: string;
  paragraphs: string[];
  updated_at: string;
}

export interface SiteData {
  scale: number;
  listings: Listing[];
  agents: Agent[];
  openHouses: OpenHouse[];
  blogPosts: BlogPost[];
}
