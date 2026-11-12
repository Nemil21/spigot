import { BOT_CATEGORIES, HUMAN_BOT_NAME } from '@spigot/shared/gate';
import { formatCount } from '@spigot/shared/money';

/** W04 wording for `bot_hits.category` (gate UA table categories). */
export const CATEGORY_LABELS: Record<string, string> = {
  SEARCH: 'Search engine',
  AI_TRAINING: 'AI training',
  AI_AGENT: 'AI agent',
  SCRAPER_TOOL: 'Scraper',
  UNKNOWN: 'Unknown bot',
  HUMAN: 'People',
};

/** Bot categories in chart / filter order. */
export const CHART_CATEGORIES: readonly string[] = BOT_CATEGORIES;

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

/** `bot_hits.decision` → what the owner reads: the gate passed the bot, or sent it to the API. */
export function decisionLabel(decision: string): string {
  switch (decision) {
    case 'QUOTE_402':
      return 'Sent to API';
    case 'PASS':
      return 'Passed';
    case 'FAIL_OPEN':
      return 'Passed (gate fail-open)';
    case 'SPIGOT_CRAWLER':
      return 'Spigot crawler';
    default:
      return decision;
  }
}

export function botLabel(botName: string): string {
  return botName === HUMAN_BOT_NAME ? 'Unidentified' : botName;
}

/** Decimal bytes, one decimal from KB up: "2.1 GB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i += 1;
  }
  return i === 0 ? `${formatCount(Math.round(v))} B` : `${v.toFixed(1)} ${units[i]}`;
}
