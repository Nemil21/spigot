import { useCallback, useEffect, useState } from 'react';
import { useOutletContext } from 'react-router';
import { api, ApiError } from '../api/client';

/** `GET /api/auth/me` (SP-007a): the signed-in publisher and / or buyer. */
export interface AuthMe {
  publisher: {
    id: string;
    name: string;
    email: string;
    payoutEmail: string;
    isDemo: boolean;
  } | null;
  buyer: { id: string; name: string; email: string } | null;
  isAdmin: boolean;
}

export type PublisherSession = NonNullable<AuthMe['publisher']> & { isAdmin: boolean };
/** `GET /api/buyer/me` (SP-007a). */
export type BuyerSession = { id: string; name: string; email: string };

export type SessionState<T> =
  | { status: 'loading' }
  | { status: 'signedOut' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; session: T };

/**
 * Loads the session once per shell mount. A 401, or a session for the other kind of account,
 * is `signedOut`; anything else that fails is an `error` the shell shows with a retry.
 */
export function useSession<T>(load: () => Promise<T | null>): SessionState<T> & { retry(): void } {
  const [state, setState] = useState<SessionState<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    load().then(
      (session) =>
        live && setState(session ? { status: 'ready', session } : { status: 'signedOut' }),
      (error: unknown) =>
        live &&
        setState(
          error instanceof ApiError && error.status === 401
            ? { status: 'signedOut' }
            : { status: 'error', error },
        ),
    );
    return () => {
      live = false;
    };
    // `load` is a module-level function per shell; re-run only on retry.
  }, [attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}

export async function loadPublisherSession(): Promise<PublisherSession | null> {
  const me = await api.get<AuthMe>('/api/auth/me');
  return me.publisher ? { ...me.publisher, isAdmin: me.isAdmin } : null;
}

export async function loadBuyerSession(): Promise<BuyerSession | null> {
  return api.get<BuyerSession>('/api/buyer/me');
}

/** The signed-in publisher, for any page under PublisherShell. */
export function usePublisherSession(): PublisherSession {
  return useOutletContext<{ session: PublisherSession }>().session;
}

/** The signed-in buyer, for any page under BuyerShell. */
export function useBuyerSession(): BuyerSession {
  return useOutletContext<{ session: BuyerSession }>().session;
}
