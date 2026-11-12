import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('@spigot/gate package', () => {
  it('has zero runtime dependencies (publishers install it into their own servers)', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies ?? {}).toEqual({});
  });

  it('runtime sources import nothing but node: builtins and their own files', () => {
    const src = new URL('./', import.meta.url);
    const files = readdirSync(src).filter((f) => f.endsWith('.ts') && !f.includes('.test'));
    expect(files).toContain('classify.ts');
    for (const f of files) {
      const code = readFileSync(new URL(f, src), 'utf8');
      for (const [, spec] of code.matchAll(/from '([^']+)'/g)) {
        expect(spec, `${f} imports ${spec}`).toMatch(/^(node:|\.\/)/);
      }
    }
  });
});
