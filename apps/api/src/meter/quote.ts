/**
 * Call pricing (features/06, 07): `price = n × unit`, in integer micros. A call that returns no
 * records (or no changes) costs 0 and is recorded `NOT_CHARGED`.
 */
export function priceMicros(count: number, unitPriceMicros: number): number {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError(`count must be a non-negative integer, got ${count}`);
  }
  if (!Number.isSafeInteger(unitPriceMicros) || unitPriceMicros < 0) {
    throw new RangeError(`unitPriceMicros must be a non-negative integer, got ${unitPriceMicros}`);
  }
  const price = count * unitPriceMicros;
  if (!Number.isSafeInteger(price))
    throw new RangeError(`price ${count} × ${unitPriceMicros} overflows`);
  return price;
}
