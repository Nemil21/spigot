import { describe, expect, it } from 'vitest';
import {
  dataAtHash,
  isDuplicate,
  missingRequired,
  parseServedKeys,
  requiredVisibleFields,
  runCheck,
  type VersionRow,
} from './checks.js';
import { withinAbuseLimit } from './credit.js';

const versions: VersionRow[] = [
  {
    version: 1,
    op: 'add',
    patch: [{ op: 'add', path: '', value: { title: 'A', beds: 2 } }],
    hash: 'h1',
  },
  { version: 2, op: 'update', patch: [{ op: 'replace', path: '/title', value: null }], hash: 'h2' },
  { version: 3, op: 'update', patch: [{ op: 'replace', path: '/title', value: 'B' }], hash: 'h3' },
];

const FIELDS = [
  { name: 'title', type: 'string', required: true, visible: true },
  { name: 'beds', type: 'integer', visible: true },
  { name: 'agent_phone', type: 'string', required: true, visible: false },
];

describe('dataAtHash', () => {
  it('rebuilds the record as it was when that hash was served', () => {
    expect(dataAtHash(versions, 'h1')).toEqual({ title: 'A', beds: 2 });
    expect(dataAtHash(versions, 'h2')).toEqual({ title: null, beds: 2 });
    expect(dataAtHash(versions, 'h3')).toEqual({ title: 'B', beds: 2 });
  });
  it('is order-independent on input and null for an unknown hash', () => {
    expect(dataAtHash([...versions].reverse(), 'h2')).toEqual({ title: null, beds: 2 });
    expect(dataAtHash(versions, 'nope')).toBeNull();
  });
  it('skips remove versions and restarts from a re-add', () => {
    const v: VersionRow[] = [
      ...versions,
      { version: 4, op: 'remove', patch: [], hash: 'h3' },
      {
        version: 5,
        op: 'add',
        patch: [{ op: 'add', path: '', value: { title: null } }],
        hash: 'h5',
      },
    ];
    expect(dataAtHash(v, 'h5')).toEqual({ title: null });
  });
  it('returns null on a malformed patch instead of throwing', () => {
    expect(dataAtHash([{ version: 1, op: 'add', patch: 'x', hash: 'h' }], 'h')).toBeNull();
    expect(
      dataAtHash(
        [
          {
            version: 1,
            op: 'update',
            patch: [{ op: 'replace', path: '/a/b', value: 1 }],
            hash: 'h',
          },
        ],
        'h',
      ),
    ).toBeNull();
  });
});

describe('required fields', () => {
  it('only required AND visible fields count', () => {
    expect(requiredVisibleFields(FIELDS)).toEqual(['title']);
    expect(requiredVisibleFields(null)).toEqual([]);
  });
  it('null or absent is missing; falsy values are not', () => {
    expect(missingRequired({ title: null }, ['title'])).toEqual(['title']);
    expect(missingRequired({}, ['title'])).toEqual(['title']);
    expect(missingRequired({ title: '', n: 0 }, ['title', 'n'])).toEqual([]);
  });
});

describe('isDuplicate', () => {
  const served = [
    { key: 'd/a', hash: 'x' },
    { key: 'd/b', hash: 'y' },
    { key: 'd/c', hash: 'x' },
  ];
  it('credits the later copy, never the first', () => {
    expect(isDuplicate(served, 'd/c')).toBe(true);
    expect(isDuplicate(served, 'd/a')).toBe(false);
    expect(isDuplicate(served, 'd/b')).toBe(false);
    expect(isDuplicate(served, 'd/zzz')).toBe(false);
  });
});

describe('runCheck', () => {
  const served = [{ key: 'd/r', hash: 'h2' }];
  it('MISSING_FIELD is confirmed from the served version, not the current one', () => {
    const r = runCheck({
      reason: 'MISSING_FIELD',
      key: 'd/r',
      served,
      versions,
      storedFields: FIELDS,
    });
    expect(r).toEqual({ confirmed: true, detail: { check: 'MISSING_FIELD', missing: ['title'] } });
    const later = runCheck({
      reason: 'MISSING_FIELD',
      key: 'd/r',
      served: [{ key: 'd/r', hash: 'h3' }],
      versions,
      storedFields: FIELDS,
    });
    expect(later.confirmed).toBe(false);
  });
  it.each(['STALE', 'REMOVED', 'WRONG_VALUE'] as const)('%s is never confirmed here', (reason) => {
    expect(runCheck({ reason, key: 'd/r', served, versions, storedFields: FIELDS }).confirmed).toBe(
      false,
    );
  });
});

describe('parseServedKeys', () => {
  it('drops malformed entries', () => {
    expect(parseServedKeys([{ key: 'a', hash: 'b' }, { key: 1 }, null, 'x'])).toEqual([
      { key: 'a', hash: 'b' },
    ]);
    expect(parseServedKeys(null)).toEqual([]);
  });
});

describe('withinAbuseLimit', () => {
  it('credits up to exactly 10% of charges', () => {
    expect(withinAbuseLimit({ chargedMicros: 60_000, creditedMicros: 4_500 }, 1_500)).toBe(true);
    expect(withinAbuseLimit({ chargedMicros: 60_000, creditedMicros: 6_000 }, 1_500)).toBe(false);
    expect(withinAbuseLimit({ chargedMicros: 0, creditedMicros: 0 }, 1_500)).toBe(false);
  });
});
