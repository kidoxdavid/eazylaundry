import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Database, type Tx } from '@eazy/database';
import { AuditService } from '../audit/audit.service.js';
import { RequirePermission } from '../common/access.js';
import { PROVINCES, phone, postalCode, normalizePhone } from '../common/canada.js';
import { CurrentActor } from '../common/current-actor.js';
import { dbCtx } from '../common/db-context.js';
import { AppError, conflict, notFound } from '../common/errors.js';
import { uuidv7 } from '../common/ids.js';
import type { Actor } from '../common/types.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { DATABASE } from '../db/db.module.js';

const email = z.string().trim().toLowerCase().email().max(254);
export const addressSchema = z.object({
  label: z.string().trim().min(1).max(40).default('Home'),
  line1: z.string().trim().min(1).max(120), line2: z.string().trim().max(120).optional(),
  city: z.string().trim().min(1).max(80), province: z.enum(PROVINCES), postalCode,
  deliveryInstructions: z.string().trim().max(500).optional(), isDefault: z.boolean().default(false),
});
const PURPOSES = ['marketing_email', 'marketing_sms', 'transactional_sms'] as const;
const SOURCES = ['pos', 'portal', 'storefront', 'import', 'staff', 'unsubscribe_link'] as const;

const createSchema = z.object({
  kind: z.enum(['individual', 'guest', 'commercial_contact']).default('individual'),
  fullName: z.string().trim().min(1).max(120),
  email: email.optional(), phone: phone.optional(), notes: z.string().trim().max(2000).optional(),
  address: addressSchema.optional(),
  consents: z.array(z.object({ purpose: z.enum(PURPOSES), granted: z.boolean() })).max(3).default([]),
}).superRefine((v, ctx) => {
  if (v.kind !== 'guest' && !v.email && !v.phone) ctx.addIssue({ code: 'custom', path: ['phone'], message: 'Provide a phone number or email' });
});
const patchSchema = z.object({
  version: z.number().int().min(1),
  fullName: z.string().trim().min(1).max(120).optional(), email: email.nullable().optional(), phone: phone.nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(), archived: z.boolean().optional(),
}).refine((v) => Object.keys(v).length > 1, 'Nothing to update');
const listQuery = z.object({ q: z.string().trim().max(100).optional(), limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(5000).default(0), includeArchived: z.enum(['true', 'false']).default('false') });
const consentSchema = z.object({ purpose: z.enum(PURPOSES), granted: z.boolean(), source: z.enum(SOURCES).default('staff') });

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const map = (r: any) => ({ id: r.id, kind: r.kind, fullName: r.full_name, email: r.email, phone: r.phone, notes: r.notes,
  version: r.version, archived: !!r.archived_at, createdAt: r.created_at, updatedAt: r.updated_at });
const mapAddr = (r: any) => ({ id: r.id, label: r.label, line1: r.line1, line2: r.line2, city: r.city, province: r.province,
  postalCode: r.postal_code, deliveryInstructions: r.delivery_instructions, isDefault: r.is_default });

@Controller('customers')
export class CustomersController {
  constructor(@Inject(DATABASE) private readonly db: Database, @Inject(AuditService) private readonly audit: AuditService) {}

  private async consentState(tx: Tx, customerId: string) {
    const r = await tx.query(
      `SELECT DISTINCT ON (purpose) purpose, granted, source, recorded_at FROM customer_consents
        WHERE customer_id = $1 ORDER BY purpose, recorded_at DESC, id DESC`, [customerId]);
    return r.rows.map((x) => ({ purpose: x.purpose, granted: x.granted, source: x.source, recordedAt: x.recorded_at }));
  }

