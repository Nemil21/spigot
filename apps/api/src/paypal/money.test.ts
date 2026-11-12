import { describe, expect, it } from 'vitest';
import { centsToDecimal, decimalToCents, paypalAmount } from './money.js';

describe('PayPal amounts', () => {
  it('converts cents ↔ decimal strings without floats', () => {
    expect(centsToDecimal(2005)).toBe('20.05');
    expect(centsToDecimal(5)).toBe('0.05');
    expect(centsToDecimal(-120)).toBe('-1.20');
    expect(decimalToCents('20.05')).toBe(2005);
    expect(decimalToCents('20.5')).toBe(2050);
    expect(decimalToCents('20')).toBe(2000);
    expect(decimalToCents('0.29')).toBe(29);
    expect(paypalAmount(1999)).toEqual({ currency_code: 'USD', value: '19.99' });
  });

  it('rejects non-integers and malformed amounts', () => {
    expect(() => centsToDecimal(1.5)).toThrow(RangeError);
    expect(() => decimalToCents('1.234')).toThrow(RangeError);
    expect(() => decimalToCents('abc')).toThrow(RangeError);
    expect(() => decimalToCents('1e3')).toThrow(RangeError);
  });
});
