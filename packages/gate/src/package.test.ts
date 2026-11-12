import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('@spigot/gate package', () => {
  it('has zero runtime dependencies (publishers install it into their own servers)', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies ?? {}).toEqual({});
  });
});
