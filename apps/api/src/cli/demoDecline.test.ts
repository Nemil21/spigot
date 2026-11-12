import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { REQUIRED_ENV } from '../test/env.js';
import { assertMockDeclines, formatDecline } from './demoDecline.js';

const config = (env: Record<string, string> = {}) => loadConfig({ ...REQUIRED_ENV, ...env });

describe('demo:decline guard (SP-047b)', () => {
  it('needs DEMO_MODE + ALLOW_MOCK_DECLINE on a sandbox base', () => {
    expect(() => assertMockDeclines(config())).toThrow(/ALLOW_MOCK_DECLINE=true/);
    expect(() => assertMockDeclines(config({ DEMO_MODE: 'true' }))).toThrow(/sandbox/);
    expect(() => assertMockDeclines(config({ ALLOW_MOCK_DECLINE: 'true' }))).toThrow();
    expect(() =>
      assertMockDeclines(config({ DEMO_MODE: 'true', ALLOW_MOCK_DECLINE: 'true' })),
    ).not.toThrow();
  });

  it('warns when auto top-up could not run yet', () => {
    const base = { buyerId: 'b', email: 'acme@acme-agents.example.com' };
    expect(formatDecline({ ...base, armed: true, autoTopupReady: true }).join('\n')).not.toMatch(
      /warning/,
    );
    expect(formatDecline({ ...base, armed: true, autoTopupReady: false }).join('\n')).toMatch(
      /warning: auto top-up is off/,
    );
    expect(formatDecline({ ...base, armed: false, autoTopupReady: true })[0]).toMatch(/cleared/);
  });
});
