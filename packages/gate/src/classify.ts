// packages/gate/src/classify.ts — pure, no I/O, no network (features/02 §Design).

import { createHash, timingSafeEqual } from 'node:crypto';
import { looksHuman, matchBot, unknownBotName } from './bots.js';
import type { Category, Decision, Policy } from './policy.js';

export interface ClassifyInput {
  ua: string;
  ip: string;
  path: string;
  /** Request headers. Keys are expected lowercased (Node's convention). */
  headers: Record<string, string | string[] | undefined>;
}

export interface Classification {
  decision: Decision;
  category: Category;
  botName: string;
}

export const SPIGOT_CRAWLER_NAME = 'SpigotCrawler';
export const HUMAN_BOT_NAME = '-';

// Hashing an attacker-sized header would be the slowest thing on the request path.
const MAX_CRAWL_KEY_LENGTH = 256;

function header(headers: ClassifyInput['headers'], name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Rule 1: `X-Spigot-Key` whose SHA-256 equals the policy's, compared in constant time. */
function isSpigotCrawler(headers: ClassifyInput['headers'], digest: Buffer | null): boolean {
  if (digest === null) return false;
  const key = header(headers, 'x-spigot-key');
  if (!key || key.length > MAX_CRAWL_KEY_LENGTH) return false;
  const got = createHash('sha256').update(key, 'utf8').digest();
  return got.length === digest.length && timingSafeEqual(got, digest);
}

function isGated(path: string, gatedPaths: readonly RegExp[]): boolean {
  for (const re of gatedPaths) {
    if (re.test(path)) return true;
  }
  return false;
}

/**
 * Decide PASS / QUOTE / SPIGOT_CRAWLER for one request. Rules, in order:
 * 1. valid crawl key → SPIGOT_CRAWLER;
 * 2. path not gated → PASS;
 * 3. UA token table → category (else HUMAN for browser UAs, UNKNOWN otherwise);
 * 4. decision = `policy.decisions[category]` (HUMAN always passes).
 * Builds no response strings; the 402 body is prebuilt by `build402`.
 */
export function classify(req: ClassifyInput, policy: Policy): Classification {
  if (isSpigotCrawler(req.headers, policy.crawlKeyDigest)) {
    // bot_hits.category has no Spigot value; the decision column carries SPIGOT_CRAWLER.
    return { decision: 'SPIGOT_CRAWLER', category: 'UNKNOWN', botName: SPIGOT_CRAWLER_NAME };
  }

  // The UA is classified even on ungated paths so the bot report (W04) sees every hit;
  // the decision still follows rule 2 (ungated → PASS).

  const ua = req.ua ?? '';
  const bot = matchBot(ua);
  let category: Category;
  let botName: string;
  if (bot) {
    category = bot.category;
    botName = bot.name;
  } else if (looksHuman(ua)) {
    category = 'HUMAN';
    botName = HUMAN_BOT_NAME;
  } else {
    category = 'UNKNOWN';
    botName = unknownBotName(ua);
  }

  if (!isGated(req.path, policy.gatedPaths)) return { decision: 'PASS', category, botName };
  const decision = category === 'HUMAN' ? 'PASS' : policy.decisions[category];
  return { decision, category, botName };
}
