import { allocate } from './allocate.js';
import { divRound, mulRate, parseRate, type Rate, type Rounding } from './rate.js';

export interface TaxComponent {
  code: string;
  /** Decimal string, e.g. "0.05". */
  rate: string;
  /** Compound components are charged on net + all earlier components' tax (e.g. historical QST). */
  compound?: boolean;
}
export interface TaxLineInput { id: string; amountMinor: bigint; taxable: boolean }
export interface TaxPolicy {
  components: TaxComponent[];
  /** 'exclusive': entered amounts exclude tax. 'inclusive': entered amounts already contain tax. */
  priceMode: 'exclusive' | 'inclusive';
  /** 'line': round each line then sum. 'order': compute on the taxable subtotal, then spread across lines. */
  roundingLevel: 'line' | 'order';
  rounding?: Rounding;
}
export interface TaxLineResult { id: string; netMinor: bigint; taxMinor: bigint; byComponent: Record<string, bigint> }
export interface TaxResult {
  lines: TaxLineResult[];
  netMinor: bigint;
  taxMinor: bigint;
  /** netMinor + taxMinor. For inclusive pricing this equals the sum of the entered amounts exactly. */
  grossMinor: bigint;
  byComponent: Record<string, bigint>;
}

interface Comp { code: string; r: Rate; compound: boolean }
interface Rat { n: bigint; d: bigint }
const rat = (n: bigint, d = 1n): Rat => ({ n, d });
const radd = (a: Rat, b: Rat): Rat => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
const rmul = (a: Rat, b: Rat): Rat => ({ n: a.n * b.n, d: a.d * b.d });

/** Tax per component on an exclusive net amount, each rounded to a whole minor unit. */
function exclusiveByComponent(net: bigint, comps: Comp[], mode: Rounding): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  let base = net;
  for (const c of comps) {
    const t = mulRate(c.compound ? base : net, c.r, mode);
    out[c.code] = t;
    base += t;
  }
  return out;
}

/** Exact per-component tax as a fraction of net, plus the combined factor (1 + Σ tax fractions). */
function fractions(comps: Comp[]) {
  let running = rat(1n);
  const parts: Rat[] = [];
  for (const c of comps) {
    const rr = rat(c.r.num, c.r.den);
    const t = c.compound ? rmul(running, rr) : rr;
    parts.push(t);
    running = radd(running, t);
  }
  return { factor: running, parts };
}

const zero = (comps: Comp[]) => Object.fromEntries(comps.map((c) => [c.code, 0n])) as Record<string, bigint>;
const total = (m: Record<string, bigint>) => Object.values(m).reduce((a, b) => a + b, 0n);

/**
 * Computes tax for a set of lines.
 * Invariants (property-tested): Σ line tax = order tax; Σ line net + tax = gross; for inclusive pricing, gross equals
 * the sum of entered amounts exactly (tax is the remainder after extracting net, never an independent rounding).
 */
export function computeTax(lines: TaxLineInput[], policy: TaxPolicy): TaxResult {
  const mode = policy.rounding ?? 'half_up';
  const comps: Comp[] = policy.components.map((c) => ({ code: c.code, r: parseRate(c.rate), compound: !!c.compound }));
  const { factor, parts } = fractions(comps);
  const inclusive = policy.priceMode === 'inclusive';

  // Per taxable line: (net, tax-by-component) in isolation.
  const solveAmount = (amount: bigint): { net: bigint; by: Record<string, bigint> } => {
    if (!inclusive) return { net: amount, by: exclusiveByComponent(amount, comps, mode) };
    const net = divRound(amount * factor.d, factor.n, mode); // amount / factor
    const tax = amount - net;
    const D = parts.reduce((acc, p) => acc * p.d, 1n);
    const weights = parts.map((p) => (p.n * D) / p.d);
    const split = comps.length ? allocate(tax, weights) : [];
    return { net, by: Object.fromEntries(comps.map((c, i) => [c.code, split[i]])) };
  };

  let results: TaxLineResult[];
  if (policy.roundingLevel === 'line' || !lines.some((l) => l.taxable)) {
    results = lines.map((l) => {
      if (!l.taxable) return { id: l.id, netMinor: l.amountMinor, taxMinor: 0n, byComponent: zero(comps) };
      const s = solveAmount(l.amountMinor);
      return { id: l.id, netMinor: s.net, taxMinor: total(s.by), byComponent: s.by };
    });
  } else {
    // Order level: solve once on the taxable subtotal, then spread net and tax across lines by amount.
    const taxableIdx = lines.map((l, i) => (l.taxable ? i : -1)).filter((i) => i >= 0);
    const subtotal = taxableIdx.reduce((a, i) => a + lines[i].amountMinor, 0n);
    const s = solveAmount(subtotal);
    const weights = taxableIdx.map((i) => (lines[i].amountMinor < 0n ? -lines[i].amountMinor : lines[i].amountMinor));
    const netSplit = allocate(s.net, weights);
    const compSplit = Object.fromEntries(comps.map((c) => [c.code, allocate(s.by[c.code], weights)]));
    results = lines.map((l) => ({ id: l.id, netMinor: l.amountMinor, taxMinor: 0n, byComponent: zero(comps) }));
    taxableIdx.forEach((li, k) => {
      const by = Object.fromEntries(comps.map((c) => [c.code, compSplit[c.code][k]])) as Record<string, bigint>;
      results[li] = { id: lines[li].id, netMinor: netSplit[k], taxMinor: total(by), byComponent: by };
    });
  }

  const byComponent = zero(comps);
  for (const r of results) for (const [k, v] of Object.entries(r.byComponent)) byComponent[k] += v;
  const taxMinor = results.reduce((a, r) => a + r.taxMinor, 0n);
  const netMinor = results.reduce((a, r) => a + r.netMinor, 0n);
  return { lines: results, netMinor, taxMinor, grossMinor: netMinor + taxMinor, byComponent };
}
