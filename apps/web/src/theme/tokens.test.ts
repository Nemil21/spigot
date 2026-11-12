// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOKEN_NAMES, chartPalette, tokens } from './tokens';

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries(
    [...body.matchAll(/--sp-([a-z0-9-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [
      m[1]!,
      m[2]!.toLowerCase(),
    ]),
  );
}

describe('theme tokens', () => {
  it.each([
    ['light', ':root'],
    ['dark', "[data-theme='dark']"],
  ] as const)('%s CSS variables match tokens.ts', (mode, selector) => {
    expect(block(selector)).toEqual(tokens[mode]);
  });

  it('exposes every token as a Tailwind colour', () => {
    for (const name of TOKEN_NAMES) expect(css).toContain(`--color-${name}: var(--sp-${name});`);
  });

  it("is not Holdfast's palette (orange #f26b2c / charcoal #2b2b2b)", () => {
    const all = [
      ...Object.values(tokens.light),
      ...Object.values(tokens.dark),
      ...chartPalette.light,
    ];
    expect(all).not.toContain('#f26b2c');
    expect(all).not.toContain('#2b2b2b');
  });
});
