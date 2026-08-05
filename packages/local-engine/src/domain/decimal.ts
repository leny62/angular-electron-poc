/**
 * Fixed-point decimal arithmetic.
 *
 * Money and quantities are stored as TEXT and computed here as scaled BigInt.
 * Not a stylistic preference: JavaScript numbers are IEEE-754 doubles, so
 * `0.1 + 0.2 === 0.30000000000000004`, and a shop reconciling a day of sales
 * against cash in a drawer finds the drift. The backend uses
 * `BigDecimal(precision 19, scale 4)` for the same reason.
 *
 * Scale is 6, not 4. The backend stores 4, but intermediate results need more:
 * a tax-inclusive unit price divided by 1.18 to extract net has a non-terminating
 * expansion, and rounding to 4 at every intermediate step compounds. We compute
 * at 6 and round to 4 only when producing a stored value.
 *
 * Deliberately not a dependency. decimal.js is ~30 KB and this needs eight
 * operations, all of which are two lines over BigInt.
 */

const SCALE = 6;
const SCALE_FACTOR = 10n ** BigInt(SCALE);

/** Scale used for values written to the database, matching the backend. */
export const STORAGE_SCALE = 4;

export type Decimal = bigint;

// ---------------------------------------------------------------------------
// Parsing and formatting
// ---------------------------------------------------------------------------

/**
 * Parse a decimal string into scaled BigInt.
 *
 * Accepts an optional sign, digits, and up to `SCALE` fraction digits. Rejects
 * exponent notation and anything else: a value arriving as "1e3" means something
 * upstream turned a decimal into a float, and silently accepting it would hide
 * the bug that matters.
 */
export function parse(value: string | number | null | undefined): Decimal {
  if (value === null || value === undefined || value === '') return 0n;

  // A number here is already suspect, but reject only if it actually lost
  // precision: integers within the safe range are fine, and rejecting them would
  // make the API needlessly awkward.
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Not a finite number: ${value}`);
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `Refusing to parse non-integer number ${value} as a decimal: pass a string ` +
          'so no precision has already been lost.',
      );
    }
    return BigInt(value) * SCALE_FACTOR;
  }

  const text = value.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error(`Not a valid decimal: "${value}"`);

  const [, sign, whole, fraction = ''] = match;

  // Truncate rather than round: a caller supplying more precision than we track
  // is a caller whose input we should not silently alter upward.
  const padded = (fraction as string).slice(0, SCALE).padEnd(SCALE, '0');
  const scaled = BigInt(whole as string) * SCALE_FACTOR + BigInt(padded || '0');

  return sign === '-' ? -scaled : scaled;
}

/** Format for storage: fixed `STORAGE_SCALE` decimal places, half-up rounding. */
export function format(value: Decimal, scale: number = STORAGE_SCALE): string {
  const rounded = roundTo(value, scale);
  const negative = rounded < 0n;
  const abs = negative ? -rounded : rounded;

  const whole = abs / SCALE_FACTOR;
  const fraction = (abs % SCALE_FACTOR).toString().padStart(SCALE, '0').slice(0, scale);

  const body = scale > 0 ? `${whole}.${fraction}` : `${whole}`;
  return negative && rounded !== 0n ? `-${body}` : body;
}

/**
 * Round to `scale` decimal places, half away from zero.
 *
 * Half-up on the absolute value, so -0.5 rounds to -1 rather than to 0. Matches
 * Java's `RoundingMode.HALF_UP`, which is what the backend uses, so a total
 * computed locally and a total computed server-side agree to the last unit.
 */
export function roundTo(value: Decimal, scale: number): Decimal {
  if (scale >= SCALE) return value;

  const divisor = 10n ** BigInt(SCALE - scale);
  const negative = value < 0n;
  const abs = negative ? -value : value;

  const quotient = abs / divisor;
  const remainder = abs % divisor;

  // remainder * 2 >= divisor is "the dropped part is at least a half", without
  // any division that could itself lose precision.
  const bumped = remainder * 2n >= divisor ? quotient + 1n : quotient;
  const result = bumped * divisor;

  return negative ? -result : result;
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

export const add = (a: Decimal, b: Decimal): Decimal => a + b;
export const sub = (a: Decimal, b: Decimal): Decimal => a - b;

/** Multiply. Rescales, because two scaled values multiplied are double-scaled. */
export const mul = (a: Decimal, b: Decimal): Decimal => (a * b) / SCALE_FACTOR;

/** Divide. Pre-scales the numerator to keep `SCALE` digits of quotient. */
export function div(a: Decimal, b: Decimal): Decimal {
  if (b === 0n) throw new Error('Division by zero');
  return (a * SCALE_FACTOR) / b;
}

export const isZero = (a: Decimal): boolean => a === 0n;
export const isNegative = (a: Decimal): boolean => a < 0n;
export const gt = (a: Decimal, b: Decimal): boolean => a > b;
export const gte = (a: Decimal, b: Decimal): boolean => a >= b;
export const lt = (a: Decimal, b: Decimal): boolean => a < b;
export const max = (a: Decimal, b: Decimal): Decimal => (a > b ? a : b);

export const ZERO: Decimal = 0n;
export const ONE: Decimal = SCALE_FACTOR;
export const HUNDRED: Decimal = 100n * SCALE_FACTOR;

/** Percentage of a value: `percentOf(1000, 18)` is 180. */
export const percentOf = (value: Decimal, percent: Decimal): Decimal =>
  div(mul(value, percent), HUNDRED);

/** Sum, with an explicit empty case so `sum([])` is 0 rather than undefined. */
export const sum = (values: readonly Decimal[]): Decimal =>
  values.reduce<Decimal>((acc, v) => acc + v, 0n);

/**
 * Extract the net amount from a tax-inclusive gross.
 *
 *   net = gross / (1 + rate/100)
 *
 * The contract states `SaleLine.unitPrice` is tax-inclusive and `lineSubtotal` is
 * "net of tax, after discount", so this is the conversion between them. Doing it
 * at scale 6 and rounding once at the end is what keeps a 100-line sale's tax
 * total consistent with the sum of its lines.
 */
export function netFromGross(gross: Decimal, ratePercent: Decimal): Decimal {
  if (ratePercent === 0n) return gross;
  return div(mul(gross, HUNDRED), add(HUNDRED, ratePercent));
}
