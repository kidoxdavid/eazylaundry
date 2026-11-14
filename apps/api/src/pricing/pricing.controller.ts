import { Body, Controller, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { Database } from '@eazy/database';
import type { TaxPolicy } from '@eazy/money';
import { RequirePermission } from '../common/access.js';
import { CurrentActor } from '../common/current-actor.js';
import { canAccessBranch, dbCtx } from '../common/db-context.js';
import { AppError, forbidden, notFound } from '../common/errors.js';
import type { Actor } from '../common/types.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ConfigService } from '../config/config.service.js';
import { DATABASE } from '../db/db.module.js';
import { PricingError, priceQuote, type PricedService, type Quote } from './engine.js';

const quoteSchema = z.object({
  branchId: z.string().uuid(),
  express: z.boolean().default(false),
  lines: z.array(z.object({ serviceId: z.string().uuid(), quantity: z.number().int().min(1).max(10_000).optional(), weightG: z.number().int().min(1).max(1_000_000).optional() })).min(1).max(100),
  discount: z.discriminatedUnion('type', [
    z.object({ type: z.literal('percent'), percent: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/) }),
    z.object({ type: z.literal('fixed'), amountMinor: z.number().int().min(1).max(1_000_000_00) }),
  ]).optional(),
});

/** bigint -> number for JSON (asserted safe). Money crosses the API as integer minor units. */
export function jsonMoney<T>(v: T): any {
  if (typeof v === 'bigint') { if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('amount out of range'); return Number(v); }
  if (Array.isArray(v)) return v.map(jsonMoney);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonMoney(x)]));
  return v;
}

@Controller('pricing')
export class PricingController {
  constructor(@Inject(DATABASE) private readonly db: Database, @Inject(ConfigService) private readonly cfg: ConfigService) {}

  /** Single entry point for pricing an order. Clients never compute totals. */
  @Post('quote')
  @RequirePermission('order.create')
  quote(@CurrentActor() a: Actor, @Body(new ZodPipe(quoteSchema)) b: z.infer<typeof quoteSchema>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      if (!canAccessBranch(a, b.branchId)) throw notFound('Branch');
      const branch = (await tx.query(`SELECT id, status, (now() AT TIME ZONE timezone)::date::text AS local_date FROM branches WHERE id = $1`, [b.branchId])).rows[0];
      if (!branch || branch.status !== 'active') throw notFound('Branch');
      const list = (await tx.query(`SELECT id FROM price_lists WHERE is_default AND archived_at IS NULL`)).rows[0];
      if (!list) throw new AppError(409, 'NO_DEFAULT_PRICE_LIST', 'No default price list is configured');

      const ids = [...new Set(b.lines.map((l) => l.serviceId))];
      const rows = await tx.query(
        `SELECT s.id, s.code, s.name, s.pricing_model, s.tax_category, s.express_capable, p.* FROM services s
           JOIN LATERAL (
             SELECT sp.id AS price_id, sp.unit_price_minor, sp.min_charge_minor, sp.express_type, sp.express_percent, sp.express_fixed_minor
               FROM service_prices sp WHERE sp.service_id = s.id AND sp.price_list_id = $1 AND sp.valid_from <= now() AND (sp.branch_id = $2 OR sp.branch_id IS NULL)
              ORDER BY (sp.branch_id IS NOT NULL) DESC, sp.valid_from DESC, sp.id DESC LIMIT 1) p ON true
          WHERE s.id = ANY($3) AND s.archived_at IS NULL`, [list.id, b.branchId, ids]);
      const services = new Map<string, PricedService>(rows.rows.map((r) => [r.id, {
        id: r.id, code: r.code, name: r.name, pricingModel: r.pricing_model, taxCategory: r.tax_category, expressCapable: r.express_capable,
        price: { id: r.price_id, unitPriceMinor: BigInt(r.unit_price_minor), minChargeMinor: BigInt(r.min_charge_minor), expressType: r.express_type,
          expressPercent: r.express_percent === null ? null : String(r.express_percent), expressFixedMinor: r.express_fixed_minor === null ? null : BigInt(r.express_fixed_minor) },
      }]));

      const rates = await tx.query(
        `SELECT code, rate, compound FROM tax_rates WHERE effective_from <= $1::date AND (effective_to IS NULL OR effective_to > $1::date) ORDER BY effective_from, code`, [branch.local_date]);
      const priceMode = (await this.cfg.resolve(tx, a.tenantId!, 'tax.price_mode', b.branchId)).value;
      const roundingLevel = (await this.cfg.resolve(tx, a.tenantId!, 'tax.rounding_level', b.branchId)).value;
      const taxPolicy: TaxPolicy = { components: rates.rows.map((r) => ({ code: r.code, rate: String(r.rate), compound: r.compound })), priceMode, roundingLevel };

      if (b.discount && !a.permissions.has('discount.apply')) throw forbidden('PERMISSION_DENIED', 'Missing permission: discount.apply');
      let quote: Quote;
      try {
        quote = priceQuote({ lines: b.lines, express: b.express, taxPolicy,
          discount: b.discount ? (b.discount.type === 'percent' ? b.discount : { type: 'fixed', amountMinor: BigInt(b.discount.amountMinor) }) : undefined }, services);
      } catch (e) {
        if (e instanceof PricingError) throw new AppError(e.code === 'UNKNOWN_SERVICE' ? 404 : 422, e.code, e.message);
        throw e;
      }
      const limit = a.permissions.get('discount.apply');
      if (quote.discountMinor > 0n && limit !== null && limit !== undefined && quote.discountMinor > BigInt(limit)) {
        throw forbidden('DISCOUNT_LIMIT_EXCEEDED', 'This discount exceeds your approval limit');
      }
      const org = (await tx.query(`SELECT currency FROM organizations LIMIT 1`)).rows[0];
      return { currency: org?.currency ?? 'CAD', ...jsonMoney(quote), taxPolicy: { priceMode, roundingLevel, components: taxPolicy.components } };
    });
  }
}
