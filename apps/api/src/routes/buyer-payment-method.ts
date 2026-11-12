import type { FastifyPluginAsync } from 'fastify';
import { requireBuyerSession } from '../auth/buyerAuth.js';

/**
 * The signed-in buyer's saved payment method (SP-063; screens.md §W11 "saved method"):
 * - `GET /api/buyer/payment-method` → `{ savedMethod: { kind: 'CARD' | 'PAYPAL', label } | null }`
 *
 * `label` is what PayPal returned when it vaulted the method ("Visa ••1111", "PayPal · sb-…"),
 * saved by `creditTopup`. The vault id itself never leaves the server. SP-047b's auto top-up card
 * reads the same fields. Tenancy: `security/tenancy/buyer-payment-method.cases.ts`.
 */
const buyerPaymentMethodRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/buyer/payment-method', async (req, reply) => {
    const buyer = requireBuyerSession(req);
    reply.header('Cache-Control', 'no-store');
    const { rows } = await app.db.pool.query<{
      kind: 'CARD' | 'PAYPAL' | null;
      label: string | null;
      vaulted: boolean;
    }>(
      `SELECT vault_kind AS kind, vault_label AS label, vault_id IS NOT NULL AS vaulted
         FROM buyers WHERE id = $1`,
      [buyer.id],
    );
    const row = rows[0];
    if (!row?.vaulted || !row.kind) return { savedMethod: null };
    return {
      savedMethod: {
        kind: row.kind,
        label: row.label ?? (row.kind === 'CARD' ? 'Saved card' : 'PayPal'),
      },
    };
  });
};

export default buyerPaymentMethodRoutes;
