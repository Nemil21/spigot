import { describe, expect, it } from 'vitest';
import { jsonPathAll, jsonPathFirst } from './jsonpath.js';

const doc = {
  '@id': 'https://bluebonnet.example.com/listings/a',
  '@type': ['Apartment', 'Offer'],
  numberOfRooms: 2,
  'floor-size': { value: 910 },
  offers: [{ price: null }, { price: 2150 }],
  address: { addressLocality: 'Austin' },
};

describe('jsonPathAll', () => {
  it.each([
    ['$.numberOfRooms', [2]],
    ["$['@id']", ['https://bluebonnet.example.com/listings/a']],
    ['$.@type', [['Apartment', 'Offer']]],
    ['$.@type[1]', ['Offer']],
    ["$['floor-size'].value", [910]],
    ['$.floor-size.value', [910]],
    ['$.address.addressLocality', ['Austin']],
    ['$.offers[1].price', [2150]],
    ['$.offers.price', [null, 2150]], // name on an array applies to each element
    ['$.offers[5].price', []],
    ['$.missing.deeper', []],
    ['$.numberOfRooms.value', []],
  ])('%s', (path, expected) => {
    expect(jsonPathAll(path, doc)).toEqual(expected);
  });

  it('never reads prototype members', () => {
    for (const p of ['$.constructor', '$.constructor.constructor', '$.__proto__', '$.toString', '$.offers.length', '$.hasOwnProperty']) {
      expect(jsonPathAll(p, doc)).toEqual([]);
    }
  });

  it('reads an own "__proto__" key from JSON as data', () => {
    expect(jsonPathAll('$.__proto__.x', JSON.parse('{"__proto__":{"x":1}}'))).toEqual([1]);
  });
});

describe('jsonPathFirst', () => {
  it('returns the first non-null match across roots', () => {
    expect(jsonPathFirst('$.offers.price', [doc])).toBe(2150);
    expect(jsonPathFirst('$.name', [{ name: null }, { a: 1 }, { name: 'second' }, { name: 'third' }])).toBe('second');
    expect(jsonPathFirst('$.name', [])).toBeNull();
  });
});
