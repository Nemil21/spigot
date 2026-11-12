import { formatCents } from '@spigot/shared/money';
import { TOP_UP_WITH_PAYPAL, topupStatusLabel } from '@spigot/shared/copy';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { api as defaultApi, type ApiClient } from '../../api/client';
import { ErrorBanner, SkeletonText } from '../../components';
import { CardFieldsTopUp, type SavedMethod } from '../../components/CardFieldsTopUp';
import {
  ApiKeysTable,
  type ApiKeyRow,
  type RevealedKey,
} from '../../components/buyer/ApiKeysTable';
import { BalanceHero } from '../../components/buyer/BalanceHero';
import type { LoadCardFieldsSdk } from '../../components/buyer/cardFieldsSdk';
import { ClaudeConfig } from '../../components/buyer/ClaudeConfig';
import { PayPalTopUp } from '../../components/buyer/PayPalTopUp';
import type { LoadPayPalSdk, PayPalConfig } from '../../components/buyer/paypalSdk';
import { TopupsTable, type TopupRowView } from '../../components/buyer/TopupsTable';
import * as ui from '../../components/buyer/ui';
import { AutoTopupCard } from './AutoTopupCard';

interface PortalData {
  balanceMicros: number;
  topups: TopupRowView[];
  keys: ApiKeyRow[];
  paypal: PayPalConfig;
}

type Load = { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'ready' };

export interface BuyerPortalProps {
  client?: ApiClient;
  loadSdk?: LoadPayPalSdk;
  /** The JS SDK v6 card-fields loader (SP-063); tests pass a fake. */
  loadCardSdk?: LoadCardFieldsSdk;
  /** The origin for the MCP URL in the Claude Desktop snippet (default: this page's). */
  origin?: string;
}

/**
 * W11 Buyer portal (screens.md §W11; SP-032): balance hero, Top up with PayPal (JS SDK v6), API
 * keys, the Claude Desktop config and the top-ups table. Also renders `/buyers/topup/:id?ok=1`,
 * where `/topups/return` lands after an approval link opened outside this page.
 */
