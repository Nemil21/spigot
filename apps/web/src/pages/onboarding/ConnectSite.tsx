import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api as defaultApi, ApiError, type ApiClient } from '../../api/client';
import { errorMessage } from '../../components';
import { paths } from '../../routes';
import { cardClass, OnboardingLayout, primaryButton, rememberSiteKeys, TextField } from './kit';

/** `POST /api/sites` → 201 (api.md; SP-008a). Keys are in this response only. */
export interface ConnectResponse {
  siteId: string;
  slug: string;
  origin: string;
  sitemapUrl: string;
  status: 'PENDING_VERIFY';
  verify: { path: string; content: string };
  gateKey: string;
  crawlKey: string;
  install: string;
}

/** The W02 copy for each origin-check outcome (matches the API's own messages). */
export const CONNECT_COPY = {
  checking: 'Checking that we can reach your site and read its sitemap…',
  unreachable: "We couldn't reach that site",
  unreachableHint: 'Check the address and that the site is up, then try again.',
  noSitemap: 'Add a sitemap.xml or enter one',
  noSitemapHint: 'Spigot reads only the pages listed in your sitemap.',
} as const;

type Outcome =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'unreachable'; message: string }
  | { kind: 'noSitemap'; message: string }
  | { kind: 'originInvalid'; message: string }
  | { kind: 'taken'; message: string; ownSiteId: string | null }
  | { kind: 'error'; message: string };

export function installHref(siteId: string): string {
  return `${paths.installVerify}?site=${encodeURIComponent(siteId)}`;
}

/**
 * W02 step 2 (screens.md §W02): site URL with the live origin check. `POST /api/sites` is the
 * check: it probes `/robots.txt` and the sitemap (5 s each) and writes nothing when that fails, so
 * the publisher can fix the address or sitemap and submit again. Success → W03 with the one-time
 * keys held in memory.
 */
