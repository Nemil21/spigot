import { z } from 'zod';
import {
  BOT_CATEGORIES,
  POLICY_DECISIONS,
  type BotCategory,
  type PolicyDecision,
} from '@spigot/shared';
import { audit } from '../audit/audit.js';
import { emailField, nameField } from '../auth/credentials.js';
import type { PublisherAccount } from '../auth/publisherAuth.js';
import { crawlKeyHash, deriveCrawlKey, sentCrawlKeyVersionSql } from '../crawl/crawlKey.js';
import type { Db } from '../db/index.js';
import { bumpPolicyVersion, DEFAULT_DECISIONS, isValidRegex } from '../gate/policy.js';
import { ApiError } from '../http/errors.js';
import { forPublisher } from '../tenancy.js';
import { generateGateKey, sha256Hex } from '../sites/keys.js';

/**
 * W16 Settings (SP-034; screens.md §W16, features/02 §Edge cases, features/09 §Edge cases).
 *
 * - **Account / payout**: `name` and `payout_email` on `publishers`. A payout batch snapshots the
 *   email into `payout_items.receiver_email` when it is built (payouts/buildBatch.ts), so a change
 *   here applies to the next batch and never to one already built.
 * - **Gate policy**: per-category PASS / QUOTE and the owner's gated-path regexes, merged into
 *   `sites.policy` under a row lock (two concurrent edits of different categories both land), with
 *   `bumpPolicyVersion` in the same transaction so the gate's next refresh (≤ 60 s) sees it.
 *   SEARCH is always PASS (features/02: "As Googlebot, I'm never blocked").
 * - **Keys**: rotate the gate key (new random `gk_…`, old hash replaced: the installed gate gets
 *   401s and fails open until the owner sets the new key) or the crawl key (bump
 *   `crawl_key_version`, store the new derived key's hash, bump the policy so the gate swaps
 *   `crawlKeySha256` on its next refresh). The new key is returned once and never stored. The
 *   crawler keeps sending the key the gate still holds until the gate has pulled the new policy
 *   (crawl/crawlKey.ts `sentCrawlKeyVersionSql`), so it is never 402-ed in between.
 *
 * Every change is audited in its own transaction; publisher and site ids come from the session.
 */

// ---------------------------------------------------------------------------------------------
// Account + payout email

export const publisherPatchBody = z
  .object({ name: nameField.optional(), payoutEmail: emailField.optional() })
  .strict()
  .refine((b) => b.name !== undefined || b.payoutEmail !== undefined, {
    message: 'Send name or payoutEmail.',
  });

export type PublisherPatch = z.infer<typeof publisherPatchBody>;

export async function updatePublisher(
  db: Db,
  publisherId: string,
  patch: PublisherPatch,
): Promise<PublisherAccount> {
  return db.tx(async (tx) => {
    const { rows: before } = await tx.query<{ name: string; payout_email: string }>(
      'SELECT name, payout_email FROM publishers WHERE id = $1 FOR UPDATE',
      [publisherId],
    );
    const prev = before[0];
    if (!prev) throw new ApiError('UNAUTHENTICATED', 'Sign in to continue.');
    const name = patch.name ?? prev.name;
    const payoutEmail = patch.payoutEmail ?? prev.payout_email;
    const { rows } = await tx.query<PublisherAccount>(
      `UPDATE publishers SET name = $2, payout_email = $3, updated_at = now() WHERE id = $1
       RETURNING id, name, email, payout_email AS "payoutEmail", is_demo AS "isDemo"`,
      [publisherId, name, payoutEmail],
    );
    const changed: Record<string, { from: string; to: string }> = {};
    if (name !== prev.name) changed.name = { from: prev.name, to: name };
    if (payoutEmail !== prev.payout_email) {
      changed.payoutEmail = { from: prev.payout_email, to: payoutEmail };
    }
    if (Object.keys(changed).length > 0) {
      await audit(tx, {
        actorType: 'PUBLISHER',
        actorId: publisherId,
        publisherId,
        entity: 'publishers',
        entityId: publisherId,
        action: 'SETTINGS_CHANGED',
        data: { changed },
      });
    }
    return rows[0]!;
  });
}