export function BuyerPortal({
  client = defaultApi,
  loadSdk,
  loadCardSdk,
  origin,
}: BuyerPortalProps) {
  const { topupId: returnedTopupId } = useParams();
  const [params] = useSearchParams();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [data, setData] = useState<PortalData | null>(null);
  const [revealed, setRevealed] = useState<RevealedKey | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [savedMethod, setSavedMethod] = useState<SavedMethod | null>(null);
  /** Bumped after a completed top-up: it may have saved the method auto top-up charges. */
  const [autoTopupReload, setAutoTopupReload] = useState(0);
  const topupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    setLoad({ status: 'loading' });
    Promise.all([
      client.get<{ balanceMicros: number }>('/api/buyer/balance'),
      client.get<{ topups: TopupRowView[] }>('/api/buyer/topups'),
      client.get<{ keys: ApiKeyRow[] }>('/api/buyer/keys'),
      client.get<PayPalConfig>('/api/buyer/paypal-config'),
    ]).then(
      ([b, t, k, paypal]) => {
        if (!live) return;
        setData({ balanceMicros: b.balanceMicros, topups: t.topups, keys: k.keys, paypal });
        setLoad({ status: 'ready' });
      },
      (error: unknown) => live && setLoad({ status: 'error', error }),
    );
    return () => {
      live = false;
    };
  }, [client, attempt]);

  // The saved method line (SP-063) is extra: if it can't load, the rest of W11 still works.
  const refreshSavedMethod = useCallback(() => {
    client.get<{ savedMethod: SavedMethod | null }>('/api/buyer/payment-method').then(
      (m) => setSavedMethod(m.savedMethod ?? null),
      () => undefined,
    );
  }, [client]);

  useEffect(() => {
    refreshSavedMethod();
  }, [refreshSavedMethod, attempt]);

  const refreshTopups = useCallback(() => {
    client.get<{ topups: TopupRowView[] }>('/api/buyer/topups').then(
      (t) => setData((d) => (d ? { ...d, topups: t.topups } : d)),
      () => undefined, // The table keeps its last rows; the next action refreshes again.
    );
  }, [client]);

  const refreshKeys = useCallback(async () => {
    const k = await client.get<{ keys: ApiKeyRow[] }>('/api/buyer/keys');
    setData((d) => (d ? { ...d, keys: k.keys } : d));
  }, [client]);

  const onCompleted = useCallback(
    ({ balanceMicros }: { balanceMicros: number }) => {
      setData((d) => (d ? { ...d, balanceMicros } : d));
      refreshSavedMethod();
      setAutoTopupReload((n) => n + 1);
    },
    [refreshSavedMethod],
  );

  async function createKey(name: string) {
    const created = await client.post<ApiKeyRow & { key: string }>('/api/buyer/keys', {
      name,
      scopes: ['read', 'topup'],
    });
    setRevealed({ id: created.id, key: created.key });
    await refreshKeys();
  }

  async function revokeKey(id: string) {
    await client.delete(`/api/buyer/keys/${encodeURIComponent(id)}`);
    if (revealed?.id === id) setRevealed(null);
    await refreshKeys();
  }

  if (load.status === 'error') {
    return (
      <PortalFrame>
        <ErrorBanner error={load.error} onRetry={() => setAttempt((n) => n + 1)} />
      </PortalFrame>
    );
  }

  const ready = load.status === 'ready' && data !== null;
  const returned = returnedTopupId && data?.topups.find((t) => t.topupId === returnedTopupId);
  const isEmpty =
    ready && data.balanceMicros === 0 && !data.topups.some((t) => t.status === 'COMPLETED');
  const newestActiveKey = data?.keys.find((k) => !k.revokedAt) ?? null;

  return (
    <PortalFrame>
      {returnedTopupId && params.get('ok') === '1' && ready && (
        <p
          role="status"
          className={
            returned && returned.status === 'COMPLETED' ? ui.notice.positive : ui.notice.info
          }
        >
          {returned && returned.status === 'COMPLETED'
            ? `${formatCents(returned.amountCents)} added via PayPal.`
            : returned
              ? `${topupStatusLabel(returned.status)}.`
              : 'We are checking this top-up with PayPal.'}
        </p>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-12">
        <div className="space-y-6 lg:col-span-5">
          <BalanceHero balanceMicros={ready ? data.balanceMicros : null}>
            {isEmpty && (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-body">
                  Your balance is empty. Add funds so your agent can pay for data, call by call.
                </p>
                <button
                  type="button"
                  onClick={() =>
                    topupRef.current?.scrollIntoView({ behavior: smoothScroll(), block: 'center' })
                  }
                  className={ui.btnPrimary}
                >
                  {TOP_UP_WITH_PAYPAL}
                </button>
              </div>
            )}
          </BalanceHero>
          {/* SP-047b: threshold, amount, monthly cap, saved method, remaining this month,
              and the cap-reached / declined banners (W15). */}
          <AutoTopupCard client={client} reloadToken={autoTopupReload} />
        </div>
        <div ref={topupRef} className="lg:col-span-7">
          {ready ? (
            <div className={`${ui.panel} divide-y divide-line`}>
              <PayPalTopUp
                config={data.paypal}
                client={client}
                onCompleted={onCompleted}
                onChanged={refreshTopups}
                {...(loadSdk ? { loadSdk } : {})}
              />
              {/* SP-063: no PayPal account, or the wallet approval failed → card fields. */}
              <CardFieldsTopUp
                config={data.paypal}
                savedMethod={savedMethod}
                client={client}
                onCompleted={onCompleted}
                onChanged={refreshTopups}
                {...(loadCardSdk ? { loadSdk: loadCardSdk } : {})}
              />
            </div>
          ) : (
            <CardSkeleton />
          )}
        </div>
      </div>

      {ready ? (
        <>
          <ApiKeysTable
            keys={data.keys}
            revealed={revealed}
            onCreate={createKey}
            onRevoke={revokeKey}
            onDismissReveal={() => setRevealed(null)}
          />
          <ClaudeConfig
            revealedKey={revealed?.key ?? null}
            keyPrefix={newestActiveKey?.prefix ?? null}
            {...(origin ? { origin } : {})}
          />
          <TopupsTable topups={data.topups} />
        </>
      ) : (
        <>
          <CardSkeleton />
          <CardSkeleton />
        </>
      )}
    </PortalFrame>
  );
}

const smoothScroll = (): ScrollBehavior =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ? 'auto'
    : 'smooth';

function PortalFrame({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Balance and keys</h1>
        <p className="mt-1 text-sm text-muted">
          Fund your agent with PayPal, issue API keys and connect Claude.
        </p>
      </header>
      {children}
    </div>
  );
}

function CardSkeleton() {
  return (
    <div aria-busy="true" className={`${ui.panel} ${ui.panelBody}`}>
      <SkeletonText lines={3} />
    </div>
  );
}

export default function PortalPage() {
  return <BuyerPortal />;
}
