import { describe, expect, it } from 'vitest';
import { ACTIVITY_ACTIONS, activityLine, botRatioLine } from './copy.js';

describe('botRatioLine (W04 KPI, SP-027a)', () => {
  it("reads api.md's example: 18,420 bots and 571,000 humans → 1 bot per 31 human visits", () => {
    expect(botRatioLine(18_420, 571_000)).toBe('1 bot per 31 human visits');
  });
  it('groups thousands and handles the edges', () => {
    expect(botRatioLine(1, 12_345)).toBe('1 bot per 12,345 human visits');
    expect(botRatioLine(10, 10)).toBe('1 bot per human visit');
    expect(botRatioLine(30, 10)).toBe('3 bots per human visit');
    expect(botRatioLine(0, 500)).toBe('No bot visits yet');
    expect(botRatioLine(0, 0)).toBe('No bot visits yet');
    expect(botRatioLine(42, 0)).toBe('Only bots, no human visits');
  });
});

describe('activityLine (W04 activity feed, SP-027a)', () => {
  it('words each action with the money copy rule', () => {
    expect(activityLine('SCHEMA_PROPOSED', { typeName: 'Listing', records: 2341 })).toBe(
      'Proposal ready: Listing · 2,341 records',
    );
    expect(activityLine('DATASET_PUBLISHED', { typeName: 'Listing', records: 2341 })).toBe(
      'Listing published · 2,341 records live',
    );
    expect(
      activityLine('CALL_CHARGED', {
        buyerName: 'Acme Agents',
        typeName: 'Listing',
        priceMicros: 55_500,
        records: 37,
      }),
    ).toBe('Acme Agents: $0.0555 charged for 37 Listing records');
    expect(activityLine('TOPUP_COMPLETED', { buyerName: 'Acme Agents', amountCents: 2000 })).toBe(
      'Acme Agents added $20 via PayPal',
    );
    expect(activityLine('PAYOUT_SENT', { amountCents: 41_275 })).toBe('$412.75 sent via PayPal');
    expect(activityLine('PAYOUT_SETTLED', { amountCents: 41_275 })).toBe(
      '$412.75 paid out via PayPal',
    );
    expect(activityLine('PAYOUT_SETTLED', { amountCents: 41_275, payoutStatus: 'UNCLAIMED' })).toBe(
      '$412.75 waiting for you to claim in PayPal',
    );
    expect(
      activityLine('CRAWL_RUN_DONE', {
        crawlStatus: 'SUCCEEDED',
        pagesFetched: 2341,
        recordsChanged: 12,
      }),
    ).toBe('Crawl finished · 2,341 pages, 12 records changed');
    expect(activityLine('CRAWL_RUN_DONE', { crawlStatus: 'FAILED' })).toBe('Crawl failed');
  });

  it('never throws on a sparse audit row', () => {
    for (const action of ACTIVITY_ACTIONS) {
      expect(activityLine(action, {})).toMatch(/\S/);
    }
    expect(activityLine('CALL_CHARGED', {})).toBe('A buyer: call charged');
    expect(activityLine('TOPUP_COMPLETED', {})).toBe('A buyer topped up via PayPal');
  });
});
