/** Exact decimal rate as a rational (num/den). Rates are parsed from strings — never floats. */
export interface Rate { num: bigint; den: bigint }

export function parseRate(s: string): Rate {
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(s.trim());
  if (!m) throw new Error(`invalid rate: ${s}`);
  const frac = m[2] ?? '';
  return { num: BigInt(m[1] + frac), den: 10n ** BigInt(frac.length) };
}

export type Rounding = 'half_up' | 'half_even' | 'down' | 'up';

/** Integer division a/b (b>0) rounded per mode; negatives round symmetrically (away-from-zero for half_up). */
export function divRound(a: bigint, b: bigint, mode: Rounding): bigint {
  if (b <= 0n) throw new Error('divisor must be positive');
  const neg = a < 0n;
  const x = neg ? -a : a;
  const q = x / b;
  const r = x % b;
  const twice = r * 2n;
  let out = q;
  if (mode === 'up') out = r > 0n ? q + 1n : q;
  else if (mode === 'half_up') out = twice >= b ? q + 1n : q;
  else if (mode === 'half_even') out = twice > b || (twice === b && q % 2n === 1n) ? q + 1n : q;
  return neg ? -out : out;
}

/** amount × rate, rounded. */
export const mulRate = (amountMinor: bigint, rate: Rate, mode: Rounding = 'half_up') =>
  divRound(amountMinor * rate.num, rate.den, mode);
