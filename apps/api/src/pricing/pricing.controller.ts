import { Body, Controller, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { Database } from '@eazy/database';
import { RequirePermission } from '../common/access.js';
import { CurrentActor } from '../common/current-actor.js';
import { dbCtx } from '../common/db-context.js';
import type { Actor } from '../common/types.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { DATABASE } from '../db/db.module.js';
import { PricingService } from './pricing.service.js';

export const quoteSchema = z.object({
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
  constructor(@Inject(DATABASE) private readonly db: Database, @Inject(PricingService) private readonly pricing: PricingService) {}

  /** Single entry point for pricing an order. Clients never compute totals. */
  @Post('quote')
  @RequirePermission('order.create')
  quote(@CurrentActor() a: Actor, @Body(new ZodPipe(quoteSchema)) b: z.infer<typeof quoteSchema>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const r = await this.pricing.quote(tx, a, b);
      return { currency: r.currency, ...jsonMoney(r.quote), taxPolicy: { priceMode: r.taxPolicy.priceMode, roundingLevel: r.taxPolicy.roundingLevel, components: r.taxPolicy.components } };
    });
  }
}