export function ConnectSiteForm({ client = defaultApi }: { client?: ApiClient }) {
  const navigate = useNavigate();
  const [origin, setOrigin] = useState('');
  const [sitemapUrl, setSitemapUrl] = useState('');
  const [showSitemap, setShowSitemap] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const checking = outcome.kind === 'checking';

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (checking) return;
    if (!origin.trim()) {
      setOutcome({ kind: 'originInvalid', message: 'Enter your site URL.' });
      return;
    }
    setOutcome({ kind: 'checking' });
    const body: { origin: string; sitemapUrl?: string } = { origin: origin.trim() };
    if (showSitemap && sitemapUrl.trim()) body.sitemapUrl = sitemapUrl.trim();
    try {
      const site = await client.post<ConnectResponse>('/api/sites', body);
      rememberSiteKeys(site.siteId, { gateKey: site.gateKey, crawlKey: site.crawlKey });
      navigate(installHref(site.siteId));
    } catch (err) {
      setOutcome(await classify(err));
    }
  }

  async function classify(err: unknown): Promise<Outcome> {
    if (!(err instanceof ApiError)) return { kind: 'error', message: errorMessage(err) };
    if (err.status === 401) {
      navigate(`${paths.login}?next=${encodeURIComponent(paths.connectSite)}`, { replace: true });
      return { kind: 'idle' };
    }
    if (err.code === 'ORIGIN_ERROR') return { kind: 'unreachable', message: err.message };
    if (err.code === 'VALIDATION_ERROR') {
      if (err.details.reason === 'NO_SITEMAP' || err.details.field === 'sitemapUrl') {
        setShowSitemap(true);
        if (!sitemapUrl.trim()) setSitemapUrl(defaultSitemap(origin));
        return { kind: 'noSitemap', message: err.message };
      }
      return { kind: 'originInvalid', message: err.message };
    }
    if (err.code === 'STATE_CONFLICT') {
      return { kind: 'taken', message: err.message, ownSiteId: await findOwnSite(client, origin) };
    }
    return { kind: 'error', message: err.message };
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-busy={checking}>
      <TextField
        id="connect-origin"
        label="Site URL"
        type="url"
        inputMode="url"
        autoComplete="url"
        placeholder="https://example.com"
        required
        value={origin}
        onChange={(e) => setOrigin(e.target.value)}
        error={outcome.kind === 'originInvalid' ? outcome.message : null}
      />
      {showSitemap && (
        <TextField
          id="connect-sitemap"
          label="Sitemap URL"
          type="url"
          inputMode="url"
          placeholder="https://example.com/sitemap.xml"
          value={sitemapUrl}
          onChange={(e) => setSitemapUrl(e.target.value)}
          hint={CONNECT_COPY.noSitemapHint}
        />
      )}

      <div aria-live="polite" className="mt-4 empty:hidden">
        {checking && (
          <p className="rounded-md bg-info-tint px-3 py-2 text-sm text-info">
            {CONNECT_COPY.checking}
          </p>
        )}
        {outcome.kind === 'unreachable' && (
          <div role="alert" className="rounded-md bg-danger-tint px-3 py-2 text-sm text-danger">
            <p className="font-medium">{CONNECT_COPY.unreachable}</p>
            <p className="mt-1">{CONNECT_COPY.unreachableHint}</p>
          </div>
        )}
        {outcome.kind === 'noSitemap' && (
          <div role="alert" className="rounded-md bg-warning-tint px-3 py-2 text-sm text-warning">
            <p className="font-medium">{CONNECT_COPY.noSitemap}</p>
            {outcome.message !== CONNECT_COPY.noSitemap && (
              <p className="mt-1">{outcome.message}</p>
            )}
          </div>
        )}
        {outcome.kind === 'taken' && (
          <div role="alert" className="rounded-md bg-warning-tint px-3 py-2 text-sm text-warning">
            <p className="font-medium">{outcome.message}</p>
            {outcome.ownSiteId && (
              <Link
                className="mt-1 inline-block font-medium text-accent hover:underline"
                to={installHref(outcome.ownSiteId)}
              >
                Continue setting it up
              </Link>
            )}
          </div>
        )}
        {outcome.kind === 'error' && (
          <p role="alert" className="rounded-md bg-danger-tint px-3 py-2 text-sm text-danger">
            {outcome.message}
          </p>
        )}
      </div>

      <button type="submit" disabled={checking} className={`mt-6 w-full ${primaryButton}`}>
        {checking ? 'Checking your site…' : 'Connect site'}
      </button>
    </form>
  );
}

function defaultSitemap(origin: string): string {
  const raw = origin.trim();
  if (!raw) return '';
  try {
    return `${new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`).origin}/sitemap.xml`;
  } catch {
    return '';
  }
}

/** On "already connected": is it this publisher's own site (e.g. a reload after connecting)? */
async function findOwnSite(client: ApiClient, typed: string): Promise<string | null> {
  try {
    const { sites } = await client.get<{ sites: { id: string; origin: string }[] }>('/api/sites');
    const want = defaultSitemap(typed).replace(/\/sitemap\.xml$/, '');
    return sites.find((s) => s.origin === want)?.id ?? null;
  } catch {
    return null;
  }
}

/** Step header shared with SignUp. */
export function StepHeading({
  step,
  title,
  subtitle,
}: {
  step: 1 | 2;
  title: string;
  subtitle: string;
}) {
  return (
    <>
      <p className="text-xs font-medium uppercase tracking-wide text-muted">Step {step} of 2</p>
      <h1 className="mt-1 text-xl font-semibold text-ink">{title}</h1>
      <p className="mt-1 text-sm text-muted">{subtitle}</p>
    </>
  );
}

export function ConnectSiteCard({ client }: { client?: ApiClient }) {
  return (
    <div className={cardClass}>
      <StepHeading
        step={2}
        title="Connect your site"
        subtitle="We check that your site is reachable and has a sitemap."
      />
      <ConnectSiteForm client={client} />
    </div>
  );
}

/** W02 step 2 on its own, for a publisher who is already signed in (`/app/connect`). */
export default function ConnectSitePage() {
  return (
    <OnboardingLayout>
      <ConnectSiteCard />
    </OnboardingLayout>
  );
}
