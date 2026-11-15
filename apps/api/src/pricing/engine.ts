import { allocate, computeTax, divRound, mulRate, parseRate, type Rate, type TaxPolicy, type TaxResult } from '@eazy/money';

/**
 * THE pricing engine. Pure and deterministic: no I/O, no clocks. All amounts are integer minor units.
 * Callers (API, later portal/storefront/recurring orders) must use this and nothing else to price an order.
 */
export type PricingModel = 'per_kg' | 'per_item' | 'fixed';

export interface PricedService {
  id: string; code: string; name: string; pricingModel: PricingModel;
  taxCategory: 'taxable' | 'zero_rated' | 'exempt'; expressCapable: boolean;
  price: { id: string; unitPriceMinor: bigint; minChargeMinor: bigint; expressType: 'none' | 'percent' | 'fixed'; expressPercent: string | null; expressFixedMinor: bigint | null };
}
export interface QuoteLineInput { serviceId: string; quantity?: number; weightG?: number }
export type DiscountInput = { type: 'percent'; percent: string } | { type: 'fixed'; amountMinor: bigint };
export interface QuoteInput { lines: QuoteLineInput[]; express: boolean; discount?: DiscountInput; taxPolicy: TaxPolicy }

export interface QuoteLine {
  serviceId: string; code: string; name: string; pricingModel: PricingModel; quantity: number | null; weightG: number | null;
  priceId: string; unitPriceMinor: bigint; baseMinor: bigint; minChargeApplied: boolean; expressMinor: bigint;
  discountMinor: bigint; /** after discount, before tax extraction */ amountMinor: bigint; netMinor: bigint; taxMinor: bigint; totalMinor: bigint;
  taxByComponent: Record<string, bigint>;
}
export interface Quote {
  lines: QuoteLine[]; subtotalMinor: bigint; discountMinor: bigint; netMinor: bigint; taxMinor: bigint; totalMinor: bigint;
  taxByComponent: Record<string, bigint>; priceMode: TaxPolicy['priceMode']; express: boolean;
}

export class PricingError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

/** "12.5" (percent) -> Rate 0.125 (exact). */
export function percentToRate(percent: string): Rate {
  const r = parseRate(percent);
  return { num: r.num, den: r.den * 100n };
}

export function priceQuote(input: QuoteInput, services: Map<string, PricedService>): Quote {
  if (!input.lines.length) throw new PricingError('NO_LINES', 'Add at least one service');
  const lines = input.lines.map((l) => {
    const s = services.get(l.serviceId);
    if (!s) throw new PricingError('UNKNOWN_SERVICE', 'Service is not available');
    let base: bigint; let quantity: number | null = null; let weightG: number | null = null;
    const unit = s.price.unitPriceMinor;
    if (s.pricingModel === 'per_kg') {
      if (!Number.isInteger(l.weightG) || (l.weightG as number) <= 0) throw new PricingError('WEIGHT_REQUIRED', `${s.name} is priced by weight; enter the weight`);
      weightG = l.weightG as number;
      base = divRound(unit * BigInt(weightG), 1000n, 'half_up'); // unit price is per kg; weight in grams
    } else {
      const q = l.quantity ?? 1;
      if (!Number.isInteger(q) || q <= 0 || q > 10_000) throw new PricingError('QUANTITY_INVALID', `Quantity for ${s.name} must be a whole number`);
      quantity = q; base = unit * BigInt(q);
    }
    const minChargeApplied = base < s.price.minChargeMinor;
    if (minChargeApplied) base = s.price.minChargeMinor;

    let express = 0n;
    // Express applies to the lines whose service offers it; other lines are priced normally.
    if (input.express && s.expressCapable && s.price.expressType !== 'none') {
      express = s.price.expressType === 'percent' ? mulRate(base, percentToRate(s.price.expressPercent as string)) : (s.price.expressFixedMinor as bigint);
    }
    return { s, quantity, weightG, base, express, minChargeApplied };
  });

  if (input.express && !lines.some((l) => l.s.expressCapable && l.s.price.expressType !== 'none')) {
    throw new PricingError('EXPRESS_NOT_AVAILABLE', 'None of the selected services is available as express');
  }
  const subtotal = lines.reduce((a, l) => a + l.base + l.express, 0n);
  let discount = 0n;
  if (input.discount) {
    discount = input.discount.type === 'percent' ? mulRate(subtotal, percentToRate(input.discount.percent)) : input.discount.amountMinor;
    if (discount < 0n || discount > subtotal) throw new PricingError('DISCOUNT_INVALID', 'Discount cannot exceed the order subtotal');
  }
  const discounts = discount === 0n ? lines.map(() => 0n) : allocate(discount, lines.map((l) => l.base + l.express));
  const amounts = lines.map((l, i) => l.base + l.express - discounts[i]);

  const tax: TaxResult = computeTax(
    lines.map((l, i) => ({ id: String(i), amountMinor: amounts[i], taxable: l.s.taxCategory === 'taxable' })), input.taxPolicy);

  const out: QuoteLine[] = lines.map((l, i) => ({
    serviceId: l.s.id, code: l.s.code, name: l.s.name, pricingModel: l.s.pricingModel, quantity: l.quantity, weightG: l.weightG,
    priceId: l.s.price.id, unitPriceMinor: l.s.price.unitPriceMinor, baseMinor: l.base, minChargeApplied: l.minChargeApplied, expressMinor: l.express,
    discountMinor: discounts[i], amountMinor: amounts[i], netMinor: tax.lines[i].netMinor, taxMinor: tax.lines[i].taxMinor,
    totalMinor: tax.lines[i].netMinor + tax.lines[i].taxMinor, taxByComponent: tax.lines[i].byComponent,
  }));
  return { lines: out, subtotalMinor: subtotal, discountMinor: discount, netMinor: tax.netMinor, taxMinor: tax.taxMinor, totalMinor: tax.grossMinor,
    taxByComponent: tax.byComponent, priceMode: input.taxPolicy.priceMode, express: input.express };
}
