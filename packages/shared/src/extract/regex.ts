// `regex:<pattern>` transform safety (features/04 §3). Patterns are model-written, so treat them
// as hostile. Two layers:
// 1. `checkRegexPattern` (pure, used by the Zod spec): ≤ 100 chars, RE2-compatible syntax only
//    (no backreferences, lookaround or named groups), no quantified group that itself contains a
//    variable-width quantifier or an alternation, at most 3 unbounded quantifiers. Rejected
//    patterns never reach an engine.
// 2. A `RegexEngine` runs accepted patterns. The API injects RE2 (linear time;
//    apps/api/src/extract/adapters.ts). The browser-safe default, `nativeRegexEngine`, is a
//    backtracking engine, so it gets a provable work bound instead: each pattern gets an input
//    cap n (≤ `REGEX_INPUT_MAX`) small enough that its static path bound stays within
//    `NATIVE_STEP_BUDGET`, and a pattern whose cap would drop below `NATIVE_MIN_INPUT` is
//    refused (throws at compile, so the field reads as null). `\d+\d+\d+x` passes layer 1 (RE2
//    runs it in linear time) but is refused by the native engine.
//
// The bound: with no quantified group containing a variable quantifier or alternation (layer 1),
// the ways a backtracking engine can match from one start offset are at most the product of every
// quantifier's range (`*`/`+`/`{n,}` → n + 1, `?` → 2, `{a,b}` → b − a + 1) and every group's (and
// the top level's) alternation branch count. With u unbounded quantifiers and the rest multiplied
// into `fixedPaths`, an unanchored `exec` over n chars explores at most
// (n + 1)^(u + 1) × fixedPaths paths (the extra factor is the start offsets).

export const REGEX_MAX_LENGTH = 100;
/** Native-engine input cap for the least ambiguous patterns. */
export const REGEX_INPUT_MAX = 1000;
/** Native-engine budget for the static path bound. */
export const NATIVE_STEP_BUDGET = 10_000_000;
/** A pattern that would need a smaller input cap than this is refused by the native engine. */
export const NATIVE_MIN_INPUT = 200;
const MAX_UNBOUNDED = 3;
const MAX_REPEAT = 100;

export interface CompiledRegex {
  /** Capture group 1 if the pattern has one, else the whole match; `null` on no match. */
  firstGroup(input: string): string | null;
}

export interface RegexEngine {
  /** Throws if the pattern doesn't compile. */
  compile(pattern: string): CompiledRegex;
}

/**
 * Browser-safe default (backtracking). Throws for a pattern that fails `checkRegexPattern` or
 * whose static bound exceeds `NATIVE_STEP_BUDGET`; the transform then yields `null`.
 */
export const nativeRegexEngine: RegexEngine = {
  compile(pattern) {
    const analysis = analyzeRegex(pattern);
    if (analysis.problem) throw new Error(`unsafe regex: ${analysis.problem}`);
    const cap = nativeInputCap(analysis);
    if (cap === null) throw new Error('regex is too ambiguous for the native engine; use RE2');
    const re = new RegExp(pattern, 'u');
    return {
      firstGroup(input) {
        const m = re.exec(input.slice(0, cap));
        if (!m) return null;
        return (m.length > 1 ? m[1] : m[0]) ?? null;
      },
    };
  },
};

/** Static path bound for an unanchored native `exec` over `n` chars. */
export function nativeSteps(a: RegexAnalysis, n: number): number {
  return (n + 1) ** (a.unbounded + 1) * a.fixedPaths;
}

/**
 * The largest input length (≤ `REGEX_INPUT_MAX`) whose bound fits `NATIVE_STEP_BUDGET`, or `null`
 * if that is below `NATIVE_MIN_INPUT` (or the pattern failed layer 1).
 */
export function nativeInputCap(a: RegexAnalysis): number | null {
  if (a.problem) return null;
  let n = Math.min(
    REGEX_INPUT_MAX,
    Math.floor((NATIVE_STEP_BUDGET / a.fixedPaths) ** (1 / (a.unbounded + 1))) - 1,
  );
  while (n >= NATIVE_MIN_INPUT && nativeSteps(a, n) > NATIVE_STEP_BUDGET) n -= 1; // float error
  return n >= NATIVE_MIN_INPUT ? n : null;
}

interface GroupFrame {
  /** Contains a variable-width quantifier (`*`, `+`, `?`, `{n,m}` with n < m). */
  hasQuantifier: boolean;
  hasAlternation: boolean;
  /** Alternation branches directly in this group. */
  branches: number;
}

export interface RegexAnalysis {
  /** Why the pattern is unsafe or unsupported; `null` if it passes layer 1. */
  problem: string | null;
  /** Unbounded quantifiers (`*`, `+`, `{n,}`). */
  unbounded: number;
  /** Product of bounded quantifier ranges and alternation branch counts (see the header). */
  fixedPaths: number;
}

