import { TOP_UP_WITH_PAYPAL, topupStatusLabel } from '@spigot/shared/copy';
import { formatCents } from '@spigot/shared/money';
import { useEffect, useRef, useState } from 'react';
import { api as defaultApi, ApiError, type ApiClient } from '../../api/client';
import { errorMessage } from '../ErrorBanner';
import {
  loadPayPalSdk as defaultLoadSdk,
  type LoadPayPalSdk,
  type OneTimeSession,
  type PayPalConfig,
} from './paypalSdk';

/** Amount chips (screens.md §W11). The demo uses $20 (features/12 1:30–1:50). */
export const TOPUP_AMOUNTS_CENTS = [500, 2000, 5000] as const;
export const DEFAULT_TOPUP_CENTS = 2000;

/** `POST /api/buyer/topups` (api.md; SP-018a). */
interface CreatedTopup {
  topupId: string;
  status: string;
  orderId: string;
}

/** `POST /api/buyer/topups/:id/capture`: COMPLETED, or still waiting on PayPal (capture PENDING). */
type CaptureResult =
  | { topupId: string; status: 'COMPLETED'; balanceMicros: number; captureId: string }
  | { topupId: string; status: 'AWAITING_APPROVAL'; pendingReason?: string };

export type TopUpPhase =
  | 'loading'
  | 'unavailable'
  | 'ready'
  | 'approving'
  | 'capturing'
  | 'completed'
  | 'pending'
  | 'cancelled'
  | 'declined'
  | 'error';

export interface PayPalTopUpProps {
  config: PayPalConfig;
  /** A top-up completed: the new balance, for the hero to animate up to. */
  onCompleted: (result: { topupId: string; balanceMicros: number; amountCents: number }) => void;
  /** Any top-up row changed (created, captured, failed): refresh the top-ups table. */
  onChanged?: () => void;
  client?: ApiClient;
  loadSdk?: LoadPayPalSdk;
}

/** `PayPal couldn't complete this payment` (W15 / `@spigot/shared/copy`). */
export const DECLINED_COPY = topupStatusLabel('FAILED');

/**
 * "Top up with PayPal" (W11; features/08 §Manual top-up 1–5). The JS SDK v6 button's order comes
 * from our API (`createOrder: () => orderId` from `POST /api/buyer/topups`), `onApprove` calls the
 * capture endpoint, and the API credits the balance. PayPal's approval window stays in front:
 * nothing here covers or hides it.
 *
 * `session.start()` is called synchronously inside the click, with the order as a promise, so the
 * popup isn't blocked. Each click is one user action with its own `Idempotency-Key`; while one is
 * in flight the button is disabled, and the server dedupes a double click on the same key anyway.
 */
