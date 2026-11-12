import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DATASET_UNPUBLISHED_MESSAGE,
  MONEY_WORDS,
  PAYOUT_ITEM_STATUSES,
  autoTopupCapReachedMessage,
  autoTopupDeclinedMessage,
  chargedLine,
  crawlBlockedMessage,
  creditedLine,
  formatAge,
  insufficientBalanceMessage,
  payoutLine,
  payoutStatusLabel,
  payoutUnclaimedMessage,
  priceAboveMaxMessage,
  refundedToPayPalLine,
  staleDataMessage,
} from './copy.js';

// W15 strings built from the example numbers screens.md uses. Placeholders in the spec (`<link>`,
// `publisher@…`) are passed through as-is so the output can be compared with the spec text.
const w15 = {
  'Insufficient balance (API/MCP)': insufficientBalanceMessage({
    priceMicros: 55_500,
    balanceMicros: 12_000,
    topUpUrl: '<link>',
  }),
  'Price above max': priceAboveMaxMessage({
    records: 1_000,
    priceMicros: 1_500_000,
    maxPriceMicros: 1_000_000,
  }),
  'Auto top-up cap reached': autoTopupCapReachedMessage({ monthlyCapCents: 10_000 }),
  'Auto top-up declined': autoTopupDeclinedMessage(),
  'Dataset unpublished (410)': DATASET_UNPUBLISHED_MESSAGE,
  'Stale data': staleDataMessage({ lastGoodExtractAgeMs: 6 * 3_600_000 }),
  'Payout unclaimed': payoutUnclaimedMessage({
    amountCents: 41_275,
    payoutEmail: 'publisher@…',
  }),
  'Crawl blocked by origin': crawlBlockedMessage({ httpStatus: 429, retryAfterMs: 10 * 60_000 }),
};

/** `- **Label:** "text"` lines (or a freshness-badge line) under `### W15` in screens.md. */
function specW15(): Record<string, string> {
  const md = readFileSync(new URL('../../../docs/spec/screens.md', import.meta.url), 'utf8');
  const section = md.split('### W15')[1]?.split('\n## ')[0] ?? '';
  const out: Record<string, string> = {};
  for (const m of section.matchAll(/^- \*\*(.+?):\*\*.*?"(.+)"\s*$/gm)) {
    out[m[1]!] = m[2]!;
  }
  return out;
}

describe('W15 copy (screens.md)', () => {
  it('matches every W15 line in screens.md word for word', () => {
    expect(w15).toEqual(specW15());
  });

  it('pins every W15 string', () => {
    expect(w15).toMatchInlineSnapshot(`
      {
        "Auto top-up cap reached": "Auto top-up is at its $100 monthly cap. Top up by hand or raise the cap.",
        "Auto top-up declined": "PayPal declined the saved card. Auto top-up is off until you update it.",
        "Crawl blocked by origin": "Your site returned 429. We paused and will retry after 10 min.",
        "Dataset unpublished (410)": "The owner stopped selling this data.",
        "Insufficient balance (API/MCP)": "This call costs $0.0555 and your balance is $0.012. Top up with PayPal: <link>.",
        "Payout unclaimed": "PayPal sent $412.75 to publisher@…, which has no PayPal account yet.",
        "Price above max": "This would return 1,000 records ($1.50), above your $1.00 per-call limit. Narrow the filters or raise \`max_price_micros\`.",
        "Stale data": "Last good extract 6 h ago; the site changed layout.",
      }
    `);
  });

  it('words a saved PayPal wallet decline', () => {
    expect(autoTopupDeclinedMessage({ method: 'PAYPAL' })).toBe(
      'PayPal declined the saved PayPal account. Auto top-up is off until you update it.',
    );
  });

  it('uses the singular for one record', () => {
    expect(
      priceAboveMaxMessage({ records: 1, priceMicros: 1_500, maxPriceMicros: 1_000 }),
    ).toContain('return 1 record ($0.0015)');
  });

  it.each([
    [0, '0 s'],
    [59_999, '59 s'],
    [60_000, '1 min'],
    [3_599_999, '59 min'],
    [3_600_000, '1 h'],
    [47 * 3_600_000, '47 h'],
    [48 * 3_600_000, '2 d'],
    [-5, '0 s'],
  ])('formatAge(%i) = %s', (ms, text) => {
    expect(formatAge(ms)).toBe(text);
  });
});

describe('money copy rule (screens.md)', () => {
  it('has the exact rule words', () => {
    expect(MONEY_WORDS).toEqual({
      charged: 'charged',
      credited: 'credited',
      refundedToPayPal: 'refunded to PayPal',
      sent: 'sent',
      paidOut: 'paid out',
      waitingToClaim: 'waiting for you to claim',
    });
  });

  it('builds lines from the numbers', () => {
    expect(chargedLine(55_500)).toBe('$0.0555 charged');
    expect(creditedLine(1_500)).toBe('$0.0015 credited');
    expect(refundedToPayPalLine(740)).toBe('$7.40 refunded to PayPal');
  });

  it('says "sent" only for PENDING, "paid out" only for SUCCESS, "claim" only for UNCLAIMED', () => {
    const lines = PAYOUT_ITEM_STATUSES.map((s) => [s, payoutLine(s, 41_275)] as const);
    expect(lines.filter(([, l]) => l.includes(' sent ')).map(([s]) => s)).toEqual(['PENDING']);
    expect(lines.filter(([, l]) => l.includes('paid out')).map(([s]) => s)).toEqual(['SUCCESS']);
    expect(lines.filter(([, l]) => l.includes('claim')).map(([s]) => s)).toEqual(['UNCLAIMED']);
    expect(payoutLine('SUCCESS', 41_275)).toBe('$412.75 paid out via PayPal');
    expect(payoutLine('PENDING', 41_275)).toBe('$412.75 sent via PayPal');
    expect(payoutLine('UNCLAIMED', 41_275)).toBe('$412.75 waiting for you to claim in PayPal');
  });

  it('labels W09 status pills', () => {
    expect(PAYOUT_ITEM_STATUSES.map(payoutStatusLabel)).toEqual([
      'Sent',
      'Paid out',
      'Waiting for you to claim',
      'Failed → retrying next batch',
      'Returned → retrying next batch',
    ]);
  });
});
