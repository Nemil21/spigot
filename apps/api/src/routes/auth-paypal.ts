import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  callbackUrl,
  LIPP_COOKIE,
  LIPP_COOKIE_PATH,
  LIPP_TTL_MS,
  newLippState,
  openLippState,
  PayPalLoginError,
  paypalIdentity,
  sameSecret,
  signLippState,
} from '../auth/paypalOidc.js';
import { linkPayPal, signInWithPayPal, type PayPalSignIn } from '../auth/publisherPaypal.js';
import { secureCookies, setSessionCookie } from '../auth/sessions.js';
import { rateLimit } from '../http/rateLimit.js';

/**
 * Log in with PayPal for publishers (SP-058; features/14 §Auth; screens.md §W02, §W16).
 *
 * - `GET /api/auth/paypal/start` → 302 to PayPal consent with a fresh `state` + `nonce`, both kept
 *   in a signed 10-minute HttpOnly cookie (`spg_lipp`, path `/api/auth/paypal`). Linking is
 *   explicit: only `?intent=connect` (W16 "Connect with PayPal") with a publisher session links
 *   PayPal to that account. A plain `/start` (W02 login / sign up) is always a login, even when a
 *   session exists: the callback replaces that session with the PayPal publisher's.
 * - `GET /api/auth/paypal/callback?code&state` (or `?error=access_denied&state`) → checks the
 *   state, exchanges the code (nonce checked against the `id_token`), requires a verified email
 *   and a payer id, then signs in, creates or links the publisher (auth/publisherPaypal.ts) and
 *   302s into the web app. Every failure is a 302 with `?paypal=<reason>`, never a JSON error:
 *   the browser arrives here from PayPal.
 *
 * Reasons: `cancelled`, `state` (missing / mismatched / expired state, or the session changed
 * since /start), `unverified` (no verified email or payer id), `link-required` (the email
 * belongs to a password account not linked yet), `taken` (payer id linked to another
 * publisher), `error` (PayPal failed).
 */
const byIp = rateLimit('auth', (req) => req.ip);

export const LIPP_REDIRECT = {
  home: '/app',
  created: '/app/connect',
  login: '/app/login',
  settings: '/app/settings?tab=payout',
} as const;

function withReason(path: string, reason: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}paypal=${reason}`;
}

const authPaypalRoutes: FastifyPluginAsync = async (app) => {
  const cookieOpts = () => ({
    path: LIPP_COOKIE_PATH,
    httpOnly: true,
    // Lax: PayPal's redirect back is a top-level GET, which carries a Lax cookie.
    sameSite: 'lax' as const,
    secure: secureCookies(app.config),
  });

  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/api/auth/paypal/start',
    { preHandler: byIp },
    async (req, reply) => {
      const connect = req.query.intent === 'connect';
      const st = newLippState(connect ? (req.publisher?.id ?? null) : null);
      reply.setCookie(LIPP_COOKIE, signLippState(app.config.SESSION_SECRET, st), {
        ...cookieOpts(),
        maxAge: Math.floor(LIPP_TTL_MS / 1000),
      });
      reply.header('cache-control', 'no-store');
      const url = paypalIdentity(app.config).authorizeUrl({
        state: st.state,
        nonce: st.nonce,
        redirectUri: callbackUrl(app.config),
      });
      return reply.redirect(url, 302);
    },
  );

  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/api/auth/paypal/callback',
    { preHandler: byIp },
    async (req, reply) => {
      const st = openLippState(app.config.SESSION_SECRET, req.cookies[LIPP_COOKIE]);
      // One use: whatever happens next, this state is spent.
      reply.clearCookie(LIPP_COOKIE, cookieOpts());
      reply.header('cache-control', 'no-store');
      const back = (reason: string, linking = !!st?.link): FastifyReply =>
        reply.redirect(
          withReason(linking ? LIPP_REDIRECT.settings : LIPP_REDIRECT.login, reason),
          302,
        );

      const { code, state, error } = req.query;
      if (typeof error === 'string' && error) return back('cancelled');
      if (!st || typeof state !== 'string' || !sameSecret(state, st.state)) {
        return back('state', false);
      }
      // Connect must finish as the same publisher that started it. A login ignores the session.
      if (st.link && req.publisher?.id !== st.link) return back('state', false);
      if (typeof code !== 'string' || !code || code.length > 2048) return back('error');

      let identity;
      try {
        identity = await paypalIdentity(app.config).exchange(code, st.nonce);
      } catch (err) {
        if (!(err instanceof PayPalLoginError)) throw err;
        // Stage and PayPal's error code only: never the code, a token or the identity.
        req.log.warn({ stage: err.stage, http: err.http, code: err.code }, 'paypal login failed');
        return back(err.stage === 'id_token' ? 'state' : 'error');
      }
      const { payerId } = identity;
      if (!identity.emailVerified || !payerId) return back('unverified');
      const verified = { ...identity, payerId };

      const result: PayPalSignIn = st.link
        ? await linkPayPal(app.db.pool, st.link, verified)
        : await signInWithPayPal(app.db.pool, verified);
      switch (result.outcome) {
        case 'linked':
          return reply.redirect(withReason(LIPP_REDIRECT.settings, 'connected'), 302);
        case 'signed-in':
        case 'created':
          setSessionCookie(reply, app.config, 'publisher', result.publisherId);
          return reply.redirect(
            result.outcome === 'created' ? LIPP_REDIRECT.created : LIPP_REDIRECT.home,
            302,
          );
        case 'not-found':
          return back('state', false);
        default:
          return back(result.outcome);
      }
    },
  );
};

export default authPaypalRoutes;
