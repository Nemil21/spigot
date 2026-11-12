import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * SP-040: static checks on render.yaml. Render's own schema check (`render blueprints validate`
 * or the dashboard preview) needs an account; docs/deploy.md §Validate has the offline check
 * against render.com/schema/render.yaml.json. These tests pin what the schema can't: no secret
 * values, paid plans, auto-deploy off, and env keys Spigot actually reads.
 */

const root = new URL('../', import.meta.url);
const text = readFileSync(new URL('render.yaml', root), 'utf8');

interface EnvVar {
  key?: string;
  value?: string | number;
  sync?: boolean;
  generateValue?: boolean;
  fromGroup?: string;
  fromDatabase?: { name: string; property: string };
  fromService?: { type: string; name: string; envVarKey?: string; property?: string };
}
interface Service {
  type: string;
  name: string;
  plan?: string;
  buildCommand?: string;
  startCommand: string;
  healthCheckPath?: string;
  autoDeployTrigger?: string;
  numInstances?: number;
  disk?: { name: string; mountPath: string; sizeGB?: number };
  envVars: EnvVar[];
}
interface Blueprint {
  envVarGroups: { name: string; envVars: EnvVar[] }[];
  databases: { name: string; plan: string; postgresMajorVersion: string }[];
  services: Service[];
}

const bp = parse(text) as Blueprint;
const service = (name: string) => {
  const s = bp.services.find((x) => x.name === name);
  if (!s) throw new Error(`no service ${name}`);
  return s;
};
/** A service's env vars with its groups expanded. */
const envOf = (s: Service): EnvVar[] =>
  s.envVars.flatMap((e) =>
    e.fromGroup ? (bp.envVarGroups.find((g) => g.name === e.fromGroup)?.envVars ?? []) : [e],
  );
const envVar = (s: Service, key: string) => envOf(s).find((e) => e.key === key);
const allEnvVars = [
  ...bp.envVarGroups.flatMap((g) => g.envVars),
  ...bp.services.flatMap((s) => s.envVars),
];

const exampleKeys = new Set(
  readFileSync(new URL('.env.example', root), 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l))
    .map((l) => l.split('=')[0]),
);
/** Keys only Render or the demo site reads (not in config.ts / .env.example). */
const RENDER_ONLY = new Set(['NODE_VERSION', 'DEMO_DATA_DIR']);

/** The only keys allowed a literal value in render.yaml: non-secret flags and paths. */
const NON_SECRET = new Set([
  'NODE_VERSION',
  'NODE_ENV',
  'LOG_LEVEL',
  'PAYPAL_API_BASE',
  'PAYPAL_ENV',
  'PAYPAL_MODE',
  'WORKFLOWS_MODE',
  'SCHEMA_AGENT_MODE',
  'CLAUDE_MODEL',
  'DEMO_MODE',
  'ALLOW_MOCK_DECLINE',
  'PAYPAL_WALLET_VAULT',
  'DEMO_DATA_DIR',
  'DEMO_SEED_SCALE',
  'SPIGOT_GATE_DEMO',
]);

