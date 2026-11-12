import { describe, expect, it } from 'vitest';
import { coerce, type FieldValue, type Value } from './coerce.js';
import type { FieldType } from './spec.js';

const table: Array<[type: FieldType, input: Value, expected: FieldValue]> = [
  ['string', 'Austin', 'Austin'],
  ['string', 2150, '2150'],
  ['string', true, 'true'],
  ['string', '   ', null],
  ['string', ['first', 'second'], 'first'],
  ['string', [], null],
  ['string', null, null],
  ['integer', 2, 2],
  ['integer', '2', 2],
  ['integer', '2.0', 2],
  ['integer', 2.5, null],
  ['integer', '2 beds', null],
  ['integer', Number.MAX_SAFE_INTEGER + 2, null],
  ['integer', true, null],
  ['number', 2.5, 2.5],
  ['number', '2.5', 2.5],
  ['number', '-0.25', -0.25],
  ['number', 'NaN', null],
  ['number', '1,875', null],
  ['boolean', true, true],
  ['boolean', 'Yes', true],
  ['boolean', 'false', false],
  ['boolean', 1, true],
  ['boolean', 0, false],
  ['boolean', 2, null],
  ['boolean', 'maybe', null],
  ['date', '2026-12-15', '2026-12-15'],
  ['date', 'Dec 15, 2026', '2026-12-15'],
  ['date', '2026-13-01', null],
  ['date', 20261215, null],
  ['datetime', '2026-12-06T13:00-06:00', '2026-12-06T19:00:00.000Z'],
  ['datetime', 'tomorrow', null],
  ['url', 'https://bluebonnet.example.com/a', 'https://bluebonnet.example.com/a'],
  ['url', 'HTTP://Bluebonnet.Example.com', 'http://bluebonnet.example.com/'],
  ['url', '/relative', null],
  ['url', 'ftp://example.com/x', null],
  ['string[]', ['a', 'b'], ['a', 'b']],
  ['string[]', 'a', ['a']],
  ['string[]', [1, null, 'x', ['y']], ['1', 'x', 'y']],
  ['string[]', [], null],
  ['string[]', null, null],
];

describe('coerce', () => {
  it.each(table)('%s ← %j → %j', (type, input, expected) => {
    expect(coerce(input, type)).toEqual(expected);
  });
});
