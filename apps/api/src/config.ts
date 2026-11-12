import { z } from 'zod';

/**
 * Zod-validated environment (SP-001a). Only DB, session, PayPal and app-URL keys are required at
 * boot; feature keys are checked where the feature is used, via `requireKeys()`.
 *
 * Every key any ticket reads is declared here and in `.env.example`, so later tickets never edit
 * either file. Error messages name keys only, never values: secrets must not reach logs.
 */

const SANDBOX_HOSTS = new Set(['api-m.sandbox.paypal.com', 'api.sandbox.paypal.com']);

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const parseBool = (v: string | undefined, ctx: z.RefinementCtx): boolean | undefined => {
  if (v === undefined || v.trim() === '') return undefined;
  const s = v.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  ctx.addIssue({ code: 'custom', message: 'must be true or false' });
  return z.NEVER;
};

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => parseBool(v, ctx) ?? fallback);

const enumWithDefault = <T extends readonly [string, ...string[]]>(
  values: T,
  fallback: T[number],
) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? fallback : v.trim().toLowerCase()))
    .pipe(z.enum(values));

const isHttpUrl = (v: string) => {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
};

const required = z.string({ error: 'is required' }).trim().min(1, 'is required');

const httpUrl = required.refine(isHttpUrl, 'must be an http(s) URL');

const optionalHttpUrl = optionalString.refine(
  (v) => v === undefined || isHttpUrl(v),
  'must be an http(s) URL',
);

const postgresUrl = (v: string) => /^postgres(ql)?:\/\//.test(v);

const intWithDefault = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? String(fallback) : v.trim()))
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

const envSchema = z.object({
  // Required at boot.
  DATABASE_URL: required.refine(postgresUrl, 'must be a postgres:// or postgresql:// URL'),
  SESSION_SECRET: required.refine((v) => v.length >= 32, 'must be at least 32 characters'),
  PAYPAL_CLIENT_ID: required,
  PAYPAL_CLIENT_SECRET: required,
  PAYPAL_API_BASE: httpUrl,
  APP_BASE_URL: httpUrl,

  // Required only when the feature is used (`requireKeys`).
  ANTHROPIC_API_KEY: optionalString,
  CLAUDE_MODEL: optionalString,
  // OpenAI fallback for the AI features (schema agent, claims triage) when no Anthropic key.
  OPENAI_API_KEY: optionalString,
  OPENAI_MODEL: optionalString,
  // Unset → Anthropic when ANTHROPIC_API_KEY is set, else OpenAI when OPENAI_API_KEY is set.
  AI_PROVIDER: optionalString
    .transform((v) => v?.toLowerCase())
    .pipe(z.enum(['anthropic', 'openai']).optional()),
  AG_GRID_LICENSE_KEY: optionalString,
  PAYPAL_WEBHOOK_ID: optionalString,
  RENDER_API_KEY: optionalString,
  RENDER_WORKFLOWS_SERVICE_ID: optionalString,
  DEMO_PUBLISHER_PAYOUT_EMAIL: optionalString,
  ADMIN_EMAILS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),

  // Flags.
  PAYPAL_MODE: enumWithDefault(['sandbox', 'stub'] as const, 'sandbox'),
  PAYPAL_ENV: enumWithDefault(['sandbox', 'live'] as const, 'sandbox'),
  ALLOW_MOCK_DECLINE: bool(false),
  WORKFLOWS_MODE: enumWithDefault(['inproc', 'workflows'] as const, 'inproc'),
  // Unset → `recorded` under NODE_ENV=test (tests and CI never need ANTHROPIC_API_KEY), else `live`.
  SCHEMA_AGENT_MODE: optionalString
    .transform((v) => v?.toLowerCase())
    .pipe(z.enum(['live', 'recorded']).optional()),
  DEMO_MODE: bool(false),
  // Wallet vault on top-ups stays behind this flag until SP-003's S8b passes.
  PAYPAL_WALLET_VAULT: enumWithDefault(['on', 'off'] as const, 'off'),

  // Demo site, gate and demo tooling.
  SPIGOT_GATE_DEMO: bool(false),
  SPIGOT_VERIFY_TOKEN: optionalString,
  SPIGOT_API_BASE: optionalHttpUrl,
  SPIGOT_GATE_KEY: optionalString,
  DEMO_ADMIN_TOKEN: optionalString,
  DEMO_SITE_URL: optionalHttpUrl,
  // Lets the crawler's SSRF guard reach loopback / private origins (local demo site in dev only).
  ALLOW_LOCAL_ORIGINS: bool(false),
  DEMO_LAYOUT: optionalString,
  DEMO_SEED_SCALE: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? '1' : v.trim()))
    .transform(Number)
    .pipe(z.number().positive('must be a positive number')),
  CRAWL_MIN_GAP_MS: intWithDefault(250, 0, 60_000),
  // `browser` lets templates whose pages render client-side be fetched through headless Chromium
  // (SP-064; needs the optional `playwright` package). Off by default: Chromium is heavy.
  CRAWL_RENDER: enumWithDefault(['off', 'browser'] as const, 'off'),

  // Runtime.
  NODE_ENV: enumWithDefault(['development', 'test', 'production'] as const, 'development'),
  PORT: intWithDefault(3000, 1, 65535),
  HOST: optionalString.transform((v) => v ?? '0.0.0.0'),
  LOG_LEVEL: enumWithDefault(
    ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const,
    'info',
  ),
});

type ParsedEnv = z.infer<typeof envSchema>;

