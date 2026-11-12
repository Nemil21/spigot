import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// apps/web imports this package, so it must not need Node polyfills (SP-001d).
// tsconfig (lib ES2022, types []) enforces this at build time; this test is the backstop.
const srcDir = fileURLToPath(new URL('.', import.meta.url));
const sources = readdirSync(srcDir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => [f, readFileSync(join(srcDir, f), 'utf8')] as const);

describe('packages/shared is browser-safe', () => {
  it('has sources to check', () => {
    expect(sources.map(([f]) => f).sort()).toEqual([
      'copy.ts',
      'errors.ts',
      'events.ts',
      'gate.ts',
      'index.ts',
      'money.ts',
    ]);
  });

  it.each(sources)('%s imports no Node built-ins or globals', (_f, code) => {
    expect(code).not.toMatch(/from\s+['"]node:/);
    expect(code).not.toMatch(/require\(/);
    expect(code).not.toMatch(/\b(process|Buffer|__dirname|__filename)\b/);
  });

  it('depends only on zod', () => {
    const pkg = JSON.parse(readFileSync(join(srcDir, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['zod']);
  });
});
