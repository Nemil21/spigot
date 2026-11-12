import { describe, expect, it } from 'vitest';
import { checkRegexPattern, nativeRegexEngine, REGEX_INPUT_MAX } from './regex.js';

describe('checkRegexPattern', () => {
  it.each([
    '(\\d+)\\s*sq',
    '\\d+',
    '(?:Unit )(\\w+)',
    '^\\$?(\\d{1,3}(?:,\\d{3})*)', // fixed-width inner quantifier is safe
    '([A-Z]{2}) (\\d{5})',
    '(\\d+)-(\\d+)',
    '[a-z]+@[a-z.]+',
    '(a|b)',
    '\\p{Lu}+',
    'x{2,5}',
  ])('accepts %s', (p) => {
    expect(checkRegexPattern(p)).toBeNull();
  });

  it.each([
    ['(a+)+$', 'nested'],
    ['(a*)*b', 'nested'],
    ['(\\w+\\s?)*$', 'nested'],
    ['(.*)*', 'nested'],
    ['((ab)+c?)+', 'nested'],
    ['(?:x+)+y', 'nested'],
    ['(a|aa)*b', 'alternation'],
    ['(a|a)+', 'alternation'],
    ['(a+){2}', 'nested'],
    ['(a?){5}', 'nested'],
    ['.*a.*b.*c.*d', 'unbounded'],
    ['(a)\\1', 'backreference'],
    ['(?<n>a)\\k<n>', 'only plain'],
    ['a(?=b)', 'only plain'],
    ['(?<=a)b', 'only plain'],
    ['(?!a)b', 'only plain'],
    ['a{1,1000}', 'repeat'],
    ['a'.repeat(101), 'longer than 100'],
    ['(unclosed', 'compile'],
    ['', 'empty'],
  ])('rejects %s (%s)', (p, why) => {
    expect(checkRegexPattern(p)).toMatch(new RegExp(why));
  });

  it('accepts exactly 100 chars', () => {
    expect(checkRegexPattern('a'.repeat(100))).toBeNull();
  });

  // ReDoS. An accepted pattern has ≤ 3 unbounded quantifiers, so its backtracking is at worst
  // polynomial (≤ n³) and the native engine caps n at REGEX_INPUT_MAX (next test); a rejected
  // pattern like (a+)+$ is exponential. An absolute ms budget fails on slow shared CI runners,
  // so compare growth on the same machine instead: doubling n multiplies time by ≤ 8 for n³;
  // < 32 leaves room for timer noise, and the exponential control must blow past it.
  const NOISE_MS = 1; // added to both timings so sub-ms runs give a ratio near 1, not noise
  const bestMs = (f: () => void, runs = 3) => {
    let best = Infinity;
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      f();
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  };
  const growth = (run: (n: number) => void, n: number) =>
    (bestMs(() => run(2 * n)) + NOISE_MS) / (bestMs(() => run(n)) + NOISE_MS);

  it('accepted patterns grow polynomially on adversarial input with the native engine', () => {
    const worst = ['.*a.*b.*c', '(\\d+)\\s(\\d+)\\s(\\d+)x', '[a-z]+@[a-z.]+!'];
    for (const p of worst) {
      expect(checkRegexPattern(p)).toBeNull();
      const re = nativeRegexEngine.compile(p);
      for (const unit of ['a', '1 ']) {
        const g = growth((n) => re.firstGroup(unit.repeat(n)), 250);
        expect(g, `${p} on "${unit}"×n: time ×${g.toFixed(1)} when n doubles`).toBeLessThan(32);
      }
    }
    // Control: the same measure catches catastrophic backtracking in a pattern the check rejects.
    const bad = '(a+)+$';
    expect(checkRegexPattern(bad)).not.toBeNull();
    const re = nativeRegexEngine.compile(bad);
    expect(growth((n) => re.firstGroup('a'.repeat(n) + '!'), 12)).toBeGreaterThan(32);
  }, 30_000);

  it('native engine caps input length', () => {
    const re = nativeRegexEngine.compile('(x)');
    expect(re.firstGroup('a'.repeat(REGEX_INPUT_MAX) + 'x')).toBeNull();
    expect(re.firstGroup('a'.repeat(REGEX_INPUT_MAX - 1) + 'x')).toBe('x');
  });
});