export interface Config extends Omit<ParsedEnv, 'SCHEMA_AGENT_MODE'> {
  readonly SCHEMA_AGENT_MODE: 'live' | 'recorded';
  /** True when `PAYPAL_API_BASE` points at a PayPal sandbox host. */
  readonly paypalIsSandbox: boolean;
}

/** Keys that are optional at boot but required by a feature. */
export type FeatureKey =
  | 'ANTHROPIC_API_KEY'
  | 'CLAUDE_MODEL'
  | 'OPENAI_API_KEY'
  | 'OPENAI_MODEL'
  | 'AG_GRID_LICENSE_KEY'
  | 'PAYPAL_WEBHOOK_ID'
  | 'RENDER_API_KEY'
  | 'RENDER_WORKFLOWS_SERVICE_ID'
  | 'DEMO_PUBLISHER_PAYOUT_EMAIL'
  | 'SPIGOT_VERIFY_TOKEN'
  | 'SPIGOT_API_BASE'
  | 'SPIGOT_GATE_KEY'
  | 'DEMO_ADMIN_TOKEN'
  | 'DEMO_SITE_URL'
  | 'DEMO_LAYOUT';

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly problems: string[],
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class MissingFeatureConfigError extends Error {
  constructor(
    readonly feature: string,
    readonly missing: string[],
  ) {
    super(
      `${feature} is not configured: set ${missing.join(', ')} in the environment (see .env.example).`,
    );
    this.name = 'MissingFeatureConfigError';
  }
}

export function isSandboxPayPalBase(base: string): boolean {
  try {
    const u = new URL(base);
    return u.protocol === 'https:' && SANDBOX_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function refuse(problems: string[]): never {
  throw new ConfigError(
    `Invalid environment, refusing to boot:\n  - ${problems.join('\n  - ')}\nSee .env.example.`,
    problems,
  );
}

/**
 * Parse and validate an environment. Pure: pass `process.env` or a test object.
 * Throws `ConfigError` listing every problem (key names only).
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    refuse(result.error.issues.map((i) => `${i.path.join('.') || '(env)'} ${i.message}`));
  }
  const parsed = result.data;
  const paypalIsSandbox = isSandboxPayPalBase(parsed.PAYPAL_API_BASE);

  // Live-base guard: a non-sandbox PayPal base needs an explicit PAYPAL_ENV=live.
  if (!paypalIsSandbox && parsed.PAYPAL_ENV !== 'live') {
    refuse([
      'PAYPAL_API_BASE is not a PayPal sandbox host; set PAYPAL_ENV=live to use a live base',
    ]);
  }

  return Object.freeze({
    ...parsed,
    SCHEMA_AGENT_MODE:
      parsed.SCHEMA_AGENT_MODE ?? (parsed.NODE_ENV === 'test' ? 'recorded' : 'live'),
    // Mock declines are a sandbox-only demo aid: never allowed against a live base.
    ALLOW_MOCK_DECLINE: paypalIsSandbox ? parsed.ALLOW_MOCK_DECLINE : false,
    // Turns off the crawler's SSRF guard for a local demo site: never in production.
    ALLOW_LOCAL_ORIGINS: parsed.NODE_ENV === 'production' ? false : parsed.ALLOW_LOCAL_ORIGINS,
    paypalIsSandbox,
  });
}

/**
 * Return the named feature keys, or throw `MissingFeatureConfigError` naming the missing ones.
 * Call this where the feature is used (e.g. the Claude client constructor), not at boot.
 */
export function requireKeys<K extends FeatureKey>(
  config: Config,
  feature: string,
  ...keys: K[]
): { [P in K]: string } {
  const missing = keys.filter((k) => !config[k]);
  if (missing.length) throw new MissingFeatureConfigError(feature, missing);
  return Object.fromEntries(keys.map((k) => [k, config[k] as string])) as { [P in K]: string };
}

export type AiProvider = 'anthropic' | 'openai';

/**
 * Which model API the live AI features use: `AI_PROVIDER` if set; otherwise Anthropic when
 * `ANTHROPIC_API_KEY` is set (unchanged behaviour), else OpenAI when `OPENAI_API_KEY` is set,
 * else Anthropic (whose missing key is then reported by `requireKeys`).
 */
export function aiProviderFor(config: Config): AiProvider {
  if (config.AI_PROVIDER) return config.AI_PROVIDER;
  if (config.ANTHROPIC_API_KEY) return 'anthropic';
  if (config.OPENAI_API_KEY) return 'openai';
  return 'anthropic';
}

/** Admin emails, for `ADMIN_EMAILS`-gated routes. Throws if none are configured. */
export function requireAdminEmails(config: Config): string[] {
  if (!config.ADMIN_EMAILS.length) {
    throw new MissingFeatureConfigError('Admin access', ['ADMIN_EMAILS']);
  }
  return config.ADMIN_EMAILS;
}

/** Case-insensitive admin check against `ADMIN_EMAILS`. */
export function isAdminEmail(config: Config, email: string | null | undefined): boolean {
  return !!email && config.ADMIN_EMAILS.includes(email.trim().toLowerCase());
}

/** Whether `PayPal-Mock-Response` may be sent: only on a sandbox base with DEMO_MODE + ALLOW_MOCK_DECLINE. */
export function mockDeclinesAllowed(config: Config): boolean {
  return config.paypalIsSandbox && config.DEMO_MODE && config.ALLOW_MOCK_DECLINE;
}
