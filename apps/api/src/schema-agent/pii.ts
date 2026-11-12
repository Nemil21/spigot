// PII and rights guard (features/04 §5): plain code that runs after the model, on the values the
// extractor actually pulls from the sample pages. It can only hide a field, never show one: a
// field is visible only when the model didn't hide it and no check fired. Phones, emails and (for
// person-like records) street + unit addresses → `pii: true`; wire-service bylines →
// `rights_flag: true`; both → `visible: false` by default. The owner decides on W06.
import type { FieldType, FieldValue } from '@spigot/shared';
import { OPS_BY_TYPE, type FilterOp } from '../records/fields.js';
import type { DryRun } from './dryrun.js';
import type { Proposal } from './tool.js';

/**
 * North-American and international numbers: optional `+<country code>`, optional parentheses,
 * and an optional space / dot / dash between every group (`(512) 555-0158`, `512 555 0158`,
 * `5125550158`, `+1 512 555 0158`, `+44 20 7946 0958`). A bare run of 10 digits counts too:
 * the guard can only hide a field, so over-matching costs the owner one toggle on W06.
 */
export const PHONE_RE =
  /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\b\d{2,4})[\s.-]?\d{3,4}[\s.-]?\d{4}\b/;
/** `tel:`, `sms:` and `mailto:` links are contact data whatever follows. */
export const CONTACT_URI_RE = /(?:^|[^A-Za-z])(?:tel|sms|mailto|callto):/i;
export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
export const STREET_UNIT_RE =
  /\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s+){1,4}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Ter|Terrace|Pkwy|Parkway|Cir|Circle|Hwy|Highway|Loop|Trail|Trl)\b\.?(?:,?\s*(?:Apt|Apartment|Unit|Suite|Ste|#)\.?\s*[A-Za-z0-9-]+)?/i;
export const BYLINE_RE = /\b(AP|Associated Press|Reuters|AFP|Getty)\b/;
/** Field names that are personal data whatever the samples say (defence in depth). */
export const PII_NAME_RE =
  /(^|_)(phone|phones|tel|telephone|mobile|cell|fax|email|emails|e_mail|ssn|social_security)(_|$)/;

const PERSON_TYPE_RE =
  /\b(agent|person|people|user|member|author|contact|profile|customer|tenant|owner|host|staff|employee|realtor|broker)\b/i;
const PERSON_JSONLD = new Set(['Person', 'RealEstateAgent', 'Patient', 'Employee']);

export function isPersonLike(typeName: string, jsonldTypes: readonly string[]): boolean {
  return PERSON_TYPE_RE.test(typeName) || jsonldTypes.some((t) => PERSON_JSONLD.has(t));
}

/** What `schema_versions.fields` stores for each field (SP-015's `servedFields` reads it). */
export interface StoredField {
  name: string;
  type: FieldType;
  description: string | null;
  required: boolean;
  visible: boolean;
  pii: boolean;
  rights_flag: boolean;
  /** Ops buyers may use; always empty for a hidden field. */
  filterable: FilterOp[];
}

export interface GuardFlag {
  field: string;
  flag: 'pii' | 'rights_flag';
  reason: string;
}

export interface GuardResult {
  fields: StoredField[];
  flags: GuardFlag[];
}

const texts = (v: FieldValue): string[] =>
  v === null ? [] : Array.isArray(v) ? v.map(String) : [String(v)];

export function guardFields(
  proposal: Proposal,
  run: Pick<DryRun, 'values' | 'rawText' | 'nearbyText'>,
  ctx: { jsonldTypes: readonly string[] },
): GuardResult {
  const person = isPersonLike(proposal.typeName, ctx.jsonldTypes);
  const flags: GuardFlag[] = [];

  const fields = proposal.fields.map((f): StoredField => {
    const own = [
      ...(run.values[f.name] ?? []).flatMap(texts),
      ...(run.rawText[f.name] ?? []),
    ].filter(Boolean);
    const nearby = (run.nearbyText[f.name] ?? []).filter(Boolean);

    const piiReasons = [
      f.pii === true && 'flagged by the model',
      own.some((t) => PHONE_RE.test(t)) && 'phone number in sample values',
      own.some((t) => EMAIL_RE.test(t)) && 'email address in sample values',
      own.some((t) => CONTACT_URI_RE.test(t)) && 'tel: / mailto: link in sample values',
      person && own.some((t) => STREET_UNIT_RE.test(t)) && 'street address in a person-like record',
      PII_NAME_RE.test(f.name) && 'field name denotes contact data',
    ].filter((r): r is string => typeof r === 'string');
    const rightsReasons = [
      f.rights_flag === true && 'flagged by the model',
      [...own, ...nearby].some((t) => BYLINE_RE.test(t)) &&
        'wire-service byline or credit near the value',
    ].filter((r): r is string => typeof r === 'string');
    for (const reason of piiReasons) flags.push({ field: f.name, flag: 'pii', reason });
    for (const reason of rightsReasons) flags.push({ field: f.name, flag: 'rights_flag', reason });
    const pii = piiReasons.length > 0;
    const rights = rightsReasons.length > 0;

    const visible = f.visible !== false && !pii && !rights;
    const allowed = OPS_BY_TYPE[f.type] ?? [];
    const filterable = visible
      ? [...new Set(f.filterable ?? [])].filter((op) => allowed.includes(op))
      : [];
    return {
      name: f.name,
      type: f.type,
      description: f.description ?? null,
      required: f.required,
      visible,
      pii,
      rights_flag: rights,
      filterable,
    };
  });
  return { fields, flags };
}
