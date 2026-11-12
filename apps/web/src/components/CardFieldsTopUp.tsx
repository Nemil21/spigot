import { topupStatusLabel } from '@spigot/shared/copy';
import { formatCents } from '@spigot/shared/money';
import { useEffect, useRef, useState } from 'react';
import { api as defaultApi, ApiError, type ApiClient } from '../api/client';
import { DEFAULT_TOPUP_CENTS, TOPUP_AMOUNTS_CENTS } from './buyer/PayPalTopUp';
import {
  loadCardFieldsSdk as defaultLoadSdk,
  type CardFieldsSession,
  type CardFieldType,
  type LoadCardFieldsSdk,
} from './buyer/cardFieldsSdk';
import type { PayPalConfig } from './buyer/paypalSdk';
import { errorMessage } from './ErrorBanner';
import * as ui from './buyer/ui';

export const PAY_BY_CARD = 'Top up with a card';

/** The PayPal-hosted inputs, in form order (Holdfast S7 step 1). */
const FIELDS: { type: CardFieldType; placeholder: string; label: string }[] = [
  { type: 'name', placeholder: 'Name on card', label: 'Name on card' },
  { type: 'number', placeholder: 'Card number', label: 'Card number' },
  { type: 'expiry', placeholder: 'MM/YY', label: 'Expiry' },
  { type: 'cvv', placeholder: 'CVV', label: 'CVV' },
];

/** A saved method from `GET /api/buyer/payment-method` (`Visa ••1111`). */
export interface SavedMethod {
  kind: 'CARD' | 'PAYPAL';
  label: string;
}

/** `POST /api/buyer/topups` with `method: 'CARD'`: the order the card fields submit against. */
interface CreatedTopup {
  topupId: string;
  status: string;
  orderId: string | null;
  balanceMicros?: number;
}

type CaptureResult =
  | { topupId: string; status: 'COMPLETED'; balanceMicros: number; captureId: string }
  | { topupId: string; status: 'AWAITING_APPROVAL'; pendingReason?: string };

export type CardPhase =
  | 'loading'
  | 'unavailable'
  | 'ready'
  | 'submitting'
  | 'capturing'
  | 'completed'
  | 'pending'
  | 'cancelled'
  | 'declined'
  | 'error';

export interface CardFieldsTopUpProps {
  config: PayPalConfig;
  /** The buyer's saved method, shown under the form ("Saved for auto top-up: Visa ••1111"). */
  savedMethod?: SavedMethod | null;
  onCompleted: (result: { topupId: string; balanceMicros: number; amountCents: number }) => void;
  /** Any top-up row changed: refresh the table (and the saved method). */
  onChanged?: () => void;
  client?: ApiClient;
  loadSdk?: LoadCardFieldsSdk;
}

/**
 * "Top up with a card" (W11; SP-063; features/08 §Manual top-up 7): for buyers without a PayPal
 * account, and the fallback when wallet approval fails. JS SDK v6 card fields (client id only):
 *
 * 1. `POST /api/buyer/topups { method: 'CARD' }` → our order (card source, no number, vault
 *    `ON_SUCCESS` when "save" is ticked) with this click's `Idempotency-Key`;
 * 2. `session.submit(orderId)`: PayPal takes the card from its hosted fields (3DS if required);
 * 3. `POST /api/buyer/topups/:id/capture` → `creditTopup`; the card is vaulted (`vault_kind=CARD`).
 *
 * Still a PayPal payment. One submit at a time: the button is disabled while one is in flight, and
 * the server dedupes the same key anyway (the no-number create replays cleanly at PayPal).
 */
