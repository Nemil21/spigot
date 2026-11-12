// `regex:<pattern>` transform safety (features/04 §3). Patterns are model-written, so treat them
// as hostile. Two layers:
// 1. `checkRegexPattern` (pure, used by the Zod spec): ≤ 100 chars, RE2-compatible syntax only
//    (no backreferences, lookaround or named groups) and no construct that can backtrack
//    catastrophically (a quantified group that itself contains a variable-width quantifier or an
//    alternation, or more than 3 unbounded quantifiers). Rejected patterns never reach an engine.
// 2. A `RegexEngine` runs accepted patterns. The API injects RE2 (apps/api/src/extract/adapters.ts, linear
//    time); the
//    browser-safe default is native RegExp over input capped at `REGEX_INPUT_MAX` chars.

export const REGEX_MAX_LENGTH = 100;
/** Native-engine input cap. With ≤ 3 unbounded quantifiers worst case stays well under 100 ms. */
export const REGEX_INPUT_MAX = 1000;
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

/** Browser-safe default. Only ever sees patterns that passed `checkRegexPattern`. */
export const nativeRegexEngine: RegexEngine = {
  compile(pattern) {
    const re = new RegExp(pattern, 'u');
    return {
      firstGroup(input) {
        const m = re.exec(input.slice(0, REGEX_INPUT_MAX));
        if (!m) return null;
        return m.length > 1 ? (m[1] ?? null) : m[0];
      },
    };
  },
};

interface GroupFrame {
  /** Contains a variable-width quantifier (`*`, `+`, `?`, `{n,m}` with n < m). */
  hasQuantifier: boolean;
  hasAlternation: boolean;
}

/** Returns a reason string if the pattern is unsafe or unsupported, else `null`. */
export function checkRegexPattern(pattern: string): string | null {
  if (pattern.length === 0) return 'regex is empty';
  if (pattern.length > REGEX_MAX_LENGTH) return `regex is longer than ${REGEX_MAX_LENGTH} chars`;
  try {
    new RegExp(pattern, 'u');
  } catch {
    return 'regex does not compile';
  }

  const stack: GroupFrame[] = [{ hasQuantifier: false, hasAlternation: false }];
  // What the next quantifier would apply to: a group frame, a plain atom, or nothing.
  let lastAtom: GroupFrame | 'atom' | null = null;
  let unbounded = 0;
  let i = 0;

  const top = () => stack[stack.length - 1]!;

  while (i < pattern.length) {
    const c = pattern[i]!;

    if (c === '\\') {
      const n = pattern[i + 1] ?? '';
      if (/[1-9]/.test(n) || n === 'k') return 'backreferences are not allowed';
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
        if (pattern[i + 2] !== ':') return 'only plain and (?:) groups are allowed';
        i += 3;
      } else {
        i += 1;
      }
      stack.push({ hasQuantifier: false, hasAlternation: false });
      lastAtom = null;
      continue;
    }

    if (c === ')') {
      const frame = stack.pop()!;
      const parent = top();
      parent.hasQuantifier ||= frame.hasQuantifier;
      parent.hasAlternation ||= frame.hasAlternation;
      lastAtom = frame;
      i += 1;
      continue;
    }

    if (c === '|') {
      top().hasAlternation = true;
      lastAtom = null;
      i += 1;
      continue;
    }

    if (c === '*' || c === '+' || c === '?' || c === '{') {
      let isUnbounded = c === '*' || c === '+';
      let isVariable = true;
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
          return `repeat counts above ${MAX_REPEAT} are not allowed`;
        }
        isUnbounded = max === Infinity;
        isVariable = min !== max;
        len = m[0].length;
      }
      if (lastAtom && lastAtom !== 'atom') {
        if (lastAtom.hasQuantifier) return 'nested quantifiers can backtrack catastrophically';
        if (lastAtom.hasAlternation) return 'quantified alternation can backtrack catastrophically';
      }
      if (isUnbounded) unbounded += 1;
      if (unbounded > MAX_UNBOUNDED) return `more than ${MAX_UNBOUNDED} unbounded quantifiers`;
      if (isVariable) top().hasQuantifier = true;
      i += len;
      if (pattern[i] === '?') i += 1; // lazy modifier
      lastAtom = null;
      continue;
    }

    lastAtom = 'atom';
    i += 1;
  }
  return null;
}
