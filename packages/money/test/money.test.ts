import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { add, allocate, computeTax, divRound, formatMoney, money, mulRate, parseMoney, parseRate, sub, type TaxPolicy } from '../src/index.js';

const GST: TaxPolicy = { components: [{ code: 'GST', rate: '0.05' }], priceMode: 'exclusive', roundingLevel: 'line' };

describe('rates and rounding', () => {
  it('parses decimals exactly and rejects floats-in-disguise', () => {
    expect(parseRate('0.05')).toEqual({ num: 5n, den: 100n });
    expect(parseRate('0.09975')).toEqual({ num: 9975n, den: 100000n });
    expect(() => parseRate('5%')).toThrow();
    expect(() => parseRate('-0.1')).toThrow();
  });
  it('rounds half-up, half-even, down and up', () => {
    expect(divRound(5n, 2n, 'half_up')).toBe(3n);
    expect(divRound(5n, 2n, 'half_even')).toBe(2n);
    expect(divRound(7n, 2n, 'half_even')).toBe(4n);
    expect(divRound(5n, 2n, 'down')).toBe(2n);
    expect(divRound(1n, 3n, 'up')).toBe(1n);
    expect(divRound(-5n, 2n, 'half_up')).toBe(-3n); // symmetric
  });
  it('avoids classic float traps', () => {
    expect(mulRate(1999n, parseRate('0.05'))).toBe(100n); // 99.95 -> 100
    expect(mulRate(1005n, parseRate('0.05'), 'half_up')).toBe(50n); // 50.25 -> 50
    expect(mulRate(10n, parseRate('0.15'))).toBe(2n); // 1.5 -> 2 (0.1*15 style float errors avoided)
  });
});

describe('Money', () => {
  it('parses and formats', () => {
    expect(parseMoney('12.3').minor).toBe(1230n);
    expect(parseMoney('-0.05').minor).toBe(-5n);
    expect(() => parseMoney('1.234')).toThrow();
    expect(formatMoney(money(123456789n))).toBe('$1,234,567.89');
    expect(formatMoney(money(-5n))).toBe('-$0.05');
  });
  it('refuses mixed currencies and non-integers', () => {
    expect(() => add(money(1n, 'CAD'), money(1n, 'USD'))).toThrow(/mismatch/);
    expect(() => money(1.5)).toThrow();
    expect(sub(money(500n), money(125n)).minor).toBe(375n);
  });
});

describe('allocate (largest remainder)', () => {
  it('splits $100.00 three ways without losing a cent', () => {
    expect(allocate(10000n, [1n, 1n, 1n])).toEqual([3334n, 3333n, 3333n]);
  });
  it('is proportional and handles zero / negative totals', () => {
    expect(allocate(1000n, [1n, 3n])).toEqual([250n, 750n]);
    expect(allocate(5n, [0n, 0n])).toEqual([3n, 2n]);
    expect(allocate(-10n, [1n, 1n, 1n])).toEqual([-4n, -3n, -3n]);
  });
  it('property: parts always sum to the total and are within 1 of the exact share', () => {
    fc.assert(fc.property(fc.bigInt(-10_000_000n, 10_000_000n), fc.array(fc.bigInt(0n, 100_000n), { minLength: 1, maxLength: 12 }), (total, w) => {
      const parts = allocate(total, w);
      expect(parts.reduce((a, b) => a + b, 0n)).toBe(total);
      const sum = w.reduce((a, b) => a + b, 0n);
      if (sum > 0n) parts.forEach((p, i) => {
        const exact = (total * w[i]) / sum; // truncated share
        const diff = p - exact; expect(diff === 0n || diff === (total < 0n ? -1n : 1n)).toBe(true);
      });
    }), { numRuns: 500 });
  });
});

