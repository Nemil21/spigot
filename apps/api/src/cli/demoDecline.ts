// `npm run demo:decline` (SP-047b; features/15 §Demo hooks, features/08 §Auto top-up 5): flags a
// buyer (`buyers.mock_decline_next`) so its next AUTO top-up sends `PayPal-Mock-Response
// {"mock_application_codes":"INSTRUMENT_DECLINED"}`. `reserveVaultTopup` consumes the flag (one
// shot); the decline turns auto top-up off and W11 shows "PayPal declined the saved card. Auto
// top-up is off until you update it." Refused unless sandbox + DEMO_MODE + ALLOW_MOCK_DECLINE
// (`mockDeclinesAllowed`): the client would drop the header anyway, and the flag would be a lie.
import { mockDeclinesAllowed, type Config } from '../config.js';
import type { Queryable } from '../db/index.js';
import { DemoResetRefused } from './demoReset.js';
import { DEMO_BUYER } from './seedDemo.js';

export interface DemoDeclineResult {
  buyerId: string;
  email: string;
  /** The flag after this run. */
  armed: boolean;
  /** Auto top-up is on with a saved method, so a short call will actually try the vault. */
  autoTopupReady: boolean;
}

export function assertMockDeclines(
  config: Pick<Config, 'DEMO_MODE' | 'ALLOW_MOCK_DECLINE' | 'paypalIsSandbox'>,
): void {
  if (!mockDeclinesAllowed(config as Config)) {
    throw new DemoResetRefused(
      'demo:decline needs a PayPal sandbox base with DEMO_MODE=true and ALLOW_MOCK_DECLINE=true.',
    );
  }
}

export async function demoDecline(
  db: Queryable,
  opts: { buyerEmail?: string; clear?: boolean } = {},
): Promise<DemoDeclineResult> {
  const email = opts.buyerEmail ?? DEMO_BUYER.email;
  const { rows } = await db.query<{
    id: string;
    simulated: boolean;
    ready: boolean;
  }>(
    `UPDATE buyers SET mock_decline_next = $2, updated_at = now()
      WHERE email = $1 AND NOT is_simulated
      RETURNING id, is_simulated AS simulated, (auto_topup_enabled AND vault_id IS NOT NULL) AS ready`,
    [email, !opts.clear],
  );
  const b = rows[0];
  if (!b) throw new DemoResetRefused(`No foreground buyer ${email}: run seed:demo first.`);
  return { buyerId: b.id, email, armed: !opts.clear, autoTopupReady: b.ready };
}

/** The lines the CLI prints. */
export function formatDecline(r: DemoDeclineResult): string[] {
  if (!r.armed) return [`demo:decline: cleared for ${r.email}; auto top-ups charge normally.`];
  const lines = [
    `demo:decline: armed for ${r.email}. The next auto top-up gets PayPal-Mock-Response INSTRUMENT_DECLINED.`,
    "  Make a paid call the balance can't cover; W11 then shows the declined banner.",
  ];
  if (!r.autoTopupReady) {
    lines.push(
      '  warning: auto top-up is off or there is no saved method, so no auto top-up will run yet.',
    );
  }
  return lines;
}
