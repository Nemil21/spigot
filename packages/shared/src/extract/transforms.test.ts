import { describe, expect, it } from 'vitest';
import type { Value } from './coerce.js';
import { parseTransform, type ParsedTransform } from './spec.js';
import { compileTransform } from './transforms.js';

const ctx = { pageUrl: 'https://bluebonnet.example.com/listings/2br-east-cesar-chavez-4471' };

function run(t: string, v: Value): Value {
  const parsed = parseTransform(t);
  if (typeof parsed === 'string') throw new Error(parsed);
  return compileTransform(parsed as ParsedTransform)(v, ctx);
}

const table: Array<[transform: string, input: Value, expected: Value]> = [
  ['trim', '  2 bedrooms \n', '2 bedrooms'],
  ['trim', 2, 2],
  ['trim', null, null],
  ['lower', 'Cats OK', 'cats ok'],
  ['lower', true, true],
  ['toInt', '2', 2],
  ['toInt', ' 2.9 ', 2],
  ['toInt', 3.7, 3],
  ['toInt', '-4', -4],
  ['toInt', '1,875', null],
  ['toInt', 'two', null],
  ['toInt', '', null],
  ['toInt', true, null],
  ['toFloat', '2.5', 2.5],
  ['toFloat', 940, 940],
  ['toFloat', '1e3', 1000],
  ['toFloat', '0x10', null],
  ['toFloat', '12 sq ft', null],
  ['firstInt', '910 sq ft', 910],
  ['firstInt', 'Unit 3, floor 12', 3],
  ['firstInt', '$1,875 / month', 1875],
  ['firstInt', '37 active listings', 37],
  ['firstInt', 'no digits', null],
  ['firstInt', 4.9, 4],
  ['money', '$2,150', 2150],
  ['money', '$2,150 / month', 2150],
  ['money', ' $1,234.56 ', 1234.56],
  ['money', 1875, 1875],
  ['money', 'Call for price', null],
  ['date', '2026-12-15', '2026-12-15'],
  ['date', '\n 2026-12-15 \n', '2026-12-15'],
  ['date', '2026-12-06T13:00-06:00', '2026-12-06'],
  ['date', '12/15/2026', '2026-12-15'],
  ['date', '2026/12/5', '2026-12-05'],
  ['date', 'March 4, 2015', '2015-03-04'],
  ['date', 'Dec 1st, 2026', '2026-12-01'],
  ['date', 'Tuesday, December 1, 2026', '2026-12-01'],
  ['date', '1 Dec 2026', '2026-12-01'],
  ['date', '2026-02-30', null],
  ['date', 'Smarch 4, 2015', null],
  ['date', 'soon', null],
  ['datetime', '2026-12-06T13:00-06:00', '2026-12-06T19:00:00.000Z'],
  ['datetime', '2026-12-06T13:00:30.5+0530', '2026-12-06T07:30:30.500Z'],
  ['datetime', '2026-12-06T19:00:00Z', '2026-12-06T19:00:00.000Z'],
  ['datetime', '2026-12-06 19:00', '2026-12-06T19:00:00.000Z'],
  ['datetime', '2026-12-06', '2026-12-06T00:00:00.000Z'],
  ['datetime', '2026-12-06T25:00Z', null],
  ['datetime', 'Sat, Dec 6, 1–3 pm', null],
  ['absoluteUrl', '/agents/maya-okafor', 'https://bluebonnet.example.com/agents/maya-okafor'],
  ['absoluteUrl', 'img/1.jpg', 'https://bluebonnet.example.com/listings/img/1.jpg'],
  ['absoluteUrl', 'https://cdn.example.com/a.jpg', 'https://cdn.example.com/a.jpg'],
  ['absoluteUrl', 'javascript:alert(1)', null],
  ['absoluteUrl', 'mailto:maya@example.com', null],
  ['split:,', 'English, Yoruba, Spanish', ['English', 'Yoruba', 'Spanish']],
  ['split:,', 'English,,', ['English']],
  ['split: / ', 'a / b', ['a', 'b']],
  ['split:,', 5, 5],
  ['bool:ok', 'Cats and dogs OK', true],
  ['bool:ok', 'No pets', false],
  ['bool:ok', 'Booking required', false], // whole words only
  ['bool:dogs ok', 'Cats and dogs OK!', true],
  ['bool:yes', true, true],
  ['bool:yes', null, null],
  ['regex:(\\d+)\\s*sq', '910 sq ft', '910'],
  ['regex:\\d+', 'Unit 12', '12'], // no group → whole match
  ['regex:(?:Unit )(\\w+)', 'Unit 3B', '3B'],
  ['regex:(\\d+)', 'none', null],
  ['regex:(\\d+)', 2150, '2150'],
];

describe('transforms', () => {
  it.each(table)('%s(%j) → %j', (t, input, expected) => {
    expect(run(t, input)).toEqual(expected);
  });

  it('maps arrays element-wise and flattens split', () => {
    expect(run('trim', [' a ', ' b '])).toEqual(['a', 'b']);
    expect(run('split:,', ['a,b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(run('toInt', ['1', 'x', '3'])).toEqual([1, null, 3]);
  });

  it('chains in order', () => {
    const chain = ['trim', 'lower', 'bool:ok'].map((t) =>
      compileTransform(parseTransform(t) as ParsedTransform),
    );
    expect(chain.reduce<Value>((v, f) => f(v, ctx), '  Cats OK ')).toBe(true);
  });

  it('a regex the engine refuses yields null instead of throwing', () => {
    const f = compileTransform(
      { op: 'regex', pattern: '(\\d+)' },
      {
        compile() {
          throw new Error('nope');
        },
      },
    );
    expect(f('12', ctx)).toBeNull();
  });
});