export function CardFieldsTopUp({
  config,
  savedMethod = null,
  onCompleted,
  onChanged,
  client = defaultApi,
  loadSdk = defaultLoadSdk,
}: CardFieldsTopUpProps) {
  const [amountCents, setAmountCents] = useState<number>(DEFAULT_TOPUP_CENTS);
  const [saveCard, setSaveCard] = useState(true);
  const [phase, setPhase] = useState<CardPhase>(config.clientId ? 'loading' : 'unavailable');
  const [problem, setProblem] = useState<string | null>(null);
  const [completedCents, setCompletedCents] = useState<number | null>(null);

  const fieldSlots = useRef<Partial<Record<CardFieldType, HTMLDivElement | null>>>({});
  const session = useRef<CardFieldsSession | null>(null);
  const busy = useRef(false);
  const live = useRef(true);
  const callbacks = useRef({ onCompleted, onChanged });
  callbacks.current = { onCompleted, onChanged };

  useEffect(() => {
    live.current = true;
    const { clientId, environment } = config;
    if (!clientId) {
      setPhase('unavailable');
      return;
    }
    let mounted = true;
    let created: CardFieldsSession | null = null;
    setPhase('loading');
    loadSdk({ clientId, environment })
      .then(async (sdk) => {
        if (!(await sdk.isCardFieldsEligible())) {
          throw new Error('Card payments are not available for this account right now.');
        }
        if (!mounted) return;
        created = sdk.createSession();
        for (const field of FIELDS) {
          fieldSlots.current[field.type]?.replaceChildren(created.createField(field));
        }
        session.current = created;
        setPhase('ready');
      })
      .catch((err: unknown) => {
        if (!mounted) return;
        setProblem(errorMessage(err));
        setPhase('unavailable');
      });
    return () => {
      mounted = false;
      live.current = false;
      session.current = null;
      created?.destroy();
    };
  }, [config.clientId, config.environment, loadSdk]);

  function finish(next: CardPhase, message: string | null = null) {
    busy.current = false;
    if (!live.current) return;
    setProblem(message);
    setPhase(next);
  }

  async function pay() {
    const cards = session.current;
    if (busy.current || !cards) return;
    busy.current = true;
    const cents = amountCents;
    setProblem(null);
    setPhase('submitting');

    let topup: CreatedTopup;
    try {
      topup = await client.post<CreatedTopup>(
        '/api/buyer/topups',
        { amountCents: cents, method: 'CARD', saveForAutoTopup: saveCard },
        { idempotencyKey: crypto.randomUUID() },
      );
      callbacks.current.onChanged?.();
    } catch (err) {
      return finish('error', errorMessage(err));
    }
    if (!topup.orderId) return finish('error', 'PayPal did not start this payment. Try again.');

    let submitted;
    try {
      submitted = await cards.submit(topup.orderId);
    } catch (err) {
      return finish('error', errorMessage(err));
    }
    if (submitted.state === 'canceled') return finish('cancelled');
    if (submitted.state !== 'succeeded') {
      return finish('declined', submitted.data?.message ?? null);
    }

    if (live.current) setPhase('capturing');
    try {
      const res = await client.post<CaptureResult>(
        `/api/buyer/topups/${encodeURIComponent(topup.topupId)}/capture`,
        {},
      );
      callbacks.current.onChanged?.();
      if (res.status !== 'COMPLETED') return finish('pending');
      if (live.current) setCompletedCents(cents);
      finish('completed');
      callbacks.current.onCompleted({
        topupId: topup.topupId,
        balanceMicros: res.balanceMicros,
        amountCents: cents,
      });
    } catch (err) {
      callbacks.current.onChanged?.();
      if (err instanceof ApiError && err.code === 'TOPUP_FAILED') finish('declined');
      else finish('error', errorMessage(err));
    }
  }

  const inFlight = phase === 'submitting' || phase === 'capturing';
  const usable = phase !== 'loading' && phase !== 'unavailable';

  return (
    <section aria-labelledby="card-topup-title" className={ui.panelBody}>
      <h2 id="card-topup-title" className={ui.panelTitle}>
        {PAY_BY_CARD}
      </h2>
      <p className={ui.panelDesc}>
        No PayPal account? Pay by card through PayPal. Your card details go to PayPal, not to us.
      </p>

      <fieldset className="mt-4" disabled={inFlight || !usable}>
        <legend className="sr-only">Card amount</legend>
        <div className={ui.segmented}>
          {TOPUP_AMOUNTS_CENTS.map((cents) => (
            <button
              key={cents}
              type="button"
              aria-pressed={amountCents === cents}
              aria-label={`${formatCents(cents)} by card`}
              onClick={() => setAmountCents(cents)}
              className={ui.segment(amountCents === cents)}
            >
              {formatCents(cents)}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="mt-4 max-w-sm" hidden={phase === 'unavailable'}>
        {FIELDS.map((field) => (
          <div
            key={field.type}
            ref={(el) => {
              fieldSlots.current[field.type] = el;
            }}
            data-testid={`card-field-${field.type}`}
            className="mb-2 min-h-12"
          />
        ))}
        {phase === 'loading' && <p className="text-sm text-muted">Loading card fields…</p>}
      </div>

      <fieldset disabled={inFlight || !usable}>
        <label className={`mt-1 ${ui.checkboxLabel}`}>
          <input
            className={ui.checkbox}
            type="checkbox"
            checked={saveCard}
            onChange={(e) => setSaveCard(e.target.checked)}
          />
          Save this card for auto top-up
        </label>
        <button type="button" onClick={() => void pay()} className={`mt-4 ${ui.btnPrimary}`}>
          Pay {formatCents(amountCents)} by card
        </button>
      </fieldset>

      {savedMethod && (
        <p className="mt-4 text-sm text-body" data-testid="saved-method">
          Saved for auto top-up: <span className="font-medium text-ink">{savedMethod.label}</span>
        </p>
      )}

      <CardStatus
        phase={phase}
        problem={problem}
        amountCents={amountCents}
        completedCents={completedCents}
      />
    </section>
  );
}

function CardStatus({
  phase,
  problem,
  amountCents,
  completedCents,
}: {
  phase: CardPhase;
  problem: string | null;
  amountCents: number;
  completedCents: number | null;
}) {
  switch (phase) {
    case 'unavailable':
      return (
        <p role="status" className={`mt-4 ${ui.notice.neutral}`}>
          {problem ?? 'Card fields need the PayPal sandbox; this server runs PayPal as a stub.'}
        </p>
      );
    case 'submitting':
      return (
        <p role="status" className={`mt-4 ${ui.notice.info}`}>
          Sending {formatCents(amountCents)} to PayPal…
        </p>
      );
    case 'capturing':
      return (
        <p role="status" className={`mt-4 ${ui.notice.info}`}>
          Card accepted. Adding it to your balance…
        </p>
      );
    case 'completed':
      return (
        <p role="status" className={`mt-4 ${ui.notice.positive}`}>
          {formatCents(completedCents ?? amountCents)} added by card via PayPal.
        </p>
      );
    case 'pending':
      return (
        <p role="status" className={`mt-4 ${ui.notice.warning}`}>
          PayPal is still processing this payment. Your balance updates when it completes.
        </p>
      );
    case 'cancelled':
      return (
        <p role="status" className={`mt-4 ${ui.notice.neutral}`}>
          {topupStatusLabel('ABANDONED')}. Nothing was taken.
        </p>
      );
    case 'declined':
      return (
        <p role="alert" className={`mt-4 ${ui.notice.danger}`}>
          {topupStatusLabel('FAILED')}. Check the card details or try another card.
          {problem ? ` (${problem})` : ''}
        </p>
      );
    case 'error':
      return (
        <p role="alert" className={`mt-4 ${ui.notice.danger}`}>
          {problem ?? 'Something went wrong.'}
        </p>
      );
    default:
      return null;
  }
}
