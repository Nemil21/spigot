// The gate has zero runtime deps, so it mirrors `@spigot/shared` shapes by hand. These tests
// (test-only imports) keep the two in step.
import { describe, expect, it } from 'vitest';
import {
  BOT_CATEGORIES,
  HIT_CATEGORIES,
  HUMAN_BOT_NAME as SHARED_HUMAN,
  gatePolicySchema,
} from '@spigot/shared/gate';
import { formatMicros } from '@spigot/shared/money';
import { dollarsPer1000 } from './body402.js';
import { HUMAN_BOT_NAME } from './classify.js';
import { CATEGORIES, POLICY_CATEGORIES, parsePolicy } from './policy.js';
import { demoPolicyWire } from './fixtures.test-helpers.js';

describe('parity with @spigot/shared', () => {
  it('categories and the human bot name match', () => {
    expect([...POLICY_CATEGORIES]).toEqual([...BOT_CATEGORIES]);
    expect([...CATEGORIES]).toEqual([...HIT_CATEGORIES]);
    expect(HUMAN_BOT_NAME).toBe(SHARED_HUMAN);
  });

  it('a policy the API validates is one the gate parses', () => {
    const wire = gatePolicySchema.parse(demoPolicyWire());
    const p = parsePolicy(wire);
    expect(p.wire.crawlKeySha256).toBe(wire.crawlKeySha256);
    expect(p.wire.gatedPaths).toEqual(wire.gatedPaths);
    expect(p.decisions).toEqual(wire.decisions);
  });

  it('price text matches the shared money formatter', () => {
    for (const m of [0, 1, 5, 10, 99, 500, 1234, 1500, 55_500, 2_500_000]) {
      expect(dollarsPer1000(m)).toBe(formatMicros(m * 1000));
    }
  });
});
