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

  it('accepted patterns stay fast on adversarial input with the native engine', () => {
    const worst = ['.*a.*b.*c', '(\\d+)\\s(\\d+)\\s(\\d+)x', '[a-z]+@[a-z.]+!'];
    for (const p of worst) {
      expect(checkRegexPattern(p)).toBeNull();
      const re = nativeRegexEngine.compile(p);
      const t0 = performance.now();
      re.firstGroup('a'.repeat(50_000));
      re.firstGroup('1 '.repeat(50_000));
      expect(performance.now() - t0).toBeLessThan(1000);
    }
  });

  it('native engine caps input length', () => {
    const re = nativeRegexEngine.compile('(x)');
    expect(re.firstGroup('a'.repeat(REGEX_INPUT_MAX) + 'x')).toBeNull();
    expect(re.firstGroup('a'.repeat(REGEX_INPUT_MAX - 1) + 'x')).toBe('x');
  });
});
