import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { Database, type Tx } from '@eazy/database';
import { AuditService } from '../audit/audit.service.js';
import { RequirePermission } from '../common/access.js';
import { CurrentActor } from '../common/current-actor.js';
import { canAccessBranch, dbCtx } from '../common/db-context.js';
import { AppError, conflict, notFound } from '../common/errors.js';
import { uuidv7 } from '../common/ids.js';
import type { Actor } from '../common/types.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { DATABASE } from '../db/db.module.js';

const money = z.number().int().min(0).max(1_000_000_00); // minor units, up to $1,000,000.00
const expressSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('percent'), percent: z.number().min(0).max(500).multipleOf(0.001) }),
  z.object({ type: z.literal('fixed'), amountMinor: money }),
]);
const priceSchema = z.object({
  branchId: z.string().uuid().optional(), unitPriceMinor: money, minChargeMinor: money.default(0), express: expressSchema.default({ type: 'none' }),
});
const serviceBase = {
  name: z.string().trim().min(1).max(80), description: z.string().trim().max(500).nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(), taxCategory: z.enum(['taxable', 'zero_rated', 'exempt']),
  expressCapable: z.boolean(), turnaroundHours: z.number().int().min(1).max(720), requiresGarmentTracking: z.boolean(),
};
const createService = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,20}$/), pricingModel: z.enum(['per_kg', 'per_item', 'fixed']),
  ...serviceBase, taxCategory: serviceBase.taxCategory.default('taxable'), expressCapable: serviceBase.expressCapable.default(false),
  turnaroundHours: serviceBase.turnaroundHours.default(48), requiresGarmentTracking: serviceBase.requiresGarmentTracking.default(false),
  price: priceSchema,
});
const patchService = z.object({ version: z.number().int().min(1), ...Object.fromEntries(Object.entries(serviceBase).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])), archived: z.boolean().optional() } as any)
  .refine((v: any) => Object.keys(v).length > 1, 'Nothing to update');
const categorySchema = z.object({ name: z.string().trim().min(1).max(60), sortOrder: z.number().int().min(0).max(10_000).default(0) });
const taxRateSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,10}$/), name: z.string().trim().min(1).max(60),
  rate: z.string().regex(/^(0(\.\d{1,6})?|1(\.0{1,6})?)$/, 'Rate must be a decimal between 0 and 1, e.g. 0.05'), compound: z.boolean().default(false),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const mapPrice = (r: any) => r.price_id ? ({
  id: r.price_id, branchId: r.p_branch_id, unitPriceMinor: num(r.unit_price_minor), minChargeMinor: num(r.min_charge_minor),
  express: r.express_type === 'none' ? { type: 'none' } : r.express_type === 'percent' ? { type: 'percent', percent: Number(r.express_percent) } : { type: 'fixed', amountMinor: num(r.express_fixed_minor) },
  validFrom: r.valid_from,
}) : null;
const mapService = (r: any) => ({
  id: r.id, code: r.code, name: r.name, description: r.description, categoryId: r.category_id, pricingModel: r.pricing_model, taxCategory: r.tax_category,
  expressCapable: r.express_capable, turnaroundHours: r.turnaround_hours, requiresGarmentTracking: r.requires_garment_tracking, version: r.version,
  archived: !!r.archived_at, price: mapPrice(r),
});

const CURRENT_PRICE = `LEFT JOIN LATERAL (
  SELECT sp.id AS price_id, sp.branch_id AS p_branch_id, sp.unit_price_minor, sp.min_charge_minor, sp.express_type, sp.express_percent,
         sp.express_fixed_minor, sp.valid_from
    FROM service_prices sp
   WHERE sp.service_id = s.id AND sp.price_list_id = $1 AND sp.valid_from <= now() AND (sp.branch_id = $2 OR sp.branch_id IS NULL)
   ORDER BY (sp.branch_id IS NOT NULL) DESC, sp.valid_from DESC, sp.id DESC LIMIT 1) p ON true`;

@Controller()
export class CatalogueController {
  constructor(@Inject(DATABASE) private readonly db: Database, @Inject(AuditService) private readonly audit: AuditService) {}

  private async defaultList(tx: Tx): Promise<string> {
    const r = (await tx.query(`SELECT id FROM price_lists WHERE is_default AND archived_at IS NULL`)).rows[0];
    if (!r) throw new AppError(409, 'NO_DEFAULT_PRICE_LIST', 'No default price list is configured');
    return r.id;
  }