/** Returns a reason string if the pattern is unsafe or unsupported, else `null`. */
export function checkRegexPattern(pattern: string): string | null {
  return analyzeRegex(pattern).problem;
}

const frame = (): GroupFrame => ({ hasQuantifier: false, hasAlternation: false, branches: 1 });

export function analyzeRegex(pattern: string): RegexAnalysis {
  const fail = (problem: string): RegexAnalysis => ({
    problem,
    unbounded: 0,
    fixedPaths: Infinity,
  });
  if (pattern.length === 0) return fail('regex is empty');
  if (pattern.length > REGEX_MAX_LENGTH)
    return fail(`regex is longer than ${REGEX_MAX_LENGTH} chars`);
  try {
    new RegExp(pattern, 'u');
  } catch {
    return fail('regex does not compile');
  }

  const stack: GroupFrame[] = [frame()];
  let paths = 1;
  // What the next quantifier would apply to: a group frame, a plain atom, or nothing.
  let lastAtom: GroupFrame | 'atom' | null = null;
  let unbounded = 0;
  let i = 0;

  const top = () => stack[stack.length - 1]!;

  while (i < pattern.length) {
    const c = pattern[i]!;

    if (c === '\\') {
      const n = pattern[i + 1] ?? '';
      if (/[1-9]/.test(n) || n === 'k') return fail('backreferences are not allowed');
      if (n === 'p' || n === 'P' || n === 'u' || n === 'x') {
        // \p{..}, \u{..} / \uXXXX, \xXX: skip the whole escape.
        const brace = pattern[i + 2] === '{' ? pattern.indexOf('}', i + 2) : -1;
        i = brace > 0 ? brace + 1 : i + 2;
      } else {
        i += 2;
      }
      lastAtom = 'atom';
      continue;
    }

    if (c === '[') {
      // Character class: one atom. Skip to the matching unescaped `]`.
      i += 1;
      if (pattern[i] === '^') i += 1;
      if (pattern[i] === ']') i += 1;
      while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1;
      i += 1;
      lastAtom = 'atom';
      continue;
    }

    if (c === '(') {
      if (pattern[i + 1] === '?') {
        if (pattern[i + 2] !== ':') return fail('only plain and (?:) groups are allowed');
        i += 3;
      } else {
        i += 1;
      }
      stack.push(frame());
      lastAtom = null;
      continue;
    }

    if (c === ')') {
      const closed = stack.pop()!;
      const parent = top();
      parent.hasQuantifier ||= closed.hasQuantifier;
      parent.hasAlternation ||= closed.hasAlternation;
      paths *= closed.branches;
      lastAtom = closed;
      i += 1;
      continue;
    }

    if (c === '|') {
      top().hasAlternation = true;
      top().branches += 1;
      lastAtom = null;
      i += 1;
      continue;
    }

    if (c === '*' || c === '+' || c === '?' || c === '{') {
      let isUnbounded = c === '*' || c === '+';
      let isVariable = true;
      let range = c === '?' ? 2 : 1; // unbounded ranges are counted in `unbounded`
      let len = 1;
      if (c === '{') {
        const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
        if (!m) {
          // A literal `{` (allowed by the `u` flag only when it is a valid quantifier, so this
          // branch is unreachable after the compile check; kept defensive).
          lastAtom = 'atom';
          i += 1;
          continue;
        }
        const min = Number(m[1]);
        const max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
        if (min > MAX_REPEAT || (max !== Infinity && max > MAX_REPEAT)) {
          return fail(`repeat counts above ${MAX_REPEAT} are not allowed`);
        }
        isUnbounded = max === Infinity;
        isVariable = min !== max;
        range = max === Infinity ? 1 : max - min + 1;
        len = m[0].length;
      }
      if (lastAtom && lastAtom !== 'atom') {
        if (lastAtom.hasQuantifier)
          return fail('nested quantifiers can backtrack catastrophically');
        if (lastAtom.hasAlternation) {
          return fail('quantified alternation can backtrack catastrophically');
        }
      }
      if (isUnbounded) unbounded += 1;
      if (unbounded > MAX_UNBOUNDED)
        return fail(`more than ${MAX_UNBOUNDED} unbounded quantifiers`);
      if (isVariable) top().hasQuantifier = true;
      paths *= range;
      i += len;
      if (pattern[i] === '?') i += 1; // lazy modifier
      lastAtom = null;
      continue;
    }

    lastAtom = 'atom';
    i += 1;
  }
  paths *= stack[0]!.branches;
  return { problem: null, unbounded, fixedPaths: paths };
}
