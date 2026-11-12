import { ApiError } from '../http/errors.js';

/**
 * A post would take a `BUYER_BALANCE` below zero (the `ledger_accounts_buyer_balance_nonnegative`
 * check). `post()` has already rolled back to its savepoint when this is thrown, so the caller's
 * transaction is still usable (SP-016 writes its `PAYMENT_REQUIRED` row and commits). It is an
 * `ApiError`, so if it reaches the error handler it becomes `402 INSUFFICIENT_BALANCE`.
 */
export class InsufficientBalance extends ApiError {
  constructor(readonly idempotencyKey: string) {
    super('INSUFFICIENT_BALANCE', 'Your balance is too low for this call. Top up to continue.');
    this.name = 'InsufficientBalance';
  }
}
