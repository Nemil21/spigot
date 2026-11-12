import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// apps/web may import the extractor (packages/shared is browser-safe, SP-001d), and the spec is
// model-written data: no Node APIs and no dynamic code anywhere in this directory.
const dir = fileURLToPath(new URL('.', import.meta.url));
const sources = readdirSync(dir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => [f, readFileSync(join(dir, f), 'utf8')] as const);

describe('packages/shared/src/extract', () => {
  it('has sources to check', () => {
    expect(sources.map(([f]) => f).sort()).toEqual([
      'canonical.ts',
      'coerce.ts',
      'extract.ts',
      'index.ts',
      'jsonpath.ts',
      'regex.ts',
      'spec.ts',
      'transforms.ts',
    ]);
  });

  it.each(sources)('%s imports no Node built-ins or globals', (_f, code) => {
    expect(code).not.toMatch(/from\s+['"]node:/);
    expect(code).not.toMatch(/require\(/);
    expect(code).not.toMatch(/\b(process|Buffer|__dirname|__filename)\b/);
  });

  it.each(sources)('%s has no eval, Function or dynamic import', (_f, code) => {
    expect(code).not.toMatch(/\beval\s*\(/);
    expect(code).not.toMatch(/\bnew\s+Function\b|\bFunction\s*\(/);
    expect(code).not.toMatch(/\bimport\s*\(/);
  });

  it('uses the slim (browser) cheerio build and no JSONPath library', () => {
    const code = sources.map(([, c]) => c).join('\n');
    expect(code).toMatch(/from 'cheerio\/slim'/);
    expect(code).not.toMatch(/from 'jsonpath/);
  });
});
