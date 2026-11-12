// The UA token table (features/02 §Classification rules). Matching is a case-insensitive
// substring test against the User-Agent. Order matters: the first hit wins, so more
// specific tokens come before tokens they contain (`Applebot-Extended` before `Applebot`),
// and SEARCH is checked last so a UA naming both a search crawler and a tool is quoted.

import type { Category } from './policy.js';

export type BotCategory = Exclude<Category, 'UNKNOWN' | 'HUMAN'>;

export interface BotToken {
  /** Canonical name reported as `botName`. */
  readonly name: string;
  readonly category: BotCategory;
  /** Lowercased match needle. */
  readonly needle: string;
}

const table: ReadonlyArray<readonly [BotCategory, readonly string[]]> = [
  [
    'AI_TRAINING',
    [
      'GPTBot',
      'ClaudeBot',
      'anthropic-ai',
      'CCBot',
      'Applebot-Extended',
      'Bytespider',
      'Amazonbot',
      'meta-externalagent',
      'cohere-ai',
    ],
  ],
  [
    'AI_AGENT',
    ['ChatGPT-User', 'Claude-User', 'Perplexity-User', 'PerplexityBot', 'OAI-SearchBot'],
  ],
  [
    'SCRAPER_TOOL',
    [
      'python-requests',
      'python-urllib',
      'aiohttp',
      'Scrapy',
      'curl/',
      'Wget',
      'Go-http-client',
      'node-fetch',
      'axios',
      'HeadlessChrome',
      'Apify',
    ],
  ],
  ['SEARCH', ['Googlebot', 'Bingbot', 'DuckDuckBot', 'Applebot', 'YandexBot']],
];

export const BOT_TOKENS: readonly BotToken[] = Object.freeze(
  table.flatMap(([category, names]) =>
    names.map((name) =>
      Object.freeze({
        name: name === 'curl/' ? 'curl' : name,
        category,
        needle: name.toLowerCase(),
      }),
    ),
  ),
);

/**
 * robots.txt product tokens for AI crawlers. `Google-Extended` is a robots.txt-only token
 * (Google crawls as Googlebot), so it is listed here and never in the UA matcher.
 */
export const AI_ROBOTS_TOKENS: readonly string[] = Object.freeze([
  'GPTBot',
  'ClaudeBot',
  'anthropic-ai',
  'CCBot',
  'Google-Extended',
  'Applebot-Extended',
  'Bytespider',
  'Amazonbot',
  'meta-externalagent',
  'cohere-ai',
  'ChatGPT-User',
  'Claude-User',
  'Perplexity-User',
  'PerplexityBot',
  'OAI-SearchBot',
]);

/** First matching token for a User-Agent, or null. */
export function matchBot(ua: string): BotToken | null {
  if (ua.length === 0) return null;
  const lower = ua.toLowerCase();
  for (const t of BOT_TOKENS) {
    if (lower.includes(t.needle)) return t;
  }
  return null;
}

// Generic self-identification for bots outside the table.
const GENERIC_BOT = /bot\b|crawl|spider|scrape|fetch|http-?client|^java\/|^libwww|^okhttp/i;
const BROWSER = /^Mozilla\/5\.0 \(/;

/**
 * Split unmatched UAs into HUMAN (browser-looking) and UNKNOWN (anything else). Browser
 * UAs without a bot marker are treated as people; stealth scrapers that spoof a browser
 * pass by design (Honest limits).
 */
export function looksHuman(ua: string): boolean {
  return BROWSER.test(ua) && !GENERIC_BOT.test(ua);
}

const MAX_UNKNOWN_NAME = 40;

/** A short, stable name for an unknown client: the UA's first product token. */
export function unknownBotName(ua: string): string {
  const m = /^[A-Za-z0-9._-]+/.exec(ua);
  return m ? m[0].slice(0, MAX_UNKNOWN_NAME) : 'unknown';
}
