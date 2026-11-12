import { z } from 'zod';

/**
 * Gate payloads (api.md §Gate endpoints). The API (SP-008b) validates with these schemas; the gate
 * package (SP-006a/006b) has zero runtime deps, so it builds the same shapes by hand and its tests
 * check them against these schemas.
 */

/** Bot categories a policy decides on (data-model.md `sites.policy`). */
export const BOT_CATEGORIES = [
  'SEARCH',
  'AI_TRAINING',
  'AI_AGENT',
  'SCRAPER_TOOL',
  'UNKNOWN',
] as const;
export type BotCategory = (typeof BOT_CATEGORIES)[number];

/** Categories counted in `bot_hits`: the bot categories plus aggregated humans. */
export const HIT_CATEGORIES = [...BOT_CATEGORIES, 'HUMAN'] as const;
export type HitCategory = (typeof HIT_CATEGORIES)[number];

/** Per-category policy decision. */
export const POLICY_DECISIONS = ['PASS', 'QUOTE'] as const;
export type PolicyDecision = (typeof POLICY_DECISIONS)[number];

/** What the gate actually did with a request (data-model.md `bot_hits.decision`). */
export const HIT_DECISIONS = ['PASS', 'QUOTE_402', 'FAIL_OPEN', 'SPIGOT_CRAWLER'] as const;
export type HitDecision = (typeof HIT_DECISIONS)[number];

/** `botName` used for aggregated human traffic (no IP or path is stored). */
export const HUMAN_BOT_NAME = '-';

/** The gate's in-memory counter cap, so one flush never carries more buckets than this. */
export const MAX_HIT_BUCKETS = 10_000;

const isoDateTime = z.iso.datetime({ offset: true });
const nonNegativeInt = z.number().int().nonnegative();

const regexSource = z.string().refine(
  (src) => {
    try {
      new RegExp(src);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'must be a valid regular expression' },
);

/** `GET /api/gate/policy` response. */
export const gatePolicySchema = z.object({
  siteId: z.string().min(1),
  policyVersion: nonNegativeInt,
  apiBase: z.url(),
  catalogUrl: z.url(),
  /** SHA-256 of the site's crawl key, lowercase hex. */
  crawlKeySha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex characters'),
  gatedPaths: z.array(regexSource),
  decisions: z.object({
    SEARCH: z.enum(POLICY_DECISIONS),
    AI_TRAINING: z.enum(POLICY_DECISIONS),
    AI_AGENT: z.enum(POLICY_DECISIONS),
    SCRAPER_TOOL: z.enum(POLICY_DECISIONS),
    UNKNOWN: z.enum(POLICY_DECISIONS),
  }),
  prices: z.array(
    z.object({
      dataset: z.string().min(1),
      perRecordMicros: nonNegativeInt,
      display: z.string().min(1),
    }),
  ),
});
export type GatePolicy = z.infer<typeof gatePolicySchema>;

/** One aggregated counter: hits in one UTC minute for one (category, bot, decision, SIM) key. */
export const gateHitBucketSchema = z.object({
  /** Start of the UTC minute, e.g. "2026-11-11T17:42:00Z". */
  bucket: isoDateTime.refine((s) => {
    const d = new Date(s);
    return d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
  }, 'must be the start of a minute'),
  category: z.enum(HIT_CATEGORIES),
  botName: z.string().min(1).max(100),
  decision: z.enum(HIT_DECISIONS),
  hits: z.number().int().positive(),
  bytes: nonNegativeInt,
  /**
   * True for SIM traffic (`SPIGOT_GATE_DEMO=1` and `X-Spigot-Sim: 1`). Required, not defaulted, so
   * a gate that forgets it can't make simulated bots count as real ones (api.md amendment, SP-001d).
   */
  isSimulated: z.boolean(),
});
export type GateHitBucket = z.infer<typeof gateHitBucketSchema>;

/** `POST /api/gate/hits` body. */
export const gateHitsSchema = z.object({
  sentAt: isoDateTime,
  buckets: z.array(gateHitBucketSchema).max(MAX_HIT_BUCKETS),
});
export type GateHits = z.infer<typeof gateHitsSchema>;
