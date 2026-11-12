import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../../', import.meta.url);
const example = readFileSync(new URL('.env.example', root), 'utf8');
const lines = example.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
const keys = lines.map((l) => l.split('=')[0]!.trim());

describe('.env.example', () => {
  it('lists every key with no values', () => {
    for (const line of lines) expect(line).toMatch(/^[A-Z][A-Z0-9_]*=$/);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('lists every key config.ts reads', () => {
    const configSrc = readFileSync(new URL('apps/api/src/config.ts', root), 'utf8');
    const schema = configSrc.slice(
      configSrc.indexOf('const envSchema'),
      configSrc.indexOf('type ParsedEnv'),
    );
    const configKeys = [...schema.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]);
    expect(configKeys.length).toBeGreaterThan(30);
    expect(keys).toEqual(expect.arrayContaining(configKeys));
  });

  it('.env is git-ignored', () => {
    const gitignore = readFileSync(new URL('.gitignore', root), 'utf8').split('\n');
    expect(gitignore).toContain('.env');
    expect(gitignore).toContain('!.env.example');
  });
});
