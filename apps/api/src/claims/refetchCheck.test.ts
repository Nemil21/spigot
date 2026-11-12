import { describe, expect, it } from 'vitest';
import { claimSummary } from '../mcp/tools/claims.js';
import { changedVisibleFields, visibleFields } from './refetchCheck.js';

const FIELDS = [
  { name: 'title', type: 'string', required: true, visible: true },
  { name: 'status', type: 'string', visible: true },
  { name: 'amenities', type: 'string[]', visible: true },
  { name: 'agent_phone', type: 'string', visible: false },
  { name: 'draft' },
];

describe('SP-048c re-fetch comparison', () => {
  it('visibleFields: only `visible: true` names; junk is ignored', () => {
    expect(visibleFields(FIELDS)).toEqual(['title', 'status', 'amenities']);
    expect(visibleFields(null)).toEqual([]);
    expect(visibleFields([null, 1, { visible: true }])).toEqual([]);
  });

  it('changedVisibleFields: a visible change counts, a hidden one never does', () => {
    const served = { title: 'Loft', status: 'available', amenities: ['pool'], agent_phone: '1' };
    const fields = visibleFields(FIELDS);
    expect(changedVisibleFields(served, { ...served, agent_phone: '2' }, fields)).toEqual([]);
    expect(changedVisibleFields(served, { ...served, status: 'leased' }, fields)).toEqual([
      'status',
    ]);
    expect(changedVisibleFields(served, { ...served, amenities: ['pool', 'gym'] }, fields)).toEqual(
      ['amenities'],
    );
  });

  it('changedVisibleFields: absent and null are the same value', () => {
    expect(
      changedVisibleFields({ title: 'A', status: null }, { title: 'A' }, ['title', 'status']),
    ).toEqual([]);
  });

  it('claimSummary: credited vs open copy', () => {
    expect(claimSummary({ claimId: 'c', status: 'AUTO_CREDITED', creditMicros: 1_500 })).toBe(
      'Claim confirmed: $0.0015 credited back to your balance.',
    );
    expect(claimSummary({ claimId: 'c', status: 'OPEN', creditMicros: 0 })).toMatch(
      /site owner will review it; nothing is credited yet/,
    );
  });
});