  private async insertPrice(tx: Tx, a: Actor, serviceId: string, listId: string, p: z.infer<typeof priceSchema>) {
    if (p.branchId) {
      if (!canAccessBranch(a, p.branchId) || !(await tx.query(`SELECT 1 FROM branches WHERE id = $1`, [p.branchId])).rowCount) throw notFound('Branch');
    } else if (!a.allBranches) {
      throw new AppError(403, 'BRANCH_SCOPE', 'Only users with access to all branches can change prices for all branches');
    }
    const e = p.express;
    const id = uuidv7();
    await tx.query(
      `INSERT INTO service_prices (id, tenant_id, price_list_id, service_id, branch_id, unit_price_minor, min_charge_minor, express_type, express_percent, express_fixed_minor, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, a.tenantId, listId, serviceId, p.branchId ?? null, p.unitPriceMinor, p.minChargeMinor, e.type,
       e.type === 'percent' ? e.percent : null, e.type === 'fixed' ? e.amountMinor : null, a.userId]);
    return id;
  }

  // ---- categories ----
  @Get('service-categories')
  @RequirePermission('order.read')
  categories(@CurrentActor() a: Actor) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const r = await tx.query(`SELECT id, name, sort_order, archived_at FROM service_categories WHERE archived_at IS NULL ORDER BY sort_order, lower(name)`);
      return { items: r.rows.map((x) => ({ id: x.id, name: x.name, sortOrder: x.sort_order })) };
    });
  }

  @Post('service-categories')
  @RequirePermission('catalogue.manage')
  createCategory(@CurrentActor() a: Actor, @Body(new ZodPipe(categorySchema)) b: z.infer<typeof categorySchema>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const id = uuidv7();
      try { await tx.query(`INSERT INTO service_categories (id, tenant_id, name, sort_order) VALUES ($1,$2,$3,$4)`, [id, a.tenantId, b.name, b.sortOrder]); }
      catch (e: any) { if (e.code === '23505') throw conflict('DUPLICATE_CATEGORY', 'A category with this name already exists'); throw e; }
      await this.audit.record(tx, a, { action: 'category.created', entityType: 'service_category', entityId: id, detail: b });
      return { id };
    });
  }

  // ---- services ----
  @Get('services')
  @RequirePermission('order.read')
  listServices(@CurrentActor() a: Actor, @Query('branchId') branchId?: string, @Query('includeArchived') inc?: string) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      if (branchId && (!z.string().uuid().safeParse(branchId).success || !canAccessBranch(a, branchId))) throw notFound('Branch');
      const listId = await this.defaultList(tx);
      const r = await tx.query(`SELECT s.*, p.* FROM services s ${CURRENT_PRICE} ${inc === 'true' ? '' : 'WHERE s.archived_at IS NULL'} ORDER BY lower(s.name)`, [listId, branchId ?? null]);
      return { items: r.rows.map(mapService) };
    });
  }

  @Post('services')
  @RequirePermission('catalogue.manage')
  createServiceEp(@CurrentActor() a: Actor, @Body(new ZodPipe(createService)) b: z.infer<typeof createService>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      if (b.expressCapable && b.price.express.type === 'none') throw new AppError(400, 'VALIDATION_ERROR', 'An express-capable service needs an express surcharge (use fixed 0 for no extra charge)');
      const id = uuidv7();
      try {
        await tx.query('SAVEPOINT s1');
        await tx.query(
          `INSERT INTO services (id, tenant_id, category_id, code, name, description, pricing_model, tax_category, express_capable, turnaround_hours, requires_garment_tracking)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [id, a.tenantId, b.categoryId ?? null, b.code, b.name, b.description ?? null, b.pricingModel, b.taxCategory, b.expressCapable, b.turnaroundHours, b.requiresGarmentTracking]);
      } catch (e: any) {
        await tx.query('ROLLBACK TO SAVEPOINT s1');
        if (e.code === '23505') throw conflict('DUPLICATE_SERVICE_CODE', 'A service with this code already exists');
        throw e;
      }
      const priceId = await this.insertPrice(tx, a, id, await this.defaultList(tx), b.price);
      await this.audit.record(tx, a, { action: 'service.created', entityType: 'service', entityId: id, detail: { code: b.code, priceId } });
      return { id, priceId };
    });
  }

  @Patch('services/:id')
  @RequirePermission('catalogue.manage')
  updateService(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(patchService)) b: any) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const cur = (await tx.query(`SELECT * FROM services WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!cur) throw notFound('Service');
      if (cur.version !== b.version) throw conflict('VERSION_CONFLICT', 'This service was changed by someone else. Reload and try again.');
      const pick = (k: string, col: string) => (b[k] === undefined ? cur[col] : b[k]);
      await tx.query(
        `UPDATE services SET name=$2, description=$3, category_id=$4, tax_category=$5, express_capable=$6, turnaround_hours=$7,
                requires_garment_tracking=$8, archived_at=$9, version=version+1 WHERE id=$1`,
        [id, pick('name', 'name'), pick('description', 'description'), pick('categoryId', 'category_id'), pick('taxCategory', 'tax_category'),
         pick('expressCapable', 'express_capable'), pick('turnaroundHours', 'turnaround_hours'), pick('requiresGarmentTracking', 'requires_garment_tracking'),
         b.archived === undefined ? cur.archived_at : b.archived ? new Date() : null]);
      await this.audit.record(tx, a, { action: b.archived === true ? 'service.archived' : 'service.updated', entityType: 'service', entityId: id,
        detail: { fields: Object.keys(b).filter((k) => k !== 'version') } });
      return { id, version: cur.version + 1 };
    });
  }

  /** Appends a NEW price version (history is immutable). */
  @Put('services/:id/price')
  @RequirePermission('catalogue.manage')
  setPrice(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(priceSchema)) b: z.infer<typeof priceSchema>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const s = (await tx.query(`SELECT express_capable FROM services WHERE id = $1`, [id])).rows[0];
      if (!s) throw notFound('Service');
      if (s.express_capable && b.express.type === 'none') throw new AppError(400, 'VALIDATION_ERROR', 'An express-capable service needs an express surcharge');
      const priceId = await this.insertPrice(tx, a, id, await this.defaultList(tx), b);
      await this.audit.record(tx, a, { action: 'service.price_changed', entityType: 'service', entityId: id, branchId: b.branchId, detail: { priceId, ...b } });
      return { priceId };
    });
  }

  @Get('services/:id/prices')
  @RequirePermission('catalogue.manage')
  priceHistory(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      if (!(await tx.query(`SELECT 1 FROM services WHERE id = $1`, [id])).rowCount) throw notFound('Service');
      const r = await tx.query(
        `SELECT sp.id AS price_id, sp.branch_id AS p_branch_id, sp.unit_price_minor, sp.min_charge_minor, sp.express_type, sp.express_percent,
                sp.express_fixed_minor, sp.valid_from FROM service_prices sp WHERE sp.service_id = $1 ORDER BY sp.valid_from DESC, sp.id DESC`, [id]);
      return { items: r.rows.map(mapPrice) };
    });
  }

  // ---- tax rates ----
  @Get('tax-rates')
  @RequirePermission('order.read')
  taxRates(@CurrentActor() a: Actor) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const r = await tx.query(`SELECT id, code, name, rate, compound, effective_from::text AS effective_from, effective_to::text AS effective_to
                                  FROM tax_rates ORDER BY effective_from DESC, code`);
      return { items: r.rows.map((x) => ({ id: x.id, code: x.code, name: x.name, rate: x.rate, compound: x.compound, effectiveFrom: x.effective_from, effectiveTo: x.effective_to })) };
    });
  }

  @Post('tax-rates')
  @RequirePermission('tenant.settings.manage')
  addTaxRate(@CurrentActor() a: Actor, @Body(new ZodPipe(taxRateSchema)) b: z.infer<typeof taxRateSchema>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const later = await tx.query(`SELECT 1 FROM tax_rates WHERE code = $1 AND effective_from >= $2::date`, [b.code, b.effectiveFrom]);
      if (later.rowCount) throw conflict('TAX_RATE_OVERLAP', 'A rate with this code already starts on or after that date');
      await tx.query(`UPDATE tax_rates SET effective_to = $2::date WHERE code = $1 AND (effective_to IS NULL OR effective_to > $2::date)`, [b.code, b.effectiveFrom]);
      const id = uuidv7();
      await tx.query(`INSERT INTO tax_rates (id, tenant_id, code, name, rate, compound, effective_from) VALUES ($1,$2,$3,$4,$5,$6,$7::date)`,
        [id, a.tenantId, b.code, b.name, b.rate, b.compound, b.effectiveFrom]);
      await this.audit.record(tx, a, { action: 'tax_rate.added', entityType: 'tax_rate', entityId: id, detail: b });
      return { id };
    });
  }
}
