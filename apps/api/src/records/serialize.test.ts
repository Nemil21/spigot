import { describe, expect, test } from 'vitest';
import { ApiError } from '../http/errors.js';
import {
  decodeChangesCursor,
  decodeRecordsCursor,
  encodeChangesCursor,
  encodeRecordsCursor,
} from './cursor.js';
import { servedFields } from './fields.js';
import { serializeRecord, stripPatch, type RecordRow } from './serialize.js';

const fields = servedFields([
  { name: 'title', type: 'string', visible: true },
  { name: 'price_usd', type: 'integer', visible: true, filterable: ['lt'] },
  { name: 'amenities', type: 'string[]', visible: true },
  { name: 'agent_phone', type: 'string', visible: false },
]);

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiError) return `${e.status} ${e.code}`;
    throw e;
  }
  return 'no error';
}

describe('serializeRecord', () => {
  const row: RecordRow = {
    id: A,
    record_key: '2br-east-cesar-chavez-4471',
    data: {
      title: 'Nice',
      price_usd: 1850,
      amenities: ['pool'],
      agent_phone: '512-555-0100',
      extra: 'x',
    },
    version: 4,
    updated_at: new Date('2026-11-11T10:00:00Z'),
    crawled_at: new Date('2026-11-11T10:05:00Z'),
    source_lastmod: null,
    url: 'https://bluebonnet.example/listings/2br-east-cesar-chavez-4471',
  };

  test('allowlist: visible fields + url + updated_at; key prefixed with the dataset slug', () => {
    const out = serializeRecord({ datasetSlug: 'listings', fields, staleSince: null }, row);
    expect(out).toEqual({
      key: 'listings/2br-east-cesar-chavez-4471',
      data: {
        title: 'Nice',
        price_usd: 1850,
        amenities: ['pool'],
        url: 'https://bluebonnet.example/listings/2br-east-cesar-chavez-4471',
        updated_at: '2026-11-11T10:00:00.000Z',
      },
      version: 4,
      freshness: { crawledAt: '2026-11-11T10:05:00.000Z', sourceLastmod: null, staleSince: null },
    });
    expect(JSON.stringify(out)).not.toContain('512-555-0100');
  });

  test('missing visible fields are null; nested objects are never passed through', () => {
    const out = serializeRecord(
      { datasetSlug: 'l', fields, staleSince: new Date('2026-11-10T00:00:00Z') },
      { ...row, data: { title: { agent_phone: '512' } } },
    );
    expect(out.data).toMatchObject({ title: null, price_usd: null, amenities: null });
    expect(out.freshness.staleSince).toBe('2026-11-10T00:00:00.000Z');
  });
});

describe('stripPatch', () => {
  test.each([
    [
      'visible replace kept',
      [{ op: 'replace', path: '/price_usd', value: 1795 }],
      [{ op: 'replace', path: '/price_usd', value: 1795 }],
    ],
    ['hidden replace dropped', [{ op: 'replace', path: '/agent_phone', value: '1' }], []],
    ['hidden nested path dropped', [{ op: 'add', path: '/agent_phone/0', value: '1' }], []],
    [
      'escaped pointer to a hidden field dropped',
      [{ op: 'replace', path: '/agent~1phone', value: '1' }],
      [],
    ],
    ['unknown field dropped', [{ op: 'add', path: '/extra', value: 1 }], []],
    [
      'list element kept',
      [{ op: 'add', path: '/amenities/1', value: 'gym' }],
      [{ op: 'add', path: '/amenities/1', value: 'gym' }],
    ],
    ['move from hidden dropped', [{ op: 'move', from: '/agent_phone', path: '/title' }], []],
    [
      'malformed ops dropped',
      [null, { op: 'replace' }, { op: 'replace', path: 'price_usd', value: 1 }],
      [],
    ],
    [
      'root add stripped to visible fields',
      [{ op: 'add', path: '', value: { title: 'T', price_usd: 1, agent_phone: '512', extra: 1 } }],
      [{ op: 'add', path: '', value: { title: 'T', price_usd: 1, amenities: null } }],
    ],
    ['root remove kept', [{ op: 'remove', path: '' }], [{ op: 'remove', path: '' }]],
    [
      'mixed: hidden op dropped, visible kept',
      [
        { op: 'replace', path: '/agent_phone', value: '512' },
        { op: 'replace', path: '/title', value: 'New' },
      ],
      [{ op: 'replace', path: '/title', value: 'New' }],
    ],
  ])('%s', (_name, patch, expected) => {
    expect(stripPatch(fields, patch)).toEqual(expected);
  });

  test('not a list → no ops', () => {
    expect(stripPatch(fields, null)).toEqual([]);
    expect(stripPatch(fields, { op: 'add' })).toEqual([]);
  });
});

describe('records cursor', () => {
  const pos = {
    datasetId: A,
    updatedAt: '2026-11-11T10:00:00.123456Z',
    id: B,
    sort: 'desc' as const,
  };

  test('round-trips', () => {
    expect(decodeRecordsCursor(encodeRecordsCursor(pos), A, 'desc')).toEqual(pos);
  });

  test('another dataset, another sort or garbage → 400', () => {
    const c = encodeRecordsCursor(pos);
    expect(codeOf(() => decodeRecordsCursor(c, B, 'desc'))).toBe('400 VALIDATION_ERROR');
    expect(codeOf(() => decodeRecordsCursor(c, A, 'asc'))).toBe('400 VALIDATION_ERROR');
    for (const bad of [
      '',
      'x',
      'eyJ9',
      Buffer.from('{"d":"x"}').toString('base64url'),
      'a'.repeat(600),
      42,
    ]) {
      expect(codeOf(() => decodeRecordsCursor(bad, A, 'desc'))).toBe('400 VALIDATION_ERROR');
    }
    const injected = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(c, 'base64url').toString()),
        u: "x'; DROP TABLE records; --",
      }),
    ).toString('base64url');
    expect(codeOf(() => decodeRecordsCursor(injected, A, 'desc'))).toBe('400 VALIDATION_ERROR');
  });
});

describe('changes cursor', () => {
  test('round-trips and is opaque', () => {
    const c = encodeChangesCursor(A, 8812);
    expect(c).toMatch(/^c_[A-Za-z0-9_-]+$/);
    expect(c).not.toContain('8812');
    expect(decodeChangesCursor(c, A)).toBe(8812);
  });

  test('a cursor from dataset A on dataset B → 400', () => {
    expect(codeOf(() => decodeChangesCursor(encodeChangesCursor(A, 5), B))).toBe(
      '400 VALIDATION_ERROR',
    );
  });

  test.each([
    'c_8812',
    'c_',
    '8812',
    'c_!!',
    `c_${Buffer.from(`${A}:-1`).toString('base64url')}`,
    `c_${Buffer.from(`${A}:1;DROP`).toString('base64url')}`,
    null,
  ])('%j → 400', (c) =>
    expect(codeOf(() => decodeChangesCursor(c, A))).toBe('400 VALIDATION_ERROR'),
  );
});
