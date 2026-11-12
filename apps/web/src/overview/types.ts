import type { ActivityAction } from '@spigot/shared/copy';

/** `GET /api/sites/:id/bots` (api.md; SP-027a, `hits24h` SP-027b). */
export interface BotsReport {
  range: { from: string; to: string; bucketSize: 'minute' | 'hour' | 'day' };
  includeSim: boolean;
  totals: {
    botHits: number;
    humanHits: number;
    ratio: string;
    quoted402: number;
    bytesSavedEstimate: number;
    wouldHaveEarnedMicros: number;
    estimate: true;
    estimateBasis: { perGatedPageMicros: number; priceSource: 'LIVE' | 'PROPOSED' | 'DEFAULT' };
  };
  byBot: BotRow[];
  series: { bucket: string; category: string; hits: number }[];
  earnedThisWeek: { micros: number; simMicros: number; simShare: number };
}

export interface BotRow {
  botName: string;
  category: string;
  hits: number;
  /** `PASS` · `QUOTE_402` · `FAIL_OPEN` · `SPIGOT_CRAWLER`. */
  decision: string;
  lastSeen: string;
  bytes: number;
  /** Estimate in micros. */
  wouldHavePaid: number;
  isSimulated: boolean;
  /** Hits per hour over the last 24 h, oldest first. */
  hits24h: number[];
}

/** `GET /api/publishers/me/activity` row. */
export interface ActivityEvent {
  id: string;
  at: string;
  action: ActivityAction;
  entity: string | null;
  entityId: string | null;
  isSimulated: boolean;
  line: string;
}

/** `GET /api/sites` row (the fields W04 reads). */
export interface SiteSummary {
  id: string;
  slug: string;
  origin: string;
  status: string;
  policy: Record<string, unknown>;
  lastGateSeenAt: string | null;
}

/** One grid row's identity: a bot can appear once per (category, decision, SIM). */
export function botRowId(r: Pick<BotRow, 'botName' | 'category' | 'decision' | 'isSimulated'>) {
  return `${r.category}|${r.botName}|${r.decision}|${r.isSimulated ? 'sim' : 'real'}`;
}
