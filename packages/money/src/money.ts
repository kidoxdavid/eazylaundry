/** Amounts are bigint minor units (cents). Currency travels with the value; mixing currencies is an error. */
export interface Money { minor: bigint; currency: string }

export const money = (minor: bigint | number, currency = 'CAD'): Money => {
  if (typeof minor === 'number' && !Number.isSafeInteger(minor)) throw new Error('money must be an integer number of minor units');
  return { minor: BigInt(minor), currency };
};
const same = (a: Money, b: Money) => {
  if (a.currency !== b.currency) throw new Error(`currency mismatch: ${a.currency} vs ${b.currency}`);
};
export const add = (a: Money, b: Money): Money => (same(a, b), { minor: a.minor + b.minor, currency: a.currency });
export const sub = (a: Money, b: Money): Money => (same(a, b), { minor: a.minor - b.minor, currency: a.currency });
export const neg = (a: Money): Money => ({ minor: -a.minor, currency: a.currency });
export const sum = (xs: Money[], currency = 'CAD'): Money => xs.reduce(add, money(0n, currency));

/** Parse "12.34" / "-0.5" into minor units (2dp). Rejects >2 decimals rather than silently rounding. */
export function parseMoney(s: string, currency = 'CAD'): Money {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s.trim());
  if (!m) throw new Error(`invalid amount: ${s}`);
  const v = BigInt(m[2]) * 100n + BigInt((m[3] ?? '').padEnd(2, '0') || '0');
  return { minor: m[1] ? -v : v, currency };
}

export function formatMoney(a: Money, locale = 'en-CA'): string {
  const abs = a.minor < 0n ? -a.minor : a.minor;
  const whole = new Intl.NumberFormat(locale).format(abs / 100n);
  const cents = (abs % 100n).toString().padStart(2, '0');
  return `${a.minor < 0n ? '-' : ''}$${whole}${locale.startsWith('fr') ? ',' : '.'}${cents}`;
}
