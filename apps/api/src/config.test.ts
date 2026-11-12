import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  MissingFeatureConfigError,
  isSandboxPayPalBase,
  loadConfig,
  mockDeclinesAllowed,
  requireAdminEmails,
  requireKeys,
} from './config.js';
import { REQUIRED_ENV } from './test/env.js';

const REQUIRED_KEYS = Object.keys(REQUIRED_ENV);

function configError(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err as ConfigError;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('boots with only the required keys and applies defaults', () => {
    const config = loadConfig({ ...REQUIRED_ENV });
    expect(config.paypalIsSandbox).toBe(true);
    expect(config.PAYPAL_MODE).toBe('sandbox');
    expect(config.PAYPAL_ENV).toBe('sandbox');
    expect(config.WORKFLOWS_MODE).toBe('inproc');
    expect(config.SCHEMA_AGENT_MODE).toBe('live');
    expect(config.PAYPAL_WALLET_VAULT).toBe('off');
    expect(config.ALLOW_MOCK_DECLINE).toBe(false);
    expect(config.DEMO_MODE).toBe(false);
    expect(config.ADMIN_EMAILS).toEqual([]);
    expect(config.PORT).toBe(3000);
    expect(config.ANTHROPIC_API_KEY).toBeUndefined();
    expect(Object.isFrozen(config)).toBe(true);
  });

  it.each(REQUIRED_KEYS)('fails fast naming %s when it is missing', (key) => {
    const env = { ...REQUIRED_ENV, [key]: undefined };
    const err = configError(env);
    expect(err.problems).toEqual([`${key} is required`]);
    expect(err.message).toContain(key);
  });

  it('treats a blank required key as missing', () => {
    expect(configError({ ...REQUIRED_ENV, PAYPAL_CLIENT_ID: '   ' }).problems).toEqual([
      'PAYPAL_CLIENT_ID is required',
    ]);
  });

  it('lists every problem at once, naming keys and never values', () => {
    const err = configError({
      ...REQUIRED_ENV,
      DATABASE_URL: 'mysql://secret-host/db',
      SESSION_SECRET: 'short-secret-value',
      APP_BASE_URL: 'not a url',
      WORKFLOWS_MODE: 'lambda',
      DEMO_MODE: 'maybe',
    });
    const keys = err.problems.map((p) => p.split(' ')[0]);
    expect(keys.sort()).toEqual(
      ['APP_BASE_URL', 'DATABASE_URL', 'DEMO_MODE', 'SESSION_SECRET', 'WORKFLOWS_MODE'].sort(),
    );
    expect(err.message).not.toContain('secret-host');
    expect(err.message).not.toContain('short-secret-value');
  });

  it('parses flags', () => {
    const config = loadConfig({
      ...REQUIRED_ENV,
      PAYPAL_MODE: 'STUB',
      WORKFLOWS_MODE: 'workflows',
      SCHEMA_AGENT_MODE: 'recorded',
      DEMO_MODE: '1',
      ALLOW_MOCK_DECLINE: 'true',
      PAYPAL_WALLET_VAULT: 'on',
      ADMIN_EMAILS: ' Ops@Example.com, ,b@example.com',
      CRAWL_MIN_GAP_MS: '500',
    });
    expect(config.PAYPAL_MODE).toBe('stub');
    expect(config.WORKFLOWS_MODE).toBe('workflows');
    expect(config.SCHEMA_AGENT_MODE).toBe('recorded');
    expect(config.PAYPAL_WALLET_VAULT).toBe('on');
    expect(config.ADMIN_EMAILS).toEqual(['ops@example.com', 'b@example.com']);
    expect(config.CRAWL_MIN_GAP_MS).toBe(500);
    expect(mockDeclinesAllowed(config)).toBe(true);
  });

  describe('live-base guard', () => {
    const LIVE = 'https://api-m.paypal.com';

    it('refuses a non-sandbox PayPal base without PAYPAL_ENV=live', () => {
      const err = configError({ ...REQUIRED_ENV, PAYPAL_API_BASE: LIVE });
      expect(err.message).toContain('PAYPAL_API_BASE is not a PayPal sandbox host');
      expect(err.message).toContain('PAYPAL_ENV=live');
    });

    it('refuses a look-alike host and plain http to the sandbox', () => {
      for (const base of [
        'https://api-m.sandbox.paypal.com.evil.example',
        'http://api-m.sandbox.paypal.com',
        'http://localhost:4010',
      ]) {
        expect(() => loadConfig({ ...REQUIRED_ENV, PAYPAL_API_BASE: base })).toThrow(ConfigError);
      }
    });

    it('accepts a live base with PAYPAL_ENV=live and forces ALLOW_MOCK_DECLINE off', () => {
      const config = loadConfig({
        ...REQUIRED_ENV,
        PAYPAL_API_BASE: LIVE,
        PAYPAL_ENV: 'live',
        DEMO_MODE: 'true',
        ALLOW_MOCK_DECLINE: 'true',
      });
      expect(config.paypalIsSandbox).toBe(false);
      expect(config.ALLOW_MOCK_DECLINE).toBe(false);
      expect(mockDeclinesAllowed(config)).toBe(false);
    });

    it('knows both sandbox hosts', () => {
      expect(isSandboxPayPalBase('https://api-m.sandbox.paypal.com')).toBe(true);
      expect(isSandboxPayPalBase('https://api.sandbox.paypal.com/')).toBe(true);
      expect(isSandboxPayPalBase('https://api-m.paypal.com')).toBe(false);
    });
  });
});

describe('feature keys', () => {
  const config = loadConfig({ ...REQUIRED_ENV, CLAUDE_MODEL: 'claude-test' });

  it('a missing optional key fails only when its feature asks for it', () => {
    expect(() => requireKeys(config, 'Schema agent', 'ANTHROPIC_API_KEY', 'CLAUDE_MODEL')).toThrow(
      new MissingFeatureConfigError('Schema agent', ['ANTHROPIC_API_KEY']),
    );
    expect(() => requireAdminEmails(config)).toThrow(/ADMIN_EMAILS/);
  });

  it('returns the values when present', () => {
    expect(requireKeys(config, 'Schema agent', 'CLAUDE_MODEL')).toEqual({
      CLAUDE_MODEL: 'claude-test',
    });
  });
});