  private async addAddress(tx: Tx, a: Actor, customerId: string, v: z.infer<typeof addressSchema>) {
    const id = uuidv7();
    const existing = (await tx.query(`SELECT count(*)::int AS n FROM customer_addresses WHERE customer_id = $1`, [customerId])).rows[0].n;
    const makeDefault = v.isDefault || existing === 0;
    if (makeDefault) await tx.query(`UPDATE customer_addresses SET is_default = false WHERE customer_id = $1`, [customerId]);
    await tx.query(
      `INSERT INTO customer_addresses (id, tenant_id, customer_id, label, line1, line2, city, province, postal_code, delivery_instructions, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, a.tenantId, customerId, v.label, v.line1, v.line2 ?? null, v.city, v.province, v.postalCode, v.deliveryInstructions ?? null, makeDefault]);
    return id;
  }

  /** Maps a unique-violation on contact details to an actionable duplicate error pointing at the existing record. */
  private async duplicate(tx: Tx, e: any, em?: string | null, ph?: string | null): Promise<never> {
    if (e?.code !== '23505') throw e;
    const field = /phone/.test(e.constraint ?? '') ? 'phone' : 'email';
    return Promise.reject(this.dupError(field, field === 'phone' ? ph : em, tx));
  }
  private dupError(field: string, _value: unknown, _tx: Tx) {
    return new AppError(409, 'DUPLICATE_CUSTOMER', `A customer with this ${field} already exists`);
  }

  @Get()
  @RequirePermission('customer.read')
  list(@CurrentActor() a: Actor, @Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const where: string[] = []; const p: unknown[] = [];
      if (q.includeArchived !== 'true') where.push('archived_at IS NULL');
      if (q.q) {
        const digits = q.q.replace(/\D/g, '');
        const looksPhone = digits.length >= 3 && digits.length >= q.q.replace(/[\s()+-]/g, '').length;
        p.push(`%${escapeLike(q.q)}%`); const nameIdx = p.length;
        const ors = [`full_name ILIKE $${nameIdx}`, `email ILIKE $${nameIdx}`];
        if (looksPhone) { p.push(`%${digits}%`); ors.push(`phone LIKE $${p.length}`); }
        where.push(`(${ors.join(' OR ')})`);
      }
      p.push(q.limit, q.offset);
      const r = await tx.query(`SELECT * FROM customers ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY lower(full_name), id LIMIT $${p.length - 1} OFFSET $${p.length}`, p);
      return { items: r.rows.map(map) };
    });
  }

  @Post()
  @RequirePermission('customer.manage')
  create(@CurrentActor() a: Actor, @Body(new ZodPipe(createSchema)) b: z.infer<typeof createSchema>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const id = uuidv7();
      try {
        await tx.query('SAVEPOINT ins');
        await tx.query(`INSERT INTO customers (id, tenant_id, kind, full_name, email, phone, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, a.tenantId, b.kind, b.fullName, b.email ?? null, b.phone ?? null, b.notes ?? null, a.userId]);
      } catch (e) { await tx.query('ROLLBACK TO SAVEPOINT ins'); return this.duplicate(tx, e, b.email, b.phone); }
      if (b.address) await this.addAddress(tx, a, id, b.address);
      for (const c of b.consents) {
        await tx.query(`INSERT INTO customer_consents (id, tenant_id, customer_id, purpose, granted, source, recorded_by) VALUES ($1,$2,$3,$4,$5,'pos',$6)`,
          [uuidv7(), a.tenantId, id, c.purpose, c.granted, a.userId]);
      }
      await this.audit.record(tx, a, { action: 'customer.created', entityType: 'customer', entityId: id, detail: { kind: b.kind } });
      return { id };
    });
  }

  @Get(':id')
  @RequirePermission('customer.read')
  get(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const c = (await tx.query(`SELECT * FROM customers WHERE id = $1`, [id])).rows[0];
      if (!c) throw notFound('Customer');
      const addrs = await tx.query(`SELECT * FROM customer_addresses WHERE customer_id = $1 ORDER BY is_default DESC, created_at`, [id]);
      return { ...map(c), addresses: addrs.rows.map(mapAddr), consents: await this.consentState(tx, id) };
    });
  }

  @Patch(':id')
  @RequirePermission('customer.manage')
  update(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(patchSchema)) b: z.infer<typeof patchSchema>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const cur = (await tx.query(`SELECT * FROM customers WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!cur) throw notFound('Customer');
      if (cur.version !== b.version) throw conflict('VERSION_CONFLICT', 'This customer was changed by someone else. Reload and try again.');
      const next = {
        full_name: b.fullName ?? cur.full_name,
        email: b.email === undefined ? cur.email : b.email, phone: b.phone === undefined ? cur.phone : b.phone,
        notes: b.notes === undefined ? cur.notes : b.notes,
        archived_at: b.archived === undefined ? cur.archived_at : b.archived ? new Date() : null,
      };
      if (cur.kind !== 'guest' && !next.email && !next.phone) throw new AppError(400, 'VALIDATION_ERROR', 'A customer needs a phone number or email');
      try {
        await tx.query('SAVEPOINT upd');
        await tx.query(`UPDATE customers SET full_name=$2, email=$3, phone=$4, notes=$5, archived_at=$6, version=version+1, updated_at=now() WHERE id=$1`,
          [id, next.full_name, next.email, next.phone, next.notes, next.archived_at]);
      } catch (e) { await tx.query('ROLLBACK TO SAVEPOINT upd'); return this.duplicate(tx, e, next.email, next.phone); }
      await this.audit.record(tx, a, { action: b.archived === true ? 'customer.archived' : 'customer.updated', entityType: 'customer', entityId: id,
        detail: { fields: Object.keys(b).filter((k) => k !== 'version') } });
      return { id, version: cur.version + 1 };
    });
  }

  @Post(':id/addresses')
  @RequirePermission('customer.manage')
  addAddr(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(addressSchema)) b: z.infer<typeof addressSchema>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      if (!(await tx.query(`SELECT 1 FROM customers WHERE id = $1 FOR UPDATE`, [id])).rowCount) throw notFound('Customer');
      const addrId = await this.addAddress(tx, a, id, b);
      await this.audit.record(tx, a, { action: 'customer.address_added', entityType: 'customer', entityId: id });
      return { id: addrId };
    });
  }

  @Delete(':id/addresses/:addressId')
  @RequirePermission('customer.manage')
  @HttpCode(204)
  removeAddr(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Param('addressId', ParseUUIDPipe) addressId: string) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const r = await tx.query(`DELETE FROM customer_addresses WHERE id = $1 AND customer_id = $2 RETURNING is_default`, [addressId, id]);
      if (!r.rowCount) throw notFound('Address');
      if (r.rows[0].is_default) {
        await tx.query(`UPDATE customer_addresses SET is_default = true WHERE id = (SELECT id FROM customer_addresses WHERE customer_id = $1 ORDER BY created_at LIMIT 1)`, [id]);
      }
      await this.audit.record(tx, a, { action: 'customer.address_removed', entityType: 'customer', entityId: id });
    });
  }

  @Post(':id/consents')
  @RequirePermission('customer.manage')
  consent(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(consentSchema)) b: z.infer<typeof consentSchema>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      if (!(await tx.query(`SELECT 1 FROM customers WHERE id = $1`, [id])).rowCount) throw notFound('Customer');
      await tx.query(`INSERT INTO customer_consents (id, tenant_id, customer_id, purpose, granted, source, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [uuidv7(), a.tenantId, id, b.purpose, b.granted, b.source, a.userId]);
      await this.audit.record(tx, a, { action: 'customer.consent_recorded', entityType: 'customer', entityId: id, detail: b });
      return { consents: await this.consentState(tx, id) };
    });
  }
}

export { normalizePhone };
