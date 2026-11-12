import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateKey } from '../auth/apiKeys.js';
import { generateSiteSecrets } from '../sites/keys.js';

/**
 * SP-042 bundle check: no credential ships in `apps/web/dist`. SP-032's
 * `apps/web/src/bundle-secrets.test.ts` already proves the PayPal client secret (name and real
 * value) and other server-only env names never appear; this adds Spigot's own credentials.
 *
 * The portal legitimately prints the `sk_spg_` prefix (`sk_spg_<prefix>…`, "Bearer sk_spg_…"), so
 * the rule is "no whole key": `sk_spg_` + 43 base62 chars, `gk_` / `ck_` + a 43-char base64url
 * body. CI's `check` job builds before `npm test`, so there the bundle must exist; locally the scan
 * skips until you run `npm run build`. Matches are reported by file name only, never by value.
 */

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const dist = join(repoRoot, 'apps', 'web', 'dist');
const built = existsSync(join(dist, 'index.html'));

const WHOLE_KEYS: [string, RegExp][] = [
  ['API key (sk_spg_)', /sk_spg_[0-9A-Za-z]{43}(?![0-9A-Za-z])/],
  ['gate key (gk_)', /(?<![A-Za-z0-9_])gk_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/],
  ['crawl key (ck_)', /(?<![A-Za-z0-9_])ck_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/],
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

/** `.env` values for Spigot credentials known locally (the demo gate key); never logged. */
function localKeyValues(): [string, string][] {
  const out: [string, string][] = [];
  const env = join(repoRoot, '.env');
  const lines = existsSync(env) ? readFileSync(env, 'utf8').split(/\r?\n/) : [];
  for (const name of ['SPIGOT_GATE_KEY', 'DEMO_ADMIN_TOKEN']) {
    let v = process.env[name]?.trim();
    for (const line of lines) {
      const m = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`).exec(line);
      if (m) v ||= m[1]!.trim().replace(/^(['"])(.*)\1$/, '$2');
    }
    if (v && v.length >= 12) out.push([name, v]);
  }
  return out;
}

describe('SP-042 web bundle: no Spigot credentials', () => {
  it('the patterns match real keys and not the display prefix (the scan is not vacuous)', () => {
    const real = [
      generateKey().key,
      generateSiteSecrets('00000000-0000-0000-0000-000000000000', 'x'.repeat(32)),
    ];
    const [api, site] = real as [string, { gateKey: string; crawlKey: string }];
    expect(WHOLE_KEYS[0]![1].test(api)).toBe(true);
    expect(WHOLE_KEYS[1]![1].test(site.gateKey)).toBe(true);
    expect(WHOLE_KEYS[2]![1].test(site.crawlKey)).toBe(true);
    for (const shown of ['sk_spg_4kQ9xT2m…', 'Bearer sk_spg_…', '`sk_spg_${k.prefix}…`']) {
      expect(
        WHOLE_KEYS.some(([, re]) => re.test(shown)),
        shown,
      ).toBe(false);
    }
  });

  it('the bundle exists in CI (build runs before tests)', () => {
    if (process.env.CI)
      expect(built, 'apps/web/dist is missing; run `npm run build` first').toBe(true);
  });

  it.skipIf(!built)('no whole sk_spg_ / gk_ / ck_ key in any built file', () => {
    const offenders: string[] = [];
    for (const f of files(dist)) {
      const text = readFileSync(f, 'utf8');
      for (const [what, re] of WHOLE_KEYS) {
        if (re.test(text)) offenders.push(`${f.slice(dist.length + 1)}: ${what}`);
      }
      for (const [name, value] of localKeyValues()) {
        if (text.includes(value)) offenders.push(`${f.slice(dist.length + 1)}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