// ---------------------------------------------------------------------------------------------
// Gate policy

/** The owner's own gated paths; datasets add theirs on top (the gate takes up to 200). */
export const MAX_GATED_PATHS = 50;
export const MAX_GATED_PATH_LENGTH = 500;

/** Categories the owner may change. SEARCH stays PASS so search engines are never quoted. */
export const EDITABLE_CATEGORIES = BOT_CATEGORIES.filter((c) => c !== 'SEARCH');

const gatedPath = z
  .string()
  .trim()
  .min(1, 'must not be empty')
  .max(MAX_GATED_PATH_LENGTH, `must be at most ${MAX_GATED_PATH_LENGTH} characters`)
  // An empty path already failed `min`; report one issue per path.
  .refine((p) => p.length === 0 || isValidRegex(p), {
    message: 'must be a valid regular expression',
  });

export const policyPatchBody = z
  .object({
    decisions: z
      .partialRecord(z.enum(BOT_CATEGORIES), z.enum(POLICY_DECISIONS))
      .refine((d) => d.SEARCH === undefined || d.SEARCH === 'PASS', {
        message: 'Search engines always pass, so your SEO is safe.',
        path: ['SEARCH'],
      })
      .optional(),
    gatedPaths: z
      .array(gatedPath)
      .max(MAX_GATED_PATHS, `at most ${MAX_GATED_PATHS} paths`)
      .optional(),
  })
  .strict()
  .refine((b) => b.decisions !== undefined || b.gatedPaths !== undefined, {
    message: 'Send decisions or gatedPaths.',
  });

export type PolicyPatch = z.infer<typeof policyPatchBody>;

export interface SitePolicyView {
  siteId: string;
  decisions: Record<BotCategory, PolicyDecision>;
  gatedPaths: string[];
  policyVersion: number;
}

function decisionsOf(policy: Record<string, unknown>): Record<BotCategory, PolicyDecision> {
  const out = { ...DEFAULT_DECISIONS };
  for (const c of BOT_CATEGORIES) {
    const v = policy[c];
    if ((POLICY_DECISIONS as readonly unknown[]).includes(v)) out[c] = v as PolicyDecision;
  }
  out.SEARCH = 'PASS';
  return out;
}

function gatedPathsOf(policy: Record<string, unknown>): string[] {
  const v = policy.gated_paths;
  return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : [];
}

/**
 * Merge `patch` into the site's policy. Changing nothing (the same values again) doesn't bump the
 * version, so a retried save is a no-op.
 */
export async function updateSitePolicy(
  db: Db,
  publisherId: string,
  siteId: string,
  patch: PolicyPatch,
): Promise<SitePolicyView> {
  return db.tx(async (tx) => {
    const site = await forPublisher(publisherId).get<{
      policy: Record<string, unknown>;
      policy_version: number;
    }>(tx, 'sites', siteId, { columns: 't.policy, t.policy_version', forUpdate: true });

    const prevDecisions = decisionsOf(site.policy);
    const prevPaths = gatedPathsOf(site.policy);
    const decisions = { ...prevDecisions, ...patch.decisions };
    const gatedPaths = patch.gatedPaths ? [...new Set(patch.gatedPaths)] : prevPaths;

    const decisionsChanged = BOT_CATEGORIES.filter((c) => decisions[c] !== prevDecisions[c]);
    const pathsChanged =
      gatedPaths.length !== prevPaths.length || gatedPaths.some((p, i) => p !== prevPaths[i]);
    if (decisionsChanged.length === 0 && !pathsChanged) {
      return { siteId, decisions, gatedPaths, policyVersion: site.policy_version };
    }

    // Keep any other keys a later ticket stores in `policy`.
    const policy = { ...site.policy, ...decisions, gated_paths: gatedPaths };
    await tx.query('UPDATE sites SET policy = $2::jsonb WHERE id = $1', [
      siteId,
      JSON.stringify(policy),
    ]);
    const policyVersion = await bumpPolicyVersion(tx, siteId);
    await audit(tx, {
      actorType: 'PUBLISHER',
      actorId: publisherId,
      publisherId,
      entity: 'sites',
      entityId: siteId,
      action: 'SETTINGS_CHANGED',
      data: {
        policyVersion,
        decisions: Object.fromEntries(
          decisionsChanged.map((c) => [c, { from: prevDecisions[c], to: decisions[c] }]),
        ),
        ...(pathsChanged ? { gatedPaths: { from: prevPaths, to: gatedPaths } } : {}),
      },
    });
    return { siteId, decisions, gatedPaths, policyVersion };
  });
}