describe('render.yaml (SP-040)', () => {
  it('has the API, the demo site, the workflow stub and one database', () => {
    expect(bp.services.map((s) => `${s.type}:${s.name}`).sort()).toEqual([
      'web:bluebonnet-rentals',
      'web:spigot-api',
      'workflow:spigot-workflows',
    ]);
    expect(bp.databases.map((d) => d.name)).toEqual(['spigot-db']);
  });

  it('uses paid plans only (free sleeps; free Postgres expires before Dec 21)', () => {
    expect(bp.databases[0]!.plan).not.toMatch(/^free$/);
    for (const s of bp.services.filter((x) => x.type === 'web')) {
      expect(s.plan, s.name).toBeDefined();
      expect(s.plan, s.name).not.toBe('free');
    }
  });

  it('turns auto-deploy off on every service', () => {
    for (const s of bp.services) expect(s.autoDeployTrigger, s.name).toBe('off');
  });

  it('spigot-api: builds all, migrates then starts, health /api/healthz, one instance', () => {
    const api = service('spigot-api');
    expect(api.buildCommand).toBe('npm ci --include=dev && npm run build');
    expect(api.startCommand).toBe('npm run migrate && npm start');
    expect(api.healthCheckPath).toBe('/api/healthz');
    expect(api.numInstances).toBe(1);
    expect(envVar(api, 'DATABASE_URL')?.fromDatabase).toEqual({
      name: 'spigot-db',
      property: 'connectionString',
    });
  });

  it('runs the PayPal sandbox and in-process workflows by default', () => {
    const api = service('spigot-api');
    expect(envVar(api, 'PAYPAL_API_BASE')?.value).toBe('https://api-m.sandbox.paypal.com');
    expect(envVar(api, 'PAYPAL_ENV')?.value).toBe('sandbox');
    expect(envVar(api, 'PAYPAL_MODE')?.value).toBe('sandbox');
    expect(envVar(api, 'WORKFLOWS_MODE')?.value).toBe('inproc');
  });

  it('gives every service that loads config.ts the keys required at boot', () => {
    const boot = [
      'DATABASE_URL',
      'SESSION_SECRET',
      'PAYPAL_CLIENT_ID',
      'PAYPAL_CLIENT_SECRET',
      'PAYPAL_API_BASE',
      'APP_BASE_URL',
    ];
    for (const name of ['spigot-api', 'spigot-workflows']) {
      const keys = envOf(service(name)).map((e) => e.key);
      expect(keys, name).toEqual(expect.arrayContaining(boot));
    }
  });

  it('workflow service runs payoutRun on the same env group, PayPal app and database as the API (SP-041b)', () => {
    const wf = service('spigot-workflows');
    const api = service('spigot-api');
    const groups = (s: Service) => s.envVars.flatMap((e) => (e.fromGroup ? [e.fromGroup] : []));
    expect(groups(wf)).toEqual(['spigot-config']);
    expect(groups(wf)).toEqual(groups(api));
    expect(envVar(wf, 'DATABASE_URL')?.fromDatabase).toEqual(
      envVar(api, 'DATABASE_URL')?.fromDatabase,
    );
    for (const k of ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'DEMO_PUBLISHER_PAYOUT_EMAIL']) {
      expect(envVar(wf, k)?.sync, k).toBe(false);
    }
    // Group flags (PAYPAL_MODE, WORKFLOWS_MODE, …) are never overridden on the service itself.
    const groupKeys = new Set(
      bp.envVarGroups.find((g) => g.name === 'spigot-config')!.envVars.map((e) => e.key),
    );
    expect(wf.envVars.filter((e) => e.key && groupKeys.has(e.key))).toEqual([]);
    expect(wf.autoDeployTrigger).toBe('off');
  });

  it('demo site: paid, gate env, disk under DEMO_DATA_DIR, admin token shared with the API', () => {
    const site = service('bluebonnet-rentals');
    expect(site.healthCheckPath).toBe('/healthz');
    expect(site.startCommand).toBe('npm start -w @spigot/demo-site');
    expect(envVar(site, 'SPIGOT_GATE_DEMO')?.value).toBe('1');
    for (const k of ['SPIGOT_GATE_KEY', 'SPIGOT_API_BASE', 'SPIGOT_VERIFY_TOKEN']) {
      expect(envVar(site, k)?.sync, k).toBe(false);
    }
    const dataDir = String(envVar(site, 'DEMO_DATA_DIR')?.value);
    expect(site.disk?.mountPath).toBeDefined();
    expect(dataDir.startsWith(`${site.disk!.mountPath}/`)).toBe(true);
    expect(envVar(site, 'DEMO_ADMIN_TOKEN')?.generateValue).toBe(true);

    const api = service('spigot-api');
    expect(envVar(api, 'DEMO_ADMIN_TOKEN')?.fromService).toEqual({
      type: 'web',
      name: 'bluebonnet-rentals',
      envVarKey: 'DEMO_ADMIN_TOKEN',
    });
    expect(envVar(api, 'DEMO_SITE_URL')?.sync).toBe(false);
  });

  it('builds only workspaces that exist', () => {
    const pkg = (dir: string) =>
      (JSON.parse(readFileSync(new URL(`${dir}/package.json`, root), 'utf8')) as { name: string })
        .name;
    const names = new Set(
      [
        'apps/api',
        'apps/demo-site',
        'apps/web',
        'apps/workflows',
        'packages/shared',
        'packages/gate',
        'packages/sdk',
        'db',
      ]
        .filter((d) => existsSync(new URL(`${d}/package.json`, root)))
        .map(pkg),
    );
    for (const s of bp.services) {
      for (const [, ws] of `${s.buildCommand} ${s.startCommand}`.matchAll(
        /-w (@spigot\/[\w-]+)/g,
      )) {
        expect(names.has(ws!), `${s.name}: ${ws}`).toBe(true);
      }
    }
  });

  it('has no secret values: literals only for known non-secret keys', () => {
    for (const e of allEnvVars) {
      if (e.fromGroup) continue;
      if (e.value !== undefined)
        expect(NON_SECRET.has(e.key!), `${e.key} has a literal value`).toBe(true);
      else
        expect(
          e.sync === false || e.generateValue || e.fromDatabase || e.fromService,
          e.key,
        ).toBeTruthy();
    }
  });

  it('only sets keys Spigot reads (.env.example) or Render needs', () => {
    for (const e of allEnvVars) {
      if (e.fromGroup) continue;
      expect(exampleKeys.has(e.key!) || RENDER_ONLY.has(e.key!), e.key).toBe(true);
    }
  });

  it('contains none of the local .env values', () => {
    const envFile = new URL('.env', root);
    if (!existsSync(envFile)) return;
    const local = parseEnv(readFileSync(envFile, 'utf8'));
    // Key names only in the failure message: never print a value.
    const leaked = Object.entries(local)
      .filter(([k, v]) => v && v.length >= 8 && !NON_SECRET.has(k) && text.includes(v))
      .map(([k]) => k);
    expect(leaked).toEqual([]);
  });
});
