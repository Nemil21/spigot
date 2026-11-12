import { describe, expect, it } from 'vitest';
import { classifyFailure, PayPalApiError, PayPalAuthError } from './errors.js';

describe('classifyFailure', () => {
  it.each([
    ['capture', { http: 0 }, 'TRANSIENT'],
    ['capture', { http: 0, timeout: true }, 'TRANSIENT'],
    ['order_create', { http: 500 }, 'TRANSIENT'],
    ['order_create', { http: 503 }, 'TRANSIENT'],
    ['get', { http: 429 }, 'TRANSIENT'],
    ['get', { http: 408 }, 'TRANSIENT'],
    // S7: mock decline on capture is 403 with an empty body → classify by status.
    ['capture', { http: 403 }, 'TERMINAL'],
    ['capture', { http: 403, issue: undefined }, 'TERMINAL'],
    ['capture', { http: 422, issue: 'INSTRUMENT_DECLINED' }, 'TERMINAL'],
    ['capture', { http: 422, issue: 'ORDER_ALREADY_CAPTURED' }, 'RECONCILE'],
    ['capture', { http: 422, issue: 'ORDER_NOT_APPROVED' }, 'RECONCILE'],
    ['capture', { http: 422 }, 'RECONCILE'],
    ['capture', { http: 404, issue: 'INVALID_RESOURCE_ID' }, 'TERMINAL'],
    // S7 step 3: raw-card replay is refused, which is RECONCILE, not a decline.
    ['order_create', { http: 422, issue: 'TRANSACTION_REFUSED', rawCard: true }, 'RECONCILE'],
    ['order_create', { http: 422, issue: 'TRANSACTION_REFUSED' }, 'TERMINAL'],
    ['order_create', { http: 422, issue: 'DUPLICATE_INVOICE_ID' }, 'RECONCILE'],
    ['order_create', { http: 422, issue: 'INSTRUMENT_DECLINED' }, 'TERMINAL'],
    ['order_create', { http: 400, issue: 'INVALID_PARAMETER_VALUE' }, 'TERMINAL'],
    ['token', { http: 401 }, 'TERMINAL'],
    ['get', { http: 404 }, 'TERMINAL'],
  ] as const)('%s %j → %s', (call, info, expected) => {
    expect(classifyFailure(call, info)).toBe(expected);
  });
});

describe('PayPalApiError', () => {
  it('carries call, http, class and code; auth errors are TERMINAL token errors', () => {
    const e = new PayPalApiError('get', 404, 'TERMINAL', 'INVALID_RESOURCE_ID', 'dbg');
    expect(e).toMatchObject({
      call: 'get',
      http: 404,
      errorClass: 'TERMINAL',
      code: 'INVALID_RESOURCE_ID',
      debugId: 'dbg',
    });
    expect(e.message).toBe('PayPal get failed: 404 INVALID_RESOURCE_ID');
    const auth = new PayPalAuthError(401, 'invalid_client');
    expect(auth).toBeInstanceOf(PayPalApiError);
    expect(auth).toMatchObject({ call: 'token', errorClass: 'TERMINAL', code: 'invalid_client' });
  });
});