// ---------------------------------------------------------------------------------------------
// Key rotation

export const KEY_KINDS = ['gate', 'crawl'] as const;
export type KeyKind = (typeof KEY_KINDS)[number];

export const rotateBody = z.object({ kind: z.enum(KEY_KINDS) }).strict();

export interface RotatedKey {
  siteId: string;
  kind: KeyKind;
  /** The new key, shown once. */
  key: string;
  /** The env var the publisher's gate reads it from. */
  envVar: 'SPIGOT_GATE_KEY' | 'SPIGOT_CRAWL_KEY';
  policyVersion: number;
}

/**
 * Replace one key's hash. Two concurrent rotations serialise on the row lock; each returns its
 * own key, and only the one that committed last is recognised afterwards.
 */
export async function rotateSiteKey(
  db: Db,
  crawlSecret: string,
  publisherId: string,
  siteId: string,
  kind: KeyKind,
): Promise<RotatedKey> {
  return db.tx(async (tx) => {
    const site = await forPublisher(publisherId).get<{
      crawl_key_version: number;
      sent_version: number;
      policy_version: number;
    }>(tx, 'sites', siteId, {
      columns: `t.crawl_key_version, ${sentCrawlKeyVersionSql('t')} AS sent_version,
                t.policy_version`,
      forUpdate: true,
    });

    let key: string;
    let policyVersion = site.policy_version;
    let data: Record<string, unknown>;
    if (kind === 'gate') {
      key = generateGateKey();
      await tx.query('UPDATE sites SET gate_key_hash = $2, updated_at = now() WHERE id = $1', [
        siteId,
        sha256Hex(key),
      ]);
      data = { kind };
    } else {
      const version = site.crawl_key_version + 1;
      key = deriveCrawlKey(siteId, crawlSecret, version);
      // The gate holds the crawl key's hash in its policy: a new ETag makes it re-read.
      policyVersion = await bumpPolicyVersion(tx, siteId);
      // Until the gate pulls `policyVersion`, the crawler keeps sending the key the gate holds
      // now: the one it was sending before this rotation (unchanged by a second rotation in a row).
      await tx.query(
        `UPDATE sites SET crawl_key_version = $2, crawl_key_hash = $3, crawl_key_prev_version = $4,
                          crawl_key_rotated_policy_version = $5, updated_at = now()
          WHERE id = $1`,
        [siteId, version, crawlKeyHash(key), site.sent_version, policyVersion],
      );
      data = { kind, crawlKeyVersion: version, policyVersion };
    }
    await audit(tx, {
      actorType: 'PUBLISHER',
      actorId: publisherId,
      publisherId,
      entity: 'sites',
      entityId: siteId,
      action: 'SITE_KEY_ROTATED',
      data,
    });
    return {
      siteId,
      kind,
      key,
      envVar: kind === 'gate' ? 'SPIGOT_GATE_KEY' : 'SPIGOT_CRAWL_KEY',
      policyVersion,
    };
  });
}
