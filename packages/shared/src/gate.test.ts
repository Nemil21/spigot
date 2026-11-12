import { describe, expect, it } from 'vitest';
import { gateHitsSchema, gatePolicySchema, HUMAN_BOT_NAME, MAX_HIT_BUCKETS } from './gate.js';

// api.md §Gate endpoints examples, with the elided hash filled in.
const policy = {
  siteId: '3f2b9c1e-6a4d-4e8f-9b0a-1c2d3e4f5a6b',
  policyVersion: 3,
  apiBase: 'https://spigot.onrender.com/v1/bluebonnet',
  catalogUrl: 'https://spigot.onrender.com/c/bluebonnet',
  crawlKeySha256: '9f1c'.padEnd(64, '0'),
  gatedPaths: ['^/listings/', '^/agents/', '^/open-houses/'],
  decisions: {
    SEARCH: 'PASS',
    AI_TRAINING: 'QUOTE',
    AI_AGENT: 'QUOTE',
    SCRAPER_TOOL: 'QUOTE',
    UNKNOWN: 'PASS',
  },
  prices: [{ dataset: 'listings', perRecordMicros: 1500, display: '$1.50 per 1,000 records' }],
};

const bucket = {
  bucket: '2026-11-11T17:42:00Z',
  category: 'AI_TRAINING',
  botName: 'GPTBot',
  decision: 'QUOTE_402',
  hits: 41,
  bytes: 0,
  isSimulated: false,
};

describe('gate policy schema', () => {
  it('accepts the api.md example', () => {
    expect(gatePolicySchema.parse(policy)).toEqual(policy);
  });

  it('requires a decision for every category', () => {
    const { UNKNOWN: _u, ...partial } = policy.decisions;
    expect(gatePolicySchema.safeParse({ ...policy, decisions: partial }).success).toBe(false);
  });

  it('rejects invalid regexes, bad hashes and unknown decisions', () => {
    expect(gatePolicySchema.safeParse({ ...policy, gatedPaths: ['^/listings/('] }).success).toBe(
      false,
    );
    expect(gatePolicySchema.safeParse({ ...policy, crawlKeySha256: '9f1c…' }).success).toBe(false);
    expect(
      gatePolicySchema.safeParse({ ...policy, decisions: { ...policy.decisions, SEARCH: 'BLOCK' } })
        .success,
    ).toBe(false);
  });
});

describe('gate hits schema', () => {
  it('accepts the api.md example with per-bucket isSimulated', () => {
    const body = {
      sentAt: '2026-11-11T17:42:10.123Z',
      buckets: [
        bucket,
        { ...bucket, botName: 'ClaudeBot', category: 'AI_AGENT', isSimulated: true },
        {
          ...bucket,
          category: 'HUMAN',
          botName: HUMAN_BOT_NAME,
          decision: 'PASS',
          hits: 900,
          bytes: 4_200_000,
        },
      ],
    };
    expect(gateHitsSchema.parse(body)).toEqual(body);
  });

  it('requires isSimulated on every bucket (SIM traffic must never count as real)', () => {
    const { isSimulated: _s, ...withoutSim } = bucket;
    expect(gateHitsSchema.safeParse({ sentAt: bucket.bucket, buckets: [withoutSim] }).success).toBe(
      false,
    );
    expect(
      gateHitsSchema.safeParse({
        sentAt: bucket.bucket,
        buckets: [{ ...bucket, isSimulated: 'true' }],
      }).success,
    ).toBe(false);
  });

  it.each([
    ['mid-minute bucket', { bucket: '2026-11-11T17:42:30Z' }],
    ['unknown category', { category: 'CRAWLER' }],
    ['unknown decision', { decision: 'BLOCK' }],
    ['zero hits', { hits: 0 }],
    ['negative bytes', { bytes: -1 }],
    ['fractional hits', { hits: 1.5 }],
    ['empty botName', { botName: '' }],
  ])('rejects a %s', (_name, patch) => {
    expect(
      gateHitsSchema.safeParse({ sentAt: bucket.bucket, buckets: [{ ...bucket, ...patch }] })
        .success,
    ).toBe(false);
  });

  it('caps a flush at the gate counter limit', () => {
    const buckets = Array.from({ length: MAX_HIT_BUCKETS + 1 }, () => bucket);
    expect(gateHitsSchema.safeParse({ sentAt: bucket.bucket, buckets }).success).toBe(false);
  });
});
