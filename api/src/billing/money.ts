/**
 * Money is NEVER a float here.
 *  - Amounts are integer cents.
 *  - Unit prices can be fractions of a cent (e.g. $0.0025 per API call), so they are held as
 *    integer "micro-dollars" (1e-6 USD) in a BigInt. 1 cent = 10,000 micros.
 *  - Rounding happens once per invoice line, half-up, so every line the customer sees is a whole
 *    number of cents and the invoice total is exactly the sum of its lines.
 */
export const MICROS_PER_CENT = 10_000n;

export class MoneyError extends Error {}

/** "0.0025" -> 2500n. Rejects negatives, more than 6 decimals, and anything that isn't a plain decimal. */
export function parseUnitPriceToMicros(price: string): bigint {
  const m = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(price.trim());
  if (!m) throw new MoneyError(`invalid unit price "${price}" (use a non-negative decimal with at most 6 places)`);
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0') || '0');
}

/** 2500n -> "0.0025". Trims trailing zeros but always keeps at least two decimals ("1.00"). */
export function formatMicros(micros: bigint): string {
  const whole = micros / 1_000_000n;
  let frac = (micros % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `${whole}.${frac}`;
}

/** Round micro-dollars to whole cents, half-up. */
export function microsToCentsHalfUp(micros: bigint): bigint {
  return (micros + MICROS_PER_CENT / 2n) / MICROS_PER_CENT;
}

/** Integer proration: round(cents * num / den), half-up, with no floating point. */
export function prorateHalfUp(cents: number, num: number, den: number): number {
  if (den <= 0 || num < 0) throw new MoneyError('invalid proration');
  return Number((BigInt(cents) * BigInt(num) * 2n + BigInt(den)) / (2n * BigInt(den)));
}

/** Basis points of an amount (tax), half-up. 825 bps = 8.25%. */
export function bpsOfHalfUp(cents: number, bps: number): number {
  return Number((BigInt(cents) * BigInt(bps) * 2n + 10_000n) / 20_000n);
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}
