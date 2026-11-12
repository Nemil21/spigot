import { describe, expect, it } from 'vitest';
import {
  analyzeRegex,
  checkRegexPattern,
  NATIVE_MIN_INPUT,
  NATIVE_STEP_BUDGET,
  nativeInputCap,
  nativeRegexEngine,
  nativeSteps,
  REGEX_INPUT_MAX,
} from './regex.js';

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

  // Review on PR #16: adjacent overlapping quantifiers pass the spec check (RE2 runs them in
  // linear time) but are polynomial on a backtracking engine, so the native engine refuses them.
  const AMBIGUOUS = [
    '\\d+\\d+\\d+x',
    '\\s*\\s*\\s*$',
    '.*a.*b.*c',
    '\\d{0,100}\\d{0,100}\\d{0,100}x',
    '(a|b|c|d)'.repeat(10) + 'x',
    'a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?aaaaaaaaaaaaaaaaaaaaaaaa',
  ];

  it.each(AMBIGUOUS)('native engine refuses %s (over the step budget)', (p) => {
    const a = analyzeRegex(p);
    expect(a.problem).toBeNull(); // RE2 may still run it
    expect(nativeSteps(a, NATIVE_MIN_INPUT)).toBeGreaterThan(NATIVE_STEP_BUDGET);
    expect(nativeInputCap(a)).toBeNull();
    expect(() => nativeRegexEngine.compile(p)).toThrow(/too ambiguous|unsafe/);
  });

  it('native engine refuses patterns that fail the spec check', () => {
    expect(() => nativeRegexEngine.compile('(a+)+$')).toThrow(/unsafe/);
  });

  // The most ambiguous shapes still under budget, on input built to make them backtrack.
  const BOUNDED = [
    '\\d+x',
    '\\d+\\d+x',
    '(\\d+)\\s*sq',
    '(\\d+)\\s?\\d?\\d?x',
    '\\s*$',
    '.*a',
    '[a-z]+@[a-z.]+',
    '(\\d{1,3}(?:,\\d{3})*)x',
    '\\d{0,100}\\d{0,100}x',
    '(a|ab)(a|ab)(a|ab)(a|ab)(a|ab)(a|ab)(a|ab)(a|ab)(a|ab)(a|ab)x',
  ];
  const ADVERSARIAL = [
    '1'.repeat(5000),
    ' '.repeat(5000) + 'x',
    'b'.repeat(5000),
    'ab'.repeat(2500),
    'a@'.repeat(2500),
    '1,'.repeat(2500),
  ];

  it.each(BOUNDED)('native engine accepts %s and stays fast on adversarial input', (p) => {
    const a = analyzeRegex(p);
    const cap = nativeInputCap(a);
    expect(cap).not.toBeNull();
    expect(nativeSteps(a, cap!)).toBeLessThanOrEqual(NATIVE_STEP_BUDGET);
    const re = nativeRegexEngine.compile(p);
    const t0 = performance.now();
    for (const input of ADVERSARIAL) re.firstGroup(input);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('native engine caps input length per pattern', () => {
    // One unbounded quantifier: the full cap.
    expect(nativeInputCap(analyzeRegex('(x)'))).toBe(REGEX_INPUT_MAX);
    const re = nativeRegexEngine.compile('(x)');
    expect(re.firstGroup('a'.repeat(REGEX_INPUT_MAX) + 'x')).toBeNull();
    expect(re.firstGroup('a'.repeat(REGEX_INPUT_MAX - 1) + 'x')).toBe('x');
    // Two unbounded quantifiers: a smaller cap, still above the minimum.
    const cap = nativeInputCap(analyzeRegex('(\\d+)\\s*sq'))!;
    expect(cap).toBeGreaterThanOrEqual(NATIVE_MIN_INPUT);
    expect(cap).toBeLessThan(REGEX_INPUT_MAX);
    expect(nativeRegexEngine.compile('(\\d+)\\s*sq').firstGroup('910 sq ft')).toBe('910');
  });
});
