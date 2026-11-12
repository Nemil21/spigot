import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { api as defaultApi, ApiError, type ApiClient } from '../api/client';
import { EmptyState, ErrorBanner, errorMessage, SkeletonText } from '../components';
import type { AuthMe } from '../layout/session';
import { PayPalButton, PayPalNotice } from '../components/PayPalSignIn';
import { paths } from '../routes';

/**
 * W16 Settings (SP-034; screens.md §W16). Four tabs, `?tab=` in the URL:
 * - Account: name (`PATCH /api/publishers/me`).
 * - Payout: PayPal payout email; applies to the next batch. "Connect with PayPal" (SP-058) logs
 *   in with PayPal and sets the payout email to the verified PayPal email; the callback comes
 *   back to `?tab=payout&paypal=<reason>`.
 * - Gate policy: per-category Pass / Send to API and gated path regexes
 *   (`PATCH /api/sites/:id/policy`); the gate picks a change up within 60 s.
 * - Keys: rotate the gate or crawl key (`POST /api/sites/:id/keys/rotate`); the new key is shown
 *   once.
 * States: loading skeletons, error banner with retry, saved toast, inline validation errors.
 */

export const TABS = [
  { id: 'account', label: 'Account' },
  { id: 'payout', label: 'Payout' },
  { id: 'policy', label: 'Gate policy' },
  { id: 'keys', label: 'Keys' },
] as const;
type TabId = (typeof TABS)[number]['id'];

export type Category = 'SEARCH' | 'AI_TRAINING' | 'AI_AGENT' | 'SCRAPER_TOOL' | 'UNKNOWN';
export type Decision = 'PASS' | 'QUOTE';

export const CATEGORIES: { id: Category; label: string; hint: string }[] = [
  {
    id: 'SEARCH',
    label: 'Search engines',
    hint: 'Googlebot, Bingbot, … Always pass, so your SEO is safe.',
  },
  { id: 'AI_TRAINING', label: 'AI training crawlers', hint: 'GPTBot, ClaudeBot, CCBot, …' },
  {
    id: 'AI_AGENT',
    label: 'AI agents',
    hint: 'ChatGPT-User, Claude-User, Perplexity, … fetching for a person.',
  },
  {
    id: 'SCRAPER_TOOL',
    label: 'Scraper tools',
    hint: 'python-requests, curl, Scrapy, headless browsers, …',
  },
  { id: 'UNKNOWN', label: 'Other bots', hint: 'Self-identified bots we don’t recognise.' },
];

export const MAX_GATED_PATHS = 50;
const MAX_GATED_PATH_LENGTH = 500;
const TOAST_MS = 4000;

interface SiteSummary {
  id: string;
  origin: string;
  policy: Record<string, unknown>;
  policyVersion: number;
}

interface Loaded {
  publisher: NonNullable<AuthMe['publisher']>;
  sites: SiteSummary[];
}

/** One error per line of the gated-path box, or null when every line is a valid regex. */
export function gatedPathErrors(lines: string[]): (string | null)[] {
  return lines.map((line) => {
    if (line.length > MAX_GATED_PATH_LENGTH)
      return `Keep it under ${MAX_GATED_PATH_LENGTH} characters.`;
    try {
      new RegExp(line);
      return null;
    } catch {
      return 'Not a valid regular expression.';
    }
  });
}

function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function decisionsOf(policy: Record<string, unknown>): Record<Category, Decision> {
  const out = {} as Record<Category, Decision>;
  for (const c of CATEGORIES) {
    const v = policy[c.id];
    out[c.id] =
      c.id === 'SEARCH'
        ? 'PASS'
        : v === 'PASS' || v === 'QUOTE'
          ? v
          : c.id === 'UNKNOWN'
            ? 'PASS'
            : 'QUOTE';
  }
  return out;
}

function gatedPathsOf(policy: Record<string, unknown>): string[] {
  const v = policy.gated_paths;
  return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : [];
}

/** Field errors from a `400 VALIDATION_ERROR`'s `details.issues`, keyed by `path`. */
function issuesOf(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || err.code !== 'VALIDATION_ERROR') return {};
  const issues = (err.details as { issues?: { path: string; message: string }[] }).issues ?? [];
  return Object.fromEntries(issues.map((i) => [i.path, i.message]));
}

// ---------------------------------------------------------------------------------------------

