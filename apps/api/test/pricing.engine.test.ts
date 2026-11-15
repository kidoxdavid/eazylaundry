import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { TaxPolicy } from '@eazy/money';
import { PricingError, percentToRate, priceQuote, type PricedService } from '../src/pricing/engine.js';

const GST: TaxPolicy = { components: [{ code: 'GST', rate: '0.05' }], priceMode: 'exclusive', roundingLevel: 'line' };
type Over = Partial<Omit<PricedService, 'price'>> & { price?: Partial<PricedService['price']> };
const svc = (over: Over = {}): PricedService => ({
  id: 's1', code: 'WF', name: 'Wash & Fold', pricingModel: 'per_kg', taxCategory: 'taxable', expressCapable: true,
  ...over,
  price: { id: 'p1', unitPriceMinor: 250n, minChargeMinor: 0n, expressType: 'percent', expressPercent: '50', expressFixedMinor: null, ...over.price },
});
const map = (...s: PricedService[]) => new Map(s.map((x) => [x.id, x]));

describe('pricing engine', () => {
  it('prices per kg from grams with half-up rounding and adds tax', () => {
    const q = priceQuote({ lines: [{ serviceId: 's1', weightG: 3250 }], express: false, taxPolicy: GST }, map(svc()));
    expect(q.lines[0].baseMinor).toBe(813n); // 3.25 kg × $2.50 = 8.125 -> 8.13
    expect(q.taxMinor).toBe(41n); // 8.13 × 5% = 0.4065 -> 0.41
    expect(q.totalMinor).toBe(854n);
  });
  it('applies the minimum charge', () => {
    const q = priceQuote({ lines: [{ serviceId: 's1', weightG: 1000 }], express: false, taxPolicy: GST }, map(svc({ price: { minChargeMinor: 1500n } })));
    expect(q.lines[0].baseMinor).toBe(1500n); expect(q.lines[0].minChargeApplied).toBe(true);
  });
  it('per item and fixed pricing multiply by quantity', () => {
    const shirt = svc({ id: 'sh', pricingModel: 'per_item', price: { unitPriceMinor: 399n } });
    const q = priceQuote({ lines: [{ serviceId: 'sh', quantity: 3 }], express: false, taxPolicy: GST }, map(shirt));
    expect(q.lines[0].baseMinor).toBe(1197n);
  });
  it('express surcharge: percent of base, fixed per line, and rejected when not offered', () => {
    const pct = priceQuote({ lines: [{ serviceId: 's1', weightG: 2000 }], express: true, taxPolicy: GST }, map(svc()));
    expect(pct.lines[0].expressMinor).toBe(250n); // 50% of 500
    const fixed = priceQuote({ lines: [{ serviceId: 's1', weightG: 2000 }], express: true, taxPolicy: GST }, map(svc({ price: { expressType: 'fixed', expressPercent: null, expressFixedMinor: 700n } })));
    expect(fixed.lines[0].expressMinor).toBe(700n);
    expect(() => priceQuote({ lines: [{ serviceId: 's1', weightG: 2000 }], express: true, taxPolicy: GST }, map(svc({ expressCapable: false })))).toThrowError(/express/i);
  });
  it('express applies only to lines that offer it; the rest are priced normally', () => {
    const shirt = svc({ id: 'sh', pricingModel: 'per_item', expressCapable: false, price: { unitPriceMinor: 399n, expressType: 'none', expressPercent: null } });
    const q = priceQuote({ lines: [{ serviceId: 's1', weightG: 2000 }, { serviceId: 'sh', quantity: 2 }], express: true, taxPolicy: GST }, map(svc(), shirt));
    expect(q.lines[0].expressMinor).toBe(250n); expect(q.lines[1].expressMinor).toBe(0n);
    expect(q.lines[1].baseMinor).toBe(798n);
  });
  it('spreads a discount across lines exactly and taxes the discounted amounts', () => {
    const a = svc({ id: 'a', pricingModel: 'fixed', price: { unitPriceMinor: 1000n } });
    const b = svc({ id: 'b', pricingModel: 'fixed', price: { unitPriceMinor: 2000n } });
    const q = priceQuote({ lines: [{ serviceId: 'a' }, { serviceId: 'b' }], express: false, taxPolicy: GST, discount: { type: 'percent', percent: '10' } }, map(a, b));
    expect(q.discountMinor).toBe(300n);
    expect(q.lines.map((l) => l.discountMinor)).toEqual([100n, 200n]);
    expect(q.netMinor).toBe(2700n); expect(q.taxMinor).toBe(135n); expect(q.totalMinor).toBe(2835n);
  });
  it('rejects discounts above the subtotal, missing weights and unknown services', () => {
    const f = svc({ id: 'f', pricingModel: 'fixed', price: { unitPriceMinor: 1000n } });
    expect(() => priceQuote({ lines: [{ serviceId: 'f' }], express: false, taxPolicy: GST, discount: { type: 'fixed', amountMinor: 1001n } }, map(f))).toThrow(PricingError);
    expect(() => priceQuote({ lines: [{ serviceId: 's1' }], express: false, taxPolicy: GST }, map(svc()))).toThrowError(/weight/i);
    expect(() => priceQuote({ lines: [{ serviceId: 'nope', quantity: 1 }], express: false, taxPolicy: GST }, map(svc()))).toThrow(PricingError);
  });
  it('zero-rated and exempt services carry no tax; inclusive mode preserves the entered total', () => {
    const z = svc({ id: 'z', pricingModel: 'fixed', taxCategory: 'zero_rated', price: { unitPriceMinor: 1000n } });
    expect(priceQuote({ lines: [{ serviceId: 'z' }], express: false, taxPolicy: GST }, map(z)).taxMinor).toBe(0n);
    const t = svc({ id: 't', pricingModel: 'fixed', price: { unitPriceMinor: 1050n } });
    const q = priceQuote({ lines: [{ serviceId: 't' }], express: false, taxPolicy: { ...GST, priceMode: 'inclusive' } }, map(t));
    expect(q.totalMinor).toBe(1050n); expect(q.netMinor).toBe(1000n); expect(q.taxMinor).toBe(50n);
  });
  it('percentToRate is exact', () => {
    expect(percentToRate('12.5')).toEqual({ num: 125n, den: 1000n });
  });
  it('property: totals always reconcile (lines sum to order, discount fully allocated)', () => {
    const arb = fc.record({
      lines: fc.array(fc.record({ unit: fc.bigInt(1n, 100_000n), q: fc.integer({ min: 1, max: 20 }) }), { minLength: 1, maxLength: 8 }),
      pct: fc.option(fc.integer({ min: 1, max: 100 }), { nil: undefined }), inclusive: fc.boolean(), level: fc.constantFrom('line', 'order'),
    });
    fc.assert(fc.property(arb, (x) => {
      const services = x.lines.map((l, i) => svc({ id: `s${i}`, pricingModel: 'per_item', price: { unitPriceMinor: l.unit } }));
      const q = priceQuote({ lines: x.lines.map((l, i) => ({ serviceId: `s${i}`, quantity: l.q })), express: false,
        taxPolicy: { ...GST, priceMode: x.inclusive ? 'inclusive' : 'exclusive', roundingLevel: x.level as any },
        discount: x.pct ? { type: 'percent', percent: String(x.pct) } : undefined }, map(...services));
      expect(q.lines.reduce((a, l) => a + l.discountMinor, 0n)).toBe(q.discountMinor);
      expect(q.lines.reduce((a, l) => a + l.totalMinor, 0n)).toBe(q.totalMinor);
      expect(q.lines.reduce((a, l) => a + l.taxMinor, 0n)).toBe(q.taxMinor);
      expect(q.netMinor + q.taxMinor).toBe(q.totalMinor);
      expect(q.totalMinor).toBe(x.inclusive ? q.subtotalMinor - q.discountMinor : q.subtotalMinor - q.discountMinor + q.taxMinor);
    }), { numRuns: 400 });
  });
});
