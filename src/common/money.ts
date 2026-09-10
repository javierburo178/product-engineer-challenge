/**
 * Money helpers. Amounts are added up as integer cents and only converted back
 * to a decimal at the end, so a sum of prices never accumulates binary-float
 * error (`0.1 + 0.2 !== 0.3`).
 *
 * `price` columns come off TypeORM as strings (`"49.99"`), hence `string | number`.
 */
export function toCents(amount: string | number): number {
  return Math.round(Number(amount) * 100);
}

export function fromCents(cents: number): number {
  return Number((cents / 100).toFixed(2));
}
