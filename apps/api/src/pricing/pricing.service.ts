import { Inject, Injectable } from '@nestjs/common';
import type { Tx } from '@eazy/database';
import type { TaxPolicy } from '@eazy/money';
import { canAccessBranch } from '../common/db-context.js';
import { AppError, forbidden, notFound } from '../common/errors.js';
import type { Actor } from '../common/types.js';
import { ConfigService } from '../config/config.service.js';
import { ZonesService } from '../logistics/zones.service.js';
import { PricingError, priceQuote, type PricedService, type Quote, type QuoteLineInput } from './engine.js';

export interface QuoteRequest {
  branchId: string; express: boolean; lines: QuoteLineInput[]; deliveryAddressId?: string;
  discount?: { type: 'percent'; percent: string } | { type: 'fixed'; amountMinor: number };
}
export interface DeliveryContext { zoneId: string; zoneName: string; postalCode: string; address: Record<string, unknown>; feeMinor: bigint; freeDelivery: boolean; taxable: boolean }
export interface QuoteContext {
  delivery: DeliveryContext | null; quote: Quote; currency: string; taxPolicy: TaxPolicy; services: Map<string, PricedService & { turnaroundHours: number }>;
}

/** The ONLY place orders are priced: used by /pricing/quote and by order creation, so they can never disagree. */
@Injectable()
export class PricingService {
  constructor(@Inject(ConfigService) private readonly cfg: ConfigService, @Inject(ZonesService) private readonly zones: ZonesService) {}

  async quote(tx: Tx, a: Actor, b: QuoteRequest): Promise<QuoteContext> {
    if (!canAccessBranch(a, b.branchId)) throw notFound('Branch');
    const branch = (await tx.query(`SELECT id, status, (now() AT TIME ZONE timezone)::date::text AS local_date FROM branches WHERE id = $1`, [b.branchId])).rows[0];
    if (!branch || branch.status !== 'active') throw notFound('Branch');
    const list = (await tx.query(`SELECT id FROM price_lists WHERE is_default AND archived_at IS NULL`)).rows[0];
    if (!list) throw new AppError(409, 'NO_DEFAULT_PRICE_LIST', 'No default price list is configured');

    const ids = [...new Set(b.lines.map((l) => l.serviceId))];
    const rows = await tx.query(
      `SELECT s.id, s.code, s.name, s.pricing_model, s.tax_category, s.express_capable, s.turnaround_hours, p.* FROM services s
         JOIN LATERAL (
           SELECT sp.id AS price_id, sp.unit_price_minor, sp.min_charge_minor, sp.express_type, sp.express_percent, sp.express_fixed_minor
             FROM service_prices sp WHERE sp.service_id = s.id AND sp.price_list_id = $1 AND sp.valid_from <= now() AND (sp.branch_id = $2 OR sp.branch_id IS NULL)
            ORDER BY (sp.branch_id IS NOT NULL) DESC, sp.valid_from DESC, sp.id DESC LIMIT 1) p ON true
        WHERE s.id = ANY($3) AND s.archived_at IS NULL`, [list.id, b.branchId, ids]);
    const services = new Map(rows.rows.map((r) => [r.id as string, {
      id: r.id, code: r.code, name: r.name, pricingModel: r.pricing_model, taxCategory: r.tax_category, expressCapable: r.express_capable, turnaroundHours: r.turnaround_hours as number,
      price: { id: r.price_id, unitPriceMinor: BigInt(r.unit_price_minor), minChargeMinor: BigInt(r.min_charge_minor), expressType: r.express_type,
        expressPercent: r.express_percent === null ? null : String(r.express_percent), expressFixedMinor: r.express_fixed_minor === null ? null : BigInt(r.express_fixed_minor) },
    }]));

    const rates = await tx.query(
      `SELECT code, rate, compound FROM tax_rates WHERE effective_from <= $1::date AND (effective_to IS NULL OR effective_to > $1::date) ORDER BY effective_from, code`, [branch.local_date]);
    const priceMode = (await this.cfg.resolve(tx, a.tenantId!, 'tax.price_mode', b.branchId)).value;
    const roundingLevel = (await this.cfg.resolve(tx, a.tenantId!, 'tax.rounding_level', b.branchId)).value;
    const taxPolicy: TaxPolicy = { components: rates.rows.map((r) => ({ code: r.code, rate: String(r.rate), compound: r.compound })), priceMode, roundingLevel };

    if (b.discount && !a.permissions.has('discount.apply')) throw forbidden('PERMISSION_DENIED', 'Missing permission: discount.apply');
    const discount = b.discount ? (b.discount.type === 'percent' ? b.discount : { type: 'fixed' as const, amountMinor: BigInt(b.discount.amountMinor) }) : undefined;
    const price = (fee?: { name: string; amountMinor: bigint; taxable: boolean }): Quote => {
      try { return priceQuote({ lines: b.lines, express: b.express, taxPolicy, discount, fee }, services); }
      catch (e) {
        if (e instanceof PricingError) throw new AppError(e.code === 'UNKNOWN_SERVICE' ? 404 : 422, e.code, e.message);
        throw e;
      }
    };
    let quote = price();
    let delivery: DeliveryContext | null = null;
    if (b.deliveryAddressId) {
      const addr = (await tx.query(`SELECT line1, line2, city, province, postal_code, delivery_instructions FROM customer_addresses WHERE id = $1`, [b.deliveryAddressId])).rows[0];
      if (!addr) throw notFound('Address');
      const zone = await this.zones.resolve(tx, addr.postal_code);
      if (!zone) throw new AppError(422, 'OUT_OF_ZONE', 'We do not deliver to this address');
      const fee = this.zones.feeFor(zone, quote.subtotalMinor); // minimum and free-delivery thresholds use the services subtotal before discount/tax
      if (fee.belowMinimum) throw new AppError(422, 'BELOW_DELIVERY_MINIMUM', `Delivery to ${zone.name} needs a minimum order of ${(Number(zone.minOrderMinor) / 100).toFixed(2)}`);
      quote = price({ name: 'Delivery', amountMinor: fee.amountMinor, taxable: zone.taxable });
      delivery = { zoneId: zone.id, zoneName: zone.name, postalCode: addr.postal_code, feeMinor: fee.amountMinor, freeDelivery: fee.free, taxable: zone.taxable,
        address: { line1: addr.line1, line2: addr.line2, city: addr.city, province: addr.province, postalCode: addr.postal_code, instructions: addr.delivery_instructions } };
    }
    const limit = a.permissions.get('discount.apply');
    if (quote.discountMinor > 0n && limit !== null && limit !== undefined && quote.discountMinor > BigInt(limit)) {
      throw forbidden('DISCOUNT_LIMIT_EXCEEDED', 'This discount exceeds your approval limit');
    }
    const org = (await tx.query(`SELECT currency FROM organizations LIMIT 1`)).rows[0];
    return { delivery, quote, currency: org?.currency ?? 'CAD', taxPolicy, services };
  }
}