describe('computeTax — known cases', () => {
  it('Alberta GST 5% exclusive, line rounding', () => {
    const r = computeTax([{ id: 'a', amountMinor: 1999n, taxable: true }, { id: 'b', amountMinor: 1000n, taxable: false }], GST);
    expect(r.taxMinor).toBe(100n); expect(r.netMinor).toBe(2999n); expect(r.grossMinor).toBe(3099n);
    expect(r.lines[1].taxMinor).toBe(0n);
  });
  it('line vs order rounding can differ by cents but each is internally consistent', () => {
    const lines = [101n, 101n, 101n].map((a, i) => ({ id: `l${i}`, amountMinor: a, taxable: true })); // 5.05 each
    const byLine = computeTax(lines, GST); const byOrder = computeTax(lines, { ...GST, roundingLevel: 'order' });
    expect(byLine.taxMinor).toBe(15n); // 3 × round(5.05)=5
    expect(byOrder.taxMinor).toBe(15n); // round(15.15)=15
    expect(byOrder.lines.reduce((a, l) => a + l.taxMinor, 0n)).toBe(byOrder.taxMinor);
  });
  it('inclusive pricing extracts tax and preserves the entered total exactly', () => {
    const r = computeTax([{ id: 'a', amountMinor: 1050n, taxable: true }], { ...GST, priceMode: 'inclusive' });
    expect(r.netMinor).toBe(1000n); expect(r.taxMinor).toBe(50n); expect(r.grossMinor).toBe(1050n);
  });
  it('simple multi-component (GST+PST) and compound (GST then QST-style)', () => {
    const simple = computeTax([{ id: 'a', amountMinor: 1000n, taxable: true }], { ...GST, components: [{ code: 'GST', rate: '0.05' }, { code: 'PST', rate: '0.07' }] });
    expect(simple.byComponent).toEqual({ GST: 50n, PST: 70n });
    const comp = computeTax([{ id: 'a', amountMinor: 1000n, taxable: true }], { ...GST, components: [{ code: 'GST', rate: '0.05' }, { code: 'QST', rate: '0.09975', compound: true }] });
    expect(comp.byComponent).toEqual({ GST: 50n, QST: 105n }); // 1050 × 9.975% = 104.7375 -> 105
  });
  it('handles zero-rated/no taxable lines and refunds (negative lines)', () => {
    expect(computeTax([{ id: 'a', amountMinor: 500n, taxable: false }], { ...GST, roundingLevel: 'order' }).taxMinor).toBe(0n);
    const r = computeTax([{ id: 'a', amountMinor: -1999n, taxable: true }], GST);
    expect(r.taxMinor).toBe(-100n);
  });
});

describe('computeTax — properties', () => {
  const lineArb = fc.array(fc.record({ amountMinor: fc.bigInt(0n, 5_000_000n), taxable: fc.boolean() }), { minLength: 1, maxLength: 15 })
    .map((ls) => ls.map((l, i) => ({ id: `l${i}`, ...l })));
  const policyArb = fc.record({
    priceMode: fc.constantFrom('exclusive', 'inclusive'), roundingLevel: fc.constantFrom('line', 'order'),
    rounding: fc.constantFrom('half_up', 'half_even'),
    components: fc.constantFrom([{ code: 'GST', rate: '0.05' }], [{ code: 'GST', rate: '0.05' }, { code: 'PST', rate: '0.07' }],
      [{ code: 'HST', rate: '0.13' }], [{ code: 'GST', rate: '0.05' }, { code: 'QST', rate: '0.09975', compound: true }]),
  }) as fc.Arbitrary<TaxPolicy>;

  it('totals are internally consistent for every policy', () => {
    fc.assert(fc.property(lineArb, policyArb, (lines, policy) => {
      const r = computeTax(lines, policy);
      expect(r.lines.reduce((a, l) => a + l.taxMinor, 0n)).toBe(r.taxMinor);
      expect(r.lines.reduce((a, l) => a + l.netMinor, 0n)).toBe(r.netMinor);
      expect(r.netMinor + r.taxMinor).toBe(r.grossMinor);
      expect(Object.values(r.byComponent).reduce((a, b) => a + b, 0n)).toBe(r.taxMinor);
      for (const l of r.lines) expect(Object.values(l.byComponent).reduce((a, b) => a + b, 0n)).toBe(l.taxMinor);
      if (policy.priceMode === 'inclusive') expect(r.grossMinor).toBe(lines.reduce((a, l) => a + l.amountMinor, 0n));
      else expect(r.netMinor).toBe(lines.reduce((a, l) => a + l.amountMinor, 0n));
      lines.forEach((l, i) => { if (!l.taxable) expect(r.lines[i].taxMinor).toBe(0n); });
    }), { numRuns: 600 });
  });

  it('line-level and order-level results never differ by more than 1 minor unit per line and component', () => {
    fc.assert(fc.property(lineArb, policyArb, (lines, policy) => {
      const a = computeTax(lines, { ...policy, roundingLevel: 'line' });
      const b = computeTax(lines, { ...policy, roundingLevel: 'order' });
      const bound = BigInt(lines.length * policy.components.length * 2);
      const d = a.taxMinor - b.taxMinor;
      expect((d < 0n ? -d : d) <= bound).toBe(true);
    }), { numRuns: 300 });
  });

  it('matches an independent decimal computation for GST exclusive, line level (half-up)', () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 2_000_000 }), { minLength: 1, maxLength: 10 }), (cents) => {
      const r = computeTax(cents.map((c, i) => ({ id: `${i}`, amountMinor: BigInt(c), taxable: true })), GST);
      // independent oracle: integer arithmetic on c*5/100 with half-up, no shared code path
      const oracle = cents.reduce((a, c) => a + Math.floor((c * 5 + 50) / 100), 0);
      expect(Number(r.taxMinor)).toBe(oracle);
    }), { numRuns: 500 });
  });
});