export function PayPalTopUp({
  config,
  onCompleted,
  onChanged,
  client = defaultApi,
  loadSdk = defaultLoadSdk,
}: PayPalTopUpProps) {
  const [amountCents, setAmountCents] = useState<number>(DEFAULT_TOPUP_CENTS);
  const [saveForAutoTopup, setSaveForAutoTopup] = useState(false);
  const [phase, setPhase] = useState<TopUpPhase>(config.clientId ? 'loading' : 'unavailable');
  const [problem, setProblem] = useState<string | null>(null);
  const [completedCents, setCompletedCents] = useState<number | null>(null);

  const slot = useRef<HTMLDivElement>(null);
  const session = useRef<OneTimeSession | null>(null);
  const busy = useRef(false);
  // The latest choices, read inside the click handler the SDK button holds on to.
  const choice = useRef({ amountCents, saveForAutoTopup });
  choice.current = { amountCents, saveForAutoTopup };
  /** orderId → { topupId, amountCents }, filled by createOrder, read by onApprove. */
  const orders = useRef(new Map<string, { topupId: string; amountCents: number }>());
  const callbacks = useRef({ onCompleted, onChanged });
  callbacks.current = { onCompleted, onChanged };

  useEffect(() => {
    const { clientId, environment } = config;
    if (!clientId) {
      setPhase('unavailable');
      return;
    }
    let live = true;
    let button: HTMLElement | null = null;
    setPhase('loading');

    function finish(next: TopUpPhase, message: string | null = null) {
      busy.current = false;
      if (button) button.removeAttribute('disabled');
      if (!live) return;
      setProblem(message);
      setPhase(next);
    }

    async function capture(orderId: string) {
      const order = orders.current.get(orderId);
      if (!order) return finish('error', 'PayPal approved an order this page did not start.');
      setPhase('capturing');
      try {
        const res = await client.post<CaptureResult>(
          `/api/buyer/topups/${encodeURIComponent(order.topupId)}/capture`,
          {},
        );
        callbacks.current.onChanged?.();
        if (res.status === 'COMPLETED') {
          if (live) setCompletedCents(order.amountCents);
          finish('completed');
          callbacks.current.onCompleted({
            topupId: order.topupId,
            balanceMicros: res.balanceMicros,
            amountCents: order.amountCents,
          });
        } else {
          finish('pending');
        }
      } catch (err) {
        callbacks.current.onChanged?.();
        if (err instanceof ApiError && err.code === 'TOPUP_FAILED') finish('declined');
        else finish('error', errorMessage(err));
      }
    }

    function createOrder(): Promise<{ orderId: string }> {
      const { amountCents: cents, saveForAutoTopup: save } = choice.current;
      return client
        .post<CreatedTopup>(
          '/api/buyer/topups',
          { amountCents: cents, method: 'PAYPAL_WALLET', saveForAutoTopup: save },
          { idempotencyKey: crypto.randomUUID() },
        )
        .then((t) => {
          orders.current.set(t.orderId, { topupId: t.topupId, amountCents: cents });
          callbacks.current.onChanged?.();
          return { orderId: t.orderId };
        })
        .catch((err: unknown) => {
          finish('error', errorMessage(err));
          throw err;
        });
    }

    function onClick() {
      if (busy.current || !session.current) return;
      busy.current = true;
      button?.setAttribute('disabled', '');
      setProblem(null);
      setPhase('approving');
      session.current.start({ presentationMode: 'auto' }, createOrder()).catch((err: unknown) => {
        if (busy.current) finish('error', errorMessage(err));
      });
    }

    loadSdk({ clientId, environment })
      .then(async (sdk) => {
        if (!(await sdk.isPayPalEligible())) {
          throw new Error('PayPal is not available for this account right now.');
        }
        if (!live) return;
        session.current = sdk.createSession({
          onApprove: ({ orderId }) => capture(orderId),
          onCancel: () => finish('cancelled'),
          onError: (err) => finish('error', errorMessage(err)),
        });
        button = document.createElement('paypal-button');
        button.setAttribute('type', 'pay');
        button.setAttribute('data-testid', 'paypal-button');
        button.setAttribute('aria-label', TOP_UP_WITH_PAYPAL);
        button.addEventListener('click', onClick);
        slot.current?.replaceChildren(button);
        setPhase('ready');
      })
      .catch((err: unknown) => {
        if (live) {
          setProblem(errorMessage(err));
          setPhase('unavailable');
        }
      });

    return () => {
      live = false;
      button?.removeEventListener('click', onClick);
      button?.remove();
      session.current = null;
    };
  }, [config.clientId, config.environment, client, loadSdk]);

  const inFlight = phase === 'approving' || phase === 'capturing';

  return (
    <section
      aria-labelledby="topup-title"
      className="rounded-lg border border-line bg-surface p-5 shadow-card"
    >
      <h2 id="topup-title" className="text-lg font-semibold text-ink">
        {TOP_UP_WITH_PAYPAL}
      </h2>
      <p className="mt-1 text-sm text-muted">
        Your agent spends this balance call by call. Minimum $5.
      </p>

      <fieldset className="mt-4" disabled={inFlight}>
        <legend className="sr-only">Amount</legend>
        <div className="flex flex-wrap gap-2">
          {TOPUP_AMOUNTS_CENTS.map((cents) => (
            <button
              key={cents}
              type="button"
              aria-pressed={amountCents === cents}
              onClick={() => setAmountCents(cents)}
              className={`rounded-full border px-4 py-1.5 text-sm font-medium tabular-nums ${
                amountCents === cents
                  ? 'border-accent bg-accent text-on-accent'
                  : 'border-border bg-surface text-ink hover:bg-surface-2'
              }`}
            >
              {formatCents(cents)}
            </button>
          ))}
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm text-body">
          <input
            type="checkbox"
            checked={saveForAutoTopup}
            onChange={(e) => setSaveForAutoTopup(e.target.checked)}
          />
          Save for auto top-up
        </label>
      </fieldset>

      <div className="mt-4 min-h-12" aria-busy={phase === 'loading'}>
        <div ref={slot} className="max-w-xs" />
        {phase === 'loading' && <p className="text-sm text-muted">Loading PayPal…</p>}
      </div>

      <TopUpStatus
        phase={phase}
        problem={problem}
        amountCents={amountCents}
        completedCents={completedCents}
      />
    </section>
  );
}

function TopUpStatus({
  phase,
  problem,
  amountCents,
  completedCents,
}: {
  phase: TopUpPhase;
  problem: string | null;
  amountCents: number;
  completedCents: number | null;
}) {
  const box = 'mt-3 rounded-md px-3 py-2 text-sm';
  switch (phase) {
    case 'unavailable':
      return (
        <p role="status" className={`${box} bg-surface-2 text-body`}>
          {problem ??
            'The PayPal button needs the PayPal sandbox; this server runs PayPal as a stub.'}
        </p>
      );
    case 'approving':
      return (
        <p role="status" className={`${box} bg-info-tint text-info`}>
          Approve {formatCents(amountCents)} in the PayPal window.
        </p>
      );
    case 'capturing':
      return (
        <p role="status" className={`${box} bg-info-tint text-info`}>
          Approved in PayPal. Adding it to your balance…
        </p>
      );
    case 'completed':
      return (
        <p role="status" className={`${box} bg-positive-tint text-positive`}>
          {formatCents(completedCents ?? amountCents)} added via PayPal.
        </p>
      );
    case 'pending':
      return (
        <p role="status" className={`${box} bg-warning-tint text-warning`}>
          PayPal is still processing this payment. Your balance updates when it completes.
        </p>
      );
    case 'cancelled':
      return (
        <p role="status" className={`${box} bg-surface-2 text-body`}>
          {topupStatusLabel('ABANDONED')}. Nothing was taken.
        </p>
      );
    case 'declined':
      return (
        <p role="alert" className={`${box} bg-danger-tint text-danger`}>
          {DECLINED_COPY}. Try another payment method in PayPal.
        </p>
      );
    case 'error':
      return (
        <p role="alert" className={`${box} bg-danger-tint text-danger`}>
          {problem ?? 'Something went wrong.'}
        </p>
      );
    default:
      return null;
  }
}
