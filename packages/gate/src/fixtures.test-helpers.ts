import { createHash } from 'node:crypto';
import type { PolicyWire } from './policy.js';

export const CRAWL_KEY = 'ck_test_crawl_key';

export function demoPolicyWire(over: Partial<PolicyWire> = {}): PolicyWire {
  return {
    siteId: 'site_bluebonnet',
    policyVersion: 3,
    apiBase: 'https://spigot.onrender.com/v1/bluebonnet',
    catalogUrl: 'https://spigot.onrender.com/c/bluebonnet',
    crawlKeySha256: createHash('sha256').update(CRAWL_KEY).digest('hex'),
    gatedPaths: ['^/listings/', '^/agents/', '^/open-houses/'],
    decisions: {
      SEARCH: 'PASS',
      AI_TRAINING: 'QUOTE',
      AI_AGENT: 'QUOTE',
      SCRAPER_TOOL: 'QUOTE',
      UNKNOWN: 'PASS',
    },
    prices: [
      {
        dataset: 'listings',
        perRecordMicros: 1500,
        display: '$1.50 per 1,000 records',
        type: 'Listing',
        records: 2341,
      },
    ],
    siteName: 'Bluebonnet Rentals',
    ...over,
  };
}
