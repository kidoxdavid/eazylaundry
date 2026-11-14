import { z } from 'zod';

export const PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'] as const;

/** Canadian postal code: letters D, F, I, O, Q, U never appear; W and Z not in first position. Normalised to "A1A 1A1". */
export const postalCode = z.string().trim().toUpperCase()
  .regex(/^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z] ?\d[ABCEGHJ-NPRSTV-Z]\d$/, 'Invalid Canadian postal code')
  .transform((s) => `${s.replace(/\s/g, '').slice(0, 3)} ${s.replace(/\s/g, '').slice(3)}`);

/** Normalises a phone number to E.164. North American numbers (10 digits, or 11 starting with 1) become +1XXXXXXXXXX. */
export function normalizePhone(input: string): string | null {
  const t = input.trim();
  const digits = t.replace(/\D/g, '');
  if (t.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}
export const phone = z.string().trim().transform((s, ctx) => {
  const p = normalizePhone(s);
  if (!p) { ctx.addIssue({ code: 'custom', message: 'Enter a valid phone number' }); return z.NEVER; }
  return p;
});
