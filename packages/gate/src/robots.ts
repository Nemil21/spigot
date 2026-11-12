// robots.txt helper: tells AI crawlers which paths are sold as an API. robots.txt is
// advisory; the gate is what enforces. Lists `Google-Extended`, a robots.txt-only token.

import { AI_ROBOTS_TOKENS } from './bots.js';

export interface RobotsOptions {
  /** Path prefixes to disallow for AI crawlers, e.g. `/listings/`. */
  disallow: readonly string[];
  /** Catalog URL mentioned in a comment so a human reading robots.txt finds the API. */
  catalogUrl?: string;
  /** Tokens to list; defaults to every AI crawler token. */
  tokens?: readonly string[];
}

/**
 * Turn gate regexes into robots.txt path prefixes where that is exact: a literal path
 * anchored at the start (`^/listings/` → `/listings/`). Other patterns are skipped.
 */
export function robotsPathsFromGated(gatedPaths: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of gatedPaths) {
    if (!p.startsWith('^')) continue;
    const body = p.slice(1);
    // Any regex metacharacter left after removing escaped `/ . -` makes the prefix inexact.
    if (/[.*+?()[\]{}|$^\\]/.test(body.replace(/\\[./-]/g, ''))) continue;
    const prefix = body.replace(/\\([./-])/g, '$1');
    if (prefix.startsWith('/') && !out.includes(prefix)) out.push(prefix);
  }
  return out;
}

/** A robots.txt block for AI crawlers. Append it to the site's existing robots.txt. */
export function robotsTxt(opts: RobotsOptions): string {
  const lines: string[] = [];
  if (opts.catalogUrl)
    lines.push(`# This site's data is available as a paid API: ${opts.catalogUrl}`);
  for (const t of opts.tokens ?? AI_ROBOTS_TOKENS) lines.push(`User-agent: ${t}`);
  if (opts.disallow.length === 0) lines.push('Disallow:');
  for (const d of opts.disallow) lines.push(`Disallow: ${d}`);
  return `${lines.join('\n')}\n`;
}
