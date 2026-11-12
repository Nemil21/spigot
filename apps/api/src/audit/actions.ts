/**
 * Every `audit_events.action` (features/14 §Audit and ops). `audit()` accepts only these; a new
 * action is added here, in the ticket that first writes it. Each owning ticket writes its own rows
 * (SP-016 owns the SIM sampling rule for `CALL_CHARGED`).
 */
export const AUDIT_ACTIONS = [
  'SITE_CONNECTED',
  'SITE_VERIFIED',
  'CRAWL_RUN_DONE',
  'SCHEMA_PROPOSED',
  // SP-012a: a proposal run started (the resume job's 5-minute marker) / finished (per-template
  // outcomes; `data.message` = "no repeated structure found" is W05's empty state).
  'SCHEMA_PROPOSAL_STARTED',
  'SCHEMA_PROPOSAL_DONE',
  'SCHEMA_APPROVED',
  'DATASET_PUBLISHED',
  'DATASET_UNPUBLISHED',
  'TOPUP_CREATED',
  'TOPUP_COMPLETED',
  'TOPUP_FAILED',
  'CALL_CHARGED',
  'CLAIM_DECIDED',
  'REFUND_REQUESTED',
  'REFUND_COMPLETED',
  'PAYOUT_SENT',
  'PAYOUT_SETTLED',
  'PAYOUT_RETURNED',
  'DEMO_RESET',
  'ALERT',
  // Written by SP-020 (payouts/submit.ts, merged before this union existed) for payout-run alerts.
  'PAYOUT_ALERT',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

const ACTION_SET: ReadonlySet<string> = new Set(AUDIT_ACTIONS);

export function isAuditAction(action: unknown): action is AuditAction {
  return typeof action === 'string' && ACTION_SET.has(action);
}

/** `audit_events.actor_type` (the CHECK constraint in db/migrations/001_init.sql). */
export const ACTOR_TYPES = [
  'PUBLISHER',
  'BUYER',
  'MCP_CLIENT',
  'SCHEMA_AGENT',
  'WORKFLOW',
  'GATE',
  'PAYPAL_WEBHOOK',
  'SYSTEM',
  'SIM',
] as const;

export type ActorType = (typeof ACTOR_TYPES)[number];