export default function SettingsPage({ client = defaultApi }: { client?: ApiClient }) {
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const tab: TabId = TABS.some((t) => t.id === tabParam) ? (tabParam as TabId) : 'account';

  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'ready'; data: Loaded }
  >({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    Promise.all([
      client.get<AuthMe>('/api/auth/me'),
      client.get<{ sites: SiteSummary[] }>('/api/sites'),
    ]).then(
      ([me, { sites }]) => {
        if (!live) return;
        if (!me.publisher) {
          setState({
            status: 'error',
            error: new Error('Sign in as a publisher to see settings.'),
          });
          return;
        }
        setState({ status: 'ready', data: { publisher: me.publisher, sites } });
        setSiteId((cur) => (cur && sites.some((s) => s.id === cur) ? cur : (sites[0]?.id ?? null)));
      },
      (error: unknown) => live && setState({ status: 'error', error }),
    );
    return () => {
      live = false;
    };
  }, [client, attempt]);

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const saved = useCallback((message: string) => {
    clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  const update = useCallback((fn: (d: Loaded) => Loaded) => {
    setState((s) => (s.status === 'ready' ? { status: 'ready', data: fn(s.data) } : s));
  }, []);

  const site =
    state.status === 'ready' ? (state.data.sites.find((s) => s.id === siteId) ?? null) : null;

  let body: ReactNode;
  if (state.status === 'loading') {
    body = (
      <div aria-busy="true" className="rounded-lg border border-line bg-surface p-6">
        <SkeletonText lines={4} />
      </div>
    );
  } else if (state.status === 'error') {
    body = <ErrorBanner error={state.error} onRetry={() => setAttempt((n) => n + 1)} />;
  } else {
    const { publisher, sites } = state.data;
    const needsSite = tab === 'policy' || tab === 'keys';
    body = (
      <div role="tabpanel" id={`settings-panel-${tab}`} aria-labelledby={`settings-tab-${tab}`}>
        {needsSite && sites.length > 1 && (
          <label className="mb-4 block text-sm font-medium text-ink">
            Site
            <select
              className="mt-1 block w-full max-w-md rounded-md border border-border bg-surface px-3 py-2 text-ink"
              value={siteId ?? ''}
              onChange={(e) => setSiteId(e.target.value)}
            >
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.origin}
                </option>
              ))}
            </select>
          </label>
        )}
        {needsSite && !site ? (
          <EmptyState
            message="Connect a site to set its gate policy and keys."
            action={{ label: 'Connect your site', to: paths.connectSite }}
          />
        ) : tab === 'account' ? (
          <AccountTab
            client={client}
            publisher={publisher}
            onSaved={(p) => {
              update((d) => ({ ...d, publisher: { ...d.publisher, ...p } }));
              saved('Saved.');
            }}
          />
        ) : tab === 'payout' ? (
          <PayoutTab
            client={client}
            publisher={publisher}
            onSaved={(p) => {
              update((d) => ({ ...d, publisher: { ...d.publisher, ...p } }));
              saved('Saved. Your next payout goes to this PayPal account.');
            }}
          />
        ) : tab === 'policy' ? (
          <PolicyTab
            key={site!.id}
            client={client}
            site={site!}
            onSaved={(next) => {
              update((d) => ({
                ...d,
                sites: d.sites.map((s) => (s.id === next.id ? next : s)),
              }));
              saved('Saved. Your gate picks this up within 60 seconds.');
            }}
          />
        ) : (
          <KeysTab key={site!.id} client={client} site={site!} />
        )}
      </div>
    );
  }

  return (
    <section className="mx-auto max-w-3xl px-6 py-8" data-screen="W16">
      <h1 className="text-2xl font-semibold text-ink">Settings</h1>
      <div role="tablist" aria-label="Settings" className="mt-6 flex gap-1 border-b border-line">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`settings-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`settings-panel-${t.id}`}
            onClick={() => setParams({ tab: t.id }, { replace: true })}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              tab === t.id
                ? 'border-accent text-accent'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="mt-6">{body}</div>
      {toast && (
        <div
          role="status"
          className="fixed right-6 bottom-6 rounded-md bg-ink px-4 py-2 text-sm text-surface shadow-card"
        >
          {toast}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------

const inputCls =
  'mt-1 w-full max-w-md rounded-md border border-border bg-surface px-3 py-2 text-ink focus:outline-2 focus:outline-focus aria-invalid:border-danger';
const buttonCls =
  'rounded-md bg-accent px-3 py-2 text-sm font-medium text-on-accent hover:bg-accent-strong disabled:opacity-60';
const cardCls = 'rounded-lg border border-line bg-surface p-6 shadow-card';

function FieldError({ id, message }: { id: string; message?: string | null }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1 text-sm text-danger">
      {message}
    </p>
  );
}

type PublisherPatch = Partial<Pick<Loaded['publisher'], 'name' | 'payoutEmail'>>;

/** A one-field form: `field` in `PATCH /api/publishers/me`. */
function useMeForm(
  client: ApiClient,
  field: 'name' | 'payoutEmail',
  initial: string,
  onSaved: (p: PublisherPatch) => void,
) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  async function submit(e: FormEvent, check: (v: string) => string | null) {
    e.preventDefault();
    if (saving) return;
    const v = value.trim();
    const invalid = check(v);
    setFieldError(invalid);
    setError(null);
    if (invalid) return;
    setSaving(true);
    try {
      const res = await client.patch<Loaded['publisher']>('/api/publishers/me', { [field]: v });
      setValue(res[field]);
      onSaved({ [field]: res[field] });
    } catch (err) {
      const issues = issuesOf(err);
      if (issues[field]) setFieldError(issues[field]);
      else setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }
  return { value, setValue, saving, error, fieldError, submit };
}

function AccountTab({
  client,
  publisher,
  onSaved,
}: {
  client: ApiClient;
  publisher: Loaded['publisher'];
  onSaved: (p: PublisherPatch) => void;
}) {
  const f = useMeForm(client, 'name', publisher.name, onSaved);
  return (
    <form
      noValidate
      className={cardCls}
      onSubmit={(e) => f.submit(e, (v) => (v ? null : 'Enter a name.'))}
    >
      <h2 className="text-lg font-semibold text-ink">Account</h2>
      <label className="mt-4 block text-sm font-medium text-ink" htmlFor="settings-name">
        Name
      </label>
      <input
        id="settings-name"
        className={inputCls}
        value={f.value}
        maxLength={200}
        aria-invalid={!!f.fieldError}
        aria-describedby={f.fieldError ? 'settings-name-error' : undefined}
        onChange={(e) => f.setValue(e.target.value)}
      />
      <FieldError id="settings-name-error" message={f.fieldError} />
      <p className="mt-4 text-sm text-muted">
        Login email: <span className="text-body">{publisher.email}</span>
      </p>
      {f.error && <ErrorBanner error={f.error} title="Not saved." />}
      <button type="submit" disabled={f.saving} className={`mt-6 ${buttonCls}`}>
        {f.saving ? 'Saving…' : 'Save'}
      </button>
    </form>
  );
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function PayoutTab({
  client,
  publisher,
  onSaved,
}: {
  client: ApiClient;
  publisher: Loaded['publisher'];
  onSaved: (p: PublisherPatch) => void;
}) {
  const f = useMeForm(client, 'payoutEmail', publisher.payoutEmail, onSaved);
  return (
    <div className="space-y-6">
      <form
        noValidate
        className={cardCls}
        onSubmit={(e) =>
          f.submit(e, (v) => (EMAIL.test(v) ? null : 'Enter a valid email address.'))
        }
      >
        <h2 className="text-lg font-semibold text-ink">Payout</h2>
        <label className="mt-4 block text-sm font-medium text-ink" htmlFor="settings-payout-email">
          PayPal email
        </label>
        <input
          id="settings-payout-email"
          type="email"
          autoComplete="email"
          className={inputCls}
          value={f.value}
          aria-invalid={!!f.fieldError}
          aria-describedby="settings-payout-help"
          onChange={(e) => f.setValue(e.target.value)}
        />
        <FieldError id="settings-payout-error" message={f.fieldError} />
        <p id="settings-payout-help" className="mt-2 text-sm text-muted">
          This is where PayPal Payouts send your earnings. A change applies to the next batch; a
          payout already sent keeps the address it was sent to.
        </p>
        {f.error && <ErrorBanner error={f.error} title="Not saved." />}
        <button type="submit" disabled={f.saving} className={`mt-6 ${buttonCls}`}>
          {f.saving ? 'Saving…' : 'Save'}
        </button>
      </form>
      <ConnectPayPalCard publisher={publisher} />
    </div>
  );
}

function ConnectPayPalCard({ publisher }: { publisher: Loaded['publisher'] }) {
  const [params] = useSearchParams();
  const connected = !!publisher.paypalConnected;
  return (
    <div className={cardCls} data-slot="connect-paypal">
      <h3 className="font-medium text-ink">Connect with PayPal</h3>
      {connected ? (
        <p className="mt-1 text-sm text-muted">
          <span className="mr-2 inline-block rounded-full bg-positive-tint px-2 py-0.5 text-xs font-medium text-positive">
            Connected
          </span>
          You can log in with PayPal. Reconnect to switch to another PayPal account; its verified
          email becomes your payout email.
        </p>
      ) : (
        <p className="mt-1 text-sm text-muted">
          Log in with PayPal once to verify your payout account: we set your payout email to your
          PayPal account’s verified email, and you can log in with PayPal from then on.
        </p>
      )}
      <PayPalNotice reason={params.get('paypal')} />
      <div className="mt-4 max-w-xs">
        <PayPalButton label={connected ? 'Reconnect PayPal' : 'Connect with PayPal'} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

interface PolicyResponse {
  siteId: string;
  decisions: Record<Category, Decision>;
  gatedPaths: string[];
  policyVersion: number;
}

function PolicyTab({
  client,
  site,
  onSaved,
}: {
  client: ApiClient;
  site: SiteSummary;
  onSaved: (s: SiteSummary) => void;
}) {
  const [decisions, setDecisions] = useState(() => decisionsOf(site.policy));
  const [pathsText, setPathsText] = useState(() => gatedPathsOf(site.policy).join('\n'));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pathErrors, setPathErrors] = useState<string[]>([]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    const lines = splitLines(pathsText);
    const local = gatedPathErrors(lines)
      .map((err, i) => (err ? `Line “${lines[i]}”: ${err}` : null))
      .filter((x): x is string => !!x);
    if (lines.length > MAX_GATED_PATHS) local.push(`Use at most ${MAX_GATED_PATHS} paths.`);
    setPathErrors(local);
    setError(null);
    if (local.length) return;
    setSaving(true);
    try {
      const { SEARCH: _search, ...editable } = decisions;
      const res = await client.patch<PolicyResponse>(`/api/sites/${site.id}/policy`, {
        decisions: editable,
        gatedPaths: lines,
      });
      setDecisions(res.decisions);
      setPathsText(res.gatedPaths.join('\n'));
      onSaved({
        ...site,
        policy: { ...site.policy, ...res.decisions, gated_paths: res.gatedPaths },
        policyVersion: res.policyVersion,
      });
    } catch (err) {
      const issues = issuesOf(err);
      const server = Object.entries(issues)
        .filter(([p]) => p.startsWith('gatedPaths'))
        .map(([p, m]) => {
          const i = Number(p.split('.')[1]);
          return Number.isInteger(i) ? `Line “${lines[i]}”: ${m}` : m;
        });
      if (server.length) setPathErrors(server);
      else setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form noValidate onSubmit={onSubmit} className={cardCls}>
      <h2 className="text-lg font-semibold text-ink">Gate policy</h2>
      <p className="mt-1 text-sm text-muted">
        Choose which bots get through and which get a 402 pointing them to your paid API. Your gate
        picks up a change within 60 seconds.
      </p>
      <div className="mt-4 divide-y divide-line">
        {CATEGORIES.map((c) => (
          <fieldset key={c.id} className="flex items-center justify-between gap-4 py-3">
            <legend className="sr-only">{c.label}</legend>
            <div>
              <p className="font-medium text-ink" aria-hidden="true">
                {c.label}
              </p>
              <p className="text-sm text-muted">{c.hint}</p>
            </div>
            <div className="flex shrink-0 gap-3 text-sm">
              {(['PASS', 'QUOTE'] as const).map((d) => (
                <label key={d} className="flex items-center gap-1.5 text-body">
                  <input
                    type="radio"
                    name={`decision-${c.id}`}
                    value={d}
                    checked={decisions[c.id] === d}
                    disabled={c.id === 'SEARCH'}
                    onChange={() => setDecisions((cur) => ({ ...cur, [c.id]: d }))}
                  />
                  {d === 'PASS' ? 'Pass' : 'Send to API'}
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </div>

      <label className="mt-6 block text-sm font-medium text-ink" htmlFor="settings-gated-paths">
        Gated paths
      </label>
      <p id="settings-gated-paths-help" className="text-sm text-muted">
        One regular expression per line, matched against the path (e.g. <code>^/listings/</code>).
        Paths of your published datasets are gated automatically.
      </p>
      <textarea
        id="settings-gated-paths"
        rows={5}
        spellCheck={false}
        className={`${inputCls} max-w-none font-mono text-sm`}
        value={pathsText}
        aria-invalid={pathErrors.length > 0}
        aria-describedby="settings-gated-paths-help settings-gated-paths-error"
        onChange={(e) => setPathsText(e.target.value)}
      />
      {pathErrors.length > 0 && (
        <ul
          id="settings-gated-paths-error"
          role="alert"
          className="mt-1 space-y-0.5 text-sm text-danger"
        >
          {pathErrors.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
      {error && <ErrorBanner error={error} title="Not saved." />}
      <button type="submit" disabled={saving} className={`mt-6 ${buttonCls}`}>
        {saving ? 'Saving…' : 'Save policy'}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------

type KeyKind = 'gate' | 'crawl';

interface RotatedKey {
  kind: KeyKind;
  key: string;
  envVar: string;
  policyVersion: number;
}

const KEY_COPY: Record<
  KeyKind,
  { title: string; env: string; what: string; confirm: string; after: string }
> = {
  gate: {
    title: 'Gate key',
    env: 'SPIGOT_GATE_KEY',
    what: 'Your gate uses it to pull its policy and report bot visits.',
    confirm:
      'The old key stops working now. Until you set the new one on your server, your gate lets every request through and stops reporting.',
    after: 'Set it as SPIGOT_GATE_KEY on your server and restart.',
  },
  crawl: {
    title: 'Crawl key',
    env: 'SPIGOT_CRAWL_KEY',
    what: 'Our crawler sends it so your gate lets it through.',
    confirm:
      'Your gate picks up the new key by itself within 60 seconds; from then on the old key is no longer recognised. Our crawler switches over once your gate has it, so it is never turned away in between.',
    after:
      'Nothing to change on your server: your gate picks it up within 60 seconds, and our crawler switches to it then.',
  },
};

function KeysTab({ client, site }: { client: ApiClient; site: SiteSummary }) {
  return (
    <div className="space-y-6">
      {(['gate', 'crawl'] as const).map((kind) => (
        <KeyCard key={kind} client={client} site={site} kind={kind} />
      ))}
    </div>
  );
}

function KeyCard({ client, site, kind }: { client: ApiClient; site: SiteSummary; kind: KeyKind }) {
  const copy = KEY_COPY[kind];
  const [confirming, setConfirming] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [rotated, setRotated] = useState<RotatedKey | null>(null);
  const [copied, setCopied] = useState(false);

  async function rotate() {
    if (rotating) return;
    setRotating(true);
    setError(null);
    try {
      setRotated(await client.post<RotatedKey>(`/api/sites/${site.id}/keys/rotate`, { kind }));
      setCopied(false);
      setConfirming(false);
    } catch (err) {
      setError(err);
    } finally {
      setRotating(false);
    }
  }

  async function copyKey() {
    if (!rotated) return;
    try {
      await navigator.clipboard.writeText(rotated.key);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const id = `key-${kind}`;
  return (
    <section aria-labelledby={`${id}-title`} className={cardCls}>
      <h2 id={`${id}-title`} className="text-lg font-semibold text-ink">
        {copy.title}
      </h2>
      <p className="mt-1 text-sm text-muted">
        <code>{copy.env}</code>. {copy.what} We only store its hash, so we can’t show it again:
        rotate it if it leaked.
      </p>

      {rotated && (
        <div className="mt-4 rounded-md border border-warning bg-warning-tint p-4">
          <p className="text-sm font-medium text-ink">
            New {copy.title.toLowerCase()}, shown once:
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code
              data-testid={`${id}-value`}
              className="block flex-1 overflow-x-auto rounded-sm bg-surface px-2 py-1 font-mono text-sm break-all text-ink"
            >
              {rotated.key}
            </code>
            <button type="button" onClick={copyKey} className={buttonCls}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="mt-2 text-sm text-body">{copy.after}</p>
        </div>
      )}

      {confirming ? (
        <div role="alertdialog" aria-labelledby={`${id}-confirm`} className="mt-4">
          <p id={`${id}-confirm`} className="text-sm text-body">
            Rotate the {copy.title.toLowerCase()}? {copy.confirm}
          </p>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={rotate} disabled={rotating} className={buttonCls}>
              {rotating ? 'Rotating…' : `Rotate ${copy.title.toLowerCase()}`}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={rotating}
              className="rounded-md border border-border px-3 py-2 text-sm font-medium text-ink"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} className={`mt-4 ${buttonCls}`}>
          Rotate…
        </button>
      )}
      {error !== null && <ErrorBanner error={error} title="Not rotated." />}
    </section>
  );
}
