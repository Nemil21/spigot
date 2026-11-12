// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * SP-032 acceptance: the PayPal client secret never reaches the browser. The buyer portal loads
 * the JS SDK v6 with the **client id** only (from `GET /api/buyer/paypal-config`).
 *
 * This greps the built bundle (`apps/web/dist`). CI's `check` job runs `npm run build` before
 * `npm test`, so there the bundle must exist; locally the test skips until you build. Server-only
 * secret names must not appear, and when the real secret is in the environment or the repo's
 * `.env` (local runs), its value must not appear either. Nothing here prints a secret: matches are
 * reported as file names only.
 */
const webRoot = fileURLToPath(new URL('..', import.meta.url));
const dist = join(webRoot, 'dist');
const repoRoot = join(webRoot, '..', '..');
const built = existsSync(join(dist, 'index.html'));

/** Server-only env names that must never be referenced by browser code. */
const SERVER_ONLY = [
  'PAYPAL_CLIENT_SECRET',
  'SESSION_SECRET',
  'ANTHROPIC_API_KEY',
  'RENDER_API_KEY',
  'DATABASE_URL',
  'DEMO_ADMIN_TOKEN',
] as const;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

/** A value from the shell env or the repo-root `.env` (never logged). */
function secretValue(name: string): string | null {
  const fromEnv = process.env[name];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const envFile = join(repoRoot, '.env');
  if (!existsSync(envFile)) return null;
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`).exec(line);
    if (!m) continue;
    const v = m[1]!.trim().replace(/^(['"])(.*)\1$/, '$2');
    return v || null;
  }
  return null;
}

describe('web bundle: no server secrets (SP-032)', () => {
  it('the bundle exists in CI (build runs before tests)', () => {
    if (process.env.CI)
      expect(built, 'apps/web/dist is missing; run `npm run build` first').toBe(true);
  });

  it.skipIf(!built)('references no server-only env names or client_secret', () => {
    const offenders: string[] = [];
    for (const f of files(dist)) {
      const text = readFileSync(f, 'utf8');
      for (const needle of [...SERVER_ONLY, 'client_secret']) {
        if (text.includes(needle)) offenders.push(`${f.slice(dist.length + 1)}: ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it.skipIf(!built)('contains none of the real secret values (when known locally)', () => {
    const offenders: string[] = [];
    for (const name of SERVER_ONLY) {
      const value = secretValue(name);
      // Short values (e.g. a placeholder) could match by accident; real secrets are long.
      if (!value || value.length < 12) continue;
      for (const f of files(dist)) {
        if (readFileSync(f, 'utf8').includes(value))
          offenders.push(`${f.slice(dist.length + 1)}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('only the public PayPal client id is exposed to Vite (no VITE_*SECRET* keys)', () => {
    const example = readFileSync(join(repoRoot, '.env.example'), 'utf8');
    const viteKeys = [...example.matchAll(/^\s*(VITE_[A-Z0-9_]+)\s*=/gm)].map((m) => m[1]!);
    expect(viteKeys.filter((k) => /SECRET|TOKEN|PASSWORD/.test(k))).toEqual([]);
  });
});
