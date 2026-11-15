import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Database, type Tx } from '@eazy/database';
import { AuditService } from '../audit/audit.service.js';
import { RequireAnyPermission, RequirePermission } from '../common/access.js';
import { CurrentActor } from '../common/current-actor.js';
import { canAccessBranch, dbCtx } from '../common/db-context.js';
import { AppError, conflict, forbidden, notFound } from '../common/errors.js';
import { uuidv7 } from '../common/ids.js';
import type { Actor } from '../common/types.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { DATABASE } from '../db/db.module.js';
import { WorkflowService } from '../production/workflow.service.js';
import { TasksService, windowSchema } from './tasks.service.js';
import { ZonesService, compactPostal } from './zones.service.js';

const prefix = z.string().trim().toUpperCase().regex(/^[A-Z][0-9A-Z]{0,5}$/, 'Use a postal prefix like T5J or T6');
const money = z.number().int().min(0).max(1_000_000_00);
const zoneBase = z.object({
  name: z.string().trim().min(1).max(60), postalPrefixes: z.array(prefix).min(1).max(200), minOrderMinor: money.default(0), feeMinor: money.default(0),
  freeOverMinor: money.min(1).nullable().default(null), taxable: z.boolean().default(true), active: z.boolean().default(true),
});
const zonePatch = zoneBase.partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');
const bookingSchema = z.object({ branchId: z.string().uuid(), customerId: z.string().uuid(), addressId: z.string().uuid(), window: windowSchema, notes: z.string().trim().max(500).optional() });
const listQuery = z.object({
  from: z.string().datetime().optional(), to: z.string().datetime().optional(), status: z.enum(['requested', 'assigned', 'en_route', 'completed', 'failed', 'cancelled']).optional(),
  kind: z.enum(['pickup', 'delivery']).optional(), branchId: z.string().uuid().optional(), assignedTo: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(100),
});
const driverQuery = z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() });
const assignSchema = z.object({ driverUserId: z.string().uuid() });
const rescheduleSchema = z.object({ window: windowSchema, driverUserId: z.string().uuid().optional() });
const cancelSchema = z.object({ reason: z.string().trim().min(3).max(300) });
const linkSchema = z.object({ orderId: z.string().uuid() });
const completeSchema = z.object({
  bagCount: z.number().int().min(1).max(100).optional(), note: z.string().trim().max(300).optional(),
  proof: z.discriminatedUnion('type', [
    z.object({ type: z.literal('otp'), code: z.string().regex(/^\d{6}$/) }),
    z.object({ type: z.literal('recipient'), recipientName: z.string().trim().min(2).max(80) }),
    z.object({ type: z.literal('left_at_door'), note: z.string().trim().min(3).max(200) }),
  ]).optional(),
});
const failSchema = z.object({ reason: z.enum(['no_answer', 'wrong_address', 'refused', 'not_home', 'other']), note: z.string().trim().max(300).optional() });

const MAX_OTP_ATTEMPTS = 5;
const N = (v: unknown) => Number(v);
const isDispatcher = (a: Actor) => a.permissions.has('delivery.dispatch');
const mapZone = (r: any) => ({ id: r.id, name: r.name, postalPrefixes: r.postal_prefixes, minOrderMinor: N(r.min_order_minor), feeMinor: N(r.fee_minor),
  freeOverMinor: r.free_over_minor === null ? null : N(r.free_over_minor), taxable: r.taxable, active: r.active });

const TASK_SELECT = `SELECT t.*, o.order_no, o.status AS order_status, (o.total_minor - o.paid_minor) AS order_balance, ws.order_status AS stage_status, c.full_name AS customer_name,
    drv.full_name AS driver_name
  FROM delivery_tasks t JOIN customers c ON c.tenant_id = t.tenant_id AND c.id = t.customer_id
  LEFT JOIN orders o ON o.tenant_id = t.tenant_id AND o.id = t.order_id
  LEFT JOIN workflow_stages ws ON ws.tenant_id = o.tenant_id AND ws.id = o.current_stage_id
  LEFT JOIN users drv ON drv.id = t.assigned_to`;

@Controller()
export class LogisticsController {
  constructor(
    @Inject(DATABASE) private readonly db: Database, @Inject(AuditService) private readonly audit: AuditService, @Inject(ZonesService) private readonly zones: ZonesService,
    @Inject(TasksService) private readonly tasks: TasksService, @Inject(WorkflowService) private readonly workflow: WorkflowService,
  ) {}

  // ------------------------------------------------------------------ zones
  @Get('delivery-zones')
  @RequireAnyPermission('order.read', 'delivery.dispatch')
  listZones(@CurrentActor() a: Actor) {
    return this.db.withContext(dbCtx(a), async (tx) => ({ items: (await tx.query(`SELECT * FROM delivery_zones ORDER BY lower(name)`)).rows.map(mapZone) }));
  }

  @Post('delivery-zones')
  @RequirePermission('tenant.settings.manage')
  createZone(@CurrentActor() a: Actor, @Body(new ZodPipe(zoneBase)) b: z.infer<typeof zoneBase>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const id = uuidv7();
      try {
        await tx.query(`INSERT INTO delivery_zones (id, tenant_id, name, postal_prefixes, min_order_minor, fee_minor, free_over_minor, taxable, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, a.tenantId, b.name, b.postalPrefixes, b.minOrderMinor, b.feeMinor, b.freeOverMinor, b.taxable, b.active]);
      } catch (e: any) { if (e.code === '23505') throw conflict('DUPLICATE_ZONE', 'A zone with this name already exists'); throw e; }
      await this.audit.record(tx, a, { action: 'delivery_zone.created', entityType: 'delivery_zone', entityId: id, detail: b });
      return { id };
    });
  }

  @Patch('delivery-zones/:id')
  @RequirePermission('tenant.settings.manage')
  updateZone(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(zonePatch)) b: z.infer<typeof zonePatch>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const cur = (await tx.query(`SELECT * FROM delivery_zones WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!cur) throw notFound('Zone');
      const v = (k: keyof typeof b, col: string) => (b[k] === undefined ? cur[col] : b[k]);
      try {
        await tx.query(`UPDATE delivery_zones SET name=$2, postal_prefixes=$3, min_order_minor=$4, fee_minor=$5, free_over_minor=$6, taxable=$7, active=$8 WHERE id=$1`,
          [id, v('name', 'name'), v('postalPrefixes', 'postal_prefixes'), v('minOrderMinor', 'min_order_minor'), v('feeMinor', 'fee_minor'), v('freeOverMinor', 'free_over_minor'), v('taxable', 'taxable'), v('active', 'active')]);
      } catch (e: any) { if (e.code === '23505') throw conflict('DUPLICATE_ZONE', 'A zone with this name already exists'); throw e; }
      await this.audit.record(tx, a, { action: 'delivery_zone.updated', entityType: 'delivery_zone', entityId: id, detail: b });
      return { id };
    });
  }

  /** Which zone and fee would apply to this postal code (for counter staff / the storefront later). */
  @Get('delivery-zones/check')
  @RequireAnyPermission('order.read', 'delivery.dispatch')
  check(@CurrentActor() a: Actor, @Query('postalCode') postal: string) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const p = compactPostal(postal ?? '');
      if (!/^[A-Z]\d[A-Z]\d?[A-Z]?\d?$/.test(p)) throw new AppError(400, 'VALIDATION_ERROR', 'Enter a Canadian postal code');
      const z2 = await this.zones.resolve(tx, p);
      return z2 ? { covered: true, zone: z2.name, feeMinor: N(z2.feeMinor), freeOverMinor: z2.freeOverMinor === null ? null : N(z2.freeOverMinor), minOrderMinor: N(z2.minOrderMinor) } : { covered: false };
    });
  }

  // ------------------------------------------------------------------ drivers
  @Get('drivers')
  @RequirePermission('delivery.dispatch')
  drivers(@CurrentActor() a: Actor) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const r = await tx.query(
        `SELECT m.user_id, u.full_name, m.all_branches, coalesce((SELECT array_agg(branch_id) FROM membership_branches mb WHERE mb.membership_id = m.id), '{}') AS branch_ids
           FROM user_memberships m JOIN users u ON u.id = m.user_id
          WHERE m.status = 'active' AND EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = m.role_id AND rp.permission_code = 'delivery.execute') ORDER BY u.full_name`);
      return { items: r.rows.map((x) => ({ userId: x.user_id, name: x.full_name, allBranches: x.all_branches, branchIds: x.branch_ids })) };
    });
  }

  private async assertDriver(tx: Tx, driverUserId: string, branchId: string) {
    const m = (await tx.query(
      `SELECT m.id, m.all_branches, (SELECT count(*) FROM membership_branches mb WHERE mb.membership_id = m.id AND mb.branch_id = $2)::int AS has_branch
         FROM user_memberships m WHERE m.user_id = $1 AND m.status = 'active'
          AND EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = m.role_id AND rp.permission_code = 'delivery.execute')`, [driverUserId, branchId])).rows[0];
    if (!m) throw new AppError(422, 'NOT_A_DRIVER', 'That person is not an active driver');
    if (!m.all_branches && m.has_branch === 0) throw new AppError(422, 'DRIVER_BRANCH', 'That driver does not work at this branch');
  }

  // ------------------------------------------------------------------ tasks (staff)
  private view(r: any, opts: { otp?: string | null; forDriver?: boolean } = {}) {
    const base = {
      id: r.id, kind: r.kind, status: r.status, branchId: r.branch_id, orderId: r.order_id, orderNo: r.order_no ?? null, customerId: r.customer_id,
      customerName: r.customer_name, contactName: r.contact_name, contactPhone: r.contact_phone, address: r.address, notes: r.notes,
      windowStart: r.window_start, windowEnd: r.window_end, assignedTo: r.assigned_to, driverName: r.driver_name ?? null, attempts: r.attempts, bagCount: r.bag_count,
      failureReason: r.failure_reason, completedAt: r.completed_at, version: r.version,
      mapsUrl: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent([r.address.line1, r.address.city, r.address.province, r.address.postalCode].filter(Boolean).join(', '))}`,
    };
    // Why a delivery cannot be completed yet (drivers must not be able to hand over an unready or unpaid order).
    const blocked = r.kind === 'delivery' && ['assigned', 'en_route'].includes(r.status)
      ? (r.stage_status !== 'ready' ? 'The order is not ready for delivery yet' : N(r.order_balance) > 0 ? 'Payment is still due on this order' : null) : null;
    if (opts.forDriver) return { ...base, blockedReason: blocked, requiresProof: r.kind === 'delivery' };
    return { ...base, feeMinor: N(r.fee_minor), blockedReason: blocked, proof: r.proof, otp: opts.otp, otpAttempts: r.otp_attempts, zoneId: r.zone_id, createdAt: r.created_at };
  }

  @Post('delivery-tasks')
  @RequireAnyPermission('order.create', 'delivery.dispatch')
  book(@CurrentActor() a: Actor, @Body(new ZodPipe(bookingSchema)) b: z.infer<typeof bookingSchema>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      if (!canAccessBranch(a, b.branchId)) throw notFound('Branch');
      const br = (await tx.query(`SELECT status FROM branches WHERE id = $1`, [b.branchId])).rows[0];
      if (!br || br.status !== 'active') throw notFound('Branch');
      const c = (await tx.query(`SELECT full_name, phone, archived_at FROM customers WHERE id = $1`, [b.customerId])).rows[0];
      if (!c) throw notFound('Customer');
      if (c.archived_at) throw new AppError(422, 'CUSTOMER_ARCHIVED', 'This customer is archived');
      const ad = (await tx.query(`SELECT line1, line2, city, province, postal_code, delivery_instructions FROM customer_addresses WHERE id = $1 AND customer_id = $2`, [b.addressId, b.customerId])).rows[0];
      if (!ad) throw notFound('Address');
      const zone = await this.zones.resolve(tx, ad.postal_code);
      if (!zone) throw new AppError(422, 'OUT_OF_ZONE', 'We do not pick up from this address');
      const id = await this.tasks.create(tx, a, { branchId: b.branchId, kind: 'pickup', orderId: null, customerId: b.customerId, zoneId: zone.id, window: b.window,
        address: { line1: ad.line1, line2: ad.line2, city: ad.city, province: ad.province, postalCode: ad.postal_code, instructions: ad.delivery_instructions }, postalCode: ad.postal_code,
        contactName: c.full_name, contactPhone: c.phone, notes: b.notes ?? null, feeMinor: 0n });
      await this.audit.record(tx, a, { action: 'pickup.booked', entityType: 'delivery_task', entityId: id, branchId: b.branchId });
      return { id };
    });
  }

  @Get('delivery-tasks')
  @RequirePermission('delivery.dispatch')
  list(@CurrentActor() a: Actor, @Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const where: string[] = []; const p: unknown[] = [];
      const add = (sql: string, v: unknown) => { p.push(v); where.push(sql.replace('?', `$${p.length}`)); };
      if (q.status) add('t.status = ?', q.status); else if (!q.from && !q.to) where.push(`t.status IN ('requested','assigned','en_route','failed')`);
      if (q.kind) add('t.kind = ?', q.kind);
      if (q.branchId) add('t.branch_id = ?', q.branchId);
      if (q.assignedTo) add('t.assigned_to = ?', q.assignedTo);
      if (q.from) add('t.window_end >= ?', q.from);
      if (q.to) add('t.window_start < ?', q.to);
      p.push(q.limit);
      const r = await tx.query(`${TASK_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.window_start, t.id LIMIT $${p.length}`, p);
      return { items: r.rows.map((x) => this.view(x)) };
    });
  }

  /** Dispatchers see everything (including the delivery code to relay to the customer); a driver sees only their own task. */
  @Get('delivery-tasks/:id')
  @RequireAnyPermission('delivery.dispatch', 'delivery.execute')
  get(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const r = (await tx.query(`${TASK_SELECT} WHERE t.id = $1`, [id])).rows[0];
      if (!r) throw notFound('Task');
      if (!isDispatcher(a)) {
        if (r.assigned_to !== a.userId) throw notFound('Task');
        return this.view(r, { forDriver: true });
      }
      const events = (await tx.query(`SELECT e.type, e.note, e.payload, e.occurred_at, u.full_name AS actor FROM delivery_events e LEFT JOIN users u ON u.id = e.actor_user_id WHERE e.task_id = $1 ORDER BY e.occurred_at, e.id`, [id])).rows;
      return { ...this.view(r, { otp: r.status === 'completed' ? null : this.tasks.reveal(r.otp_enc) }),
        events: events.map((e) => ({ type: e.type, note: e.note, payload: e.payload, at: e.occurred_at, actor: e.actor })) };
    });
  }

  private async lock(tx: Tx, id: string) {
    const t = (await tx.query(`SELECT * FROM delivery_tasks WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!t) throw notFound('Task');
    return t;
  }

  @Post('delivery-tasks/:id/assign')
  @RequirePermission('delivery.dispatch')
  @HttpCode(200)
  assign(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(assignSchema)) b: z.infer<typeof assignSchema>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const t = await this.lock(tx, id);
      if (!['requested', 'assigned'].includes(t.status)) throw conflict('NOT_ASSIGNABLE', `A ${t.status} task cannot be assigned`);
      await this.assertDriver(tx, b.driverUserId, t.branch_id);
      await tx.query(`UPDATE delivery_tasks SET assigned_to = $2, assigned_at = now(), status = 'assigned', version = version + 1, updated_at = now() WHERE id = $1`, [id, b.driverUserId]);
      await this.tasks.event(tx, a, t, 'task.assigned', { driverUserId: b.driverUserId, previous: t.assigned_to });
      return { id, status: 'assigned' };
    });
  }

  @Post('delivery-tasks/:id/reschedule')
  @RequirePermission('delivery.dispatch')
  @HttpCode(200)
  reschedule(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(rescheduleSchema)) b: z.infer<typeof rescheduleSchema>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const t = await this.lock(tx, id);
      if (!['requested', 'assigned', 'failed'].includes(t.status)) throw conflict('NOT_RESCHEDULABLE', `A ${t.status} task cannot be rescheduled`);
      if (b.driverUserId) await this.assertDriver(tx, b.driverUserId, t.branch_id);
      const driver = b.driverUserId ?? (t.status === 'failed' ? null : t.assigned_to);
      await tx.query(`UPDATE delivery_tasks SET window_start = $2, window_end = $3, assigned_to = $4, assigned_at = CASE WHEN $4::uuid IS NULL THEN NULL ELSE now() END,
                      status = CASE WHEN $4::uuid IS NULL THEN 'requested' ELSE 'assigned' END, failure_reason = NULL, version = version + 1, updated_at = now() WHERE id = $1`,
        [id, b.window.start, b.window.end, driver]);
      await this.tasks.event(tx, a, t, 'task.rescheduled', { windowStart: b.window.start, windowEnd: b.window.end, driverUserId: driver });
      return { id, status: driver ? 'assigned' : 'requested' };
    });
  }

  @Post('delivery-tasks/:id/cancel')
  @RequirePermission('delivery.dispatch')
  @HttpCode(200)
  cancel(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(cancelSchema)) b: z.infer<typeof cancelSchema>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const t = await this.lock(tx, id);
      if (['completed', 'cancelled'].includes(t.status)) throw conflict('NOT_CANCELLABLE', `A ${t.status} task cannot be cancelled`);
      await tx.query(`UPDATE delivery_tasks SET status = 'cancelled', version = version + 1, updated_at = now() WHERE id = $1`, [id]);
      await this.tasks.event(tx, a, t, 'task.cancelled', {}, b.reason);
      await this.audit.record(tx, a, { action: 'delivery_task.cancelled', entityType: 'delivery_task', entityId: id, branchId: t.branch_id, detail: { reason: b.reason } });
      return { id, status: 'cancelled' };
    });
  }

  @Post('delivery-tasks/:id/otp/reset')
  @RequirePermission('delivery.dispatch')
  @HttpCode(200)
  resetOtp(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const t = await this.lock(tx, id);
      if (t.kind !== 'delivery' || ['completed', 'cancelled'].includes(t.status)) throw conflict('NO_OTP', 'This task has no active delivery code');
      const otp = this.tasks.newOtp();
      await tx.query(`UPDATE delivery_tasks SET otp_enc = $2, otp_attempts = 0, updated_at = now() WHERE id = $1`, [id, this.tasks.seal(otp)]);
      await this.tasks.event(tx, a, t, 'task.otp_reset');
      await this.audit.record(tx, a, { action: 'delivery_task.otp_reset', entityType: 'delivery_task', entityId: id, branchId: t.branch_id });
      return { id, otp };
    });
  }

  /** After a pickup is collected, staff create the order at the hub and attach it here. */
  @Post('delivery-tasks/:id/link-order')
  @RequireAnyPermission('order.create', 'delivery.dispatch')
  @HttpCode(200)
  link(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(linkSchema)) b: z.infer<typeof linkSchema>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const t = await this.lock(tx, id);
      if (t.kind !== 'pickup') throw conflict('NOT_A_PICKUP', 'Only pickups are linked to an order after collection');
      if (t.status !== 'completed') throw conflict('NOT_COLLECTED', 'The pickup has not been collected yet');
      if (t.order_id) throw conflict('ALREADY_LINKED', 'This pickup is already linked to an order');
      const o = (await tx.query(`SELECT id, customer_id, order_no FROM orders WHERE id = $1`, [b.orderId])).rows[0];
      if (!o) throw notFound('Order');
      if (o.customer_id !== t.customer_id) throw new AppError(422, 'CUSTOMER_MISMATCH', 'That order belongs to a different customer');
      await tx.query(`UPDATE delivery_tasks SET order_id = $2, version = version + 1, updated_at = now() WHERE id = $1`, [id, b.orderId]);
      await this.tasks.event(tx, a, t, 'task.order_linked', { orderId: b.orderId, orderNo: o.order_no });
      return { id, orderId: b.orderId };
    });
  }

  // ------------------------------------------------------------------ driver
  @Get('driver/tasks')
  @RequirePermission('delivery.execute')
  mine(@CurrentActor() a: Actor, @Query(new ZodPipe(driverQuery)) q: z.infer<typeof driverQuery>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const p: unknown[] = [a.userId]; let doneClause = 'false';
      if (q.from && q.to) { p.push(q.from, q.to); doneClause = `(t.status IN ('completed','failed') AND t.window_end >= $2 AND t.window_start < $3)`; }
      const r = await tx.query(`${TASK_SELECT} WHERE t.assigned_to = $1 AND (t.status IN ('assigned','en_route') OR ${doneClause}) ORDER BY t.window_start, t.id LIMIT 200`, p);
      return { items: r.rows.map((x) => this.view(x, { forDriver: true })) };
    });
  }

  private async myTask(tx: Tx, a: Actor, id: string) {
    const t = await this.lock(tx, id);
    if (t.assigned_to !== a.userId) throw notFound('Task'); // drivers never learn that other drivers' tasks exist
    return t;
  }

  @Post('delivery-tasks/:id/start')
  @RequirePermission('delivery.execute')
  @HttpCode(200)
  start(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const t = await this.myTask(tx, a, id);
      if (t.status === 'en_route') return { id, status: 'en_route' }; // idempotent
      if (t.status !== 'assigned') throw conflict('NOT_STARTABLE', `A ${t.status} task cannot be started`);
      await tx.query(`UPDATE delivery_tasks SET status = 'en_route', version = version + 1, updated_at = now() WHERE id = $1`, [id]);
      await this.tasks.event(tx, a, t, 'task.started');
      return { id, status: 'en_route' };
    });
  }

  @Post('delivery-tasks/:id/fail')
  @RequirePermission('delivery.execute')
  @HttpCode(200)
  fail(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(failSchema)) b: z.infer<typeof failSchema>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const t = await this.myTask(tx, a, id);
      if (!['assigned', 'en_route'].includes(t.status)) throw conflict('NOT_ACTIVE', `A ${t.status} task cannot be marked failed`);
      await tx.query(`UPDATE delivery_tasks SET status = 'failed', failure_reason = $2, attempts = attempts + 1, version = version + 1, updated_at = now() WHERE id = $1`, [id, b.reason]);
      await this.tasks.event(tx, a, t, 'task.failed', { reason: b.reason, attempt: t.attempts + 1 }, b.note);
      return { id, status: 'failed' };
    });
  }

  /**
   * Completes a pickup (bag count) or a delivery (proof: customer code, recipient name, or left at door).
   * A completed delivery also hands the order over. Wrong codes are counted even though the request is refused.
   */
  @Post('delivery-tasks/:id/complete')
  @RequirePermission('delivery.execute')
  @HttpCode(200)
  async complete(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(completeSchema)) b: z.infer<typeof completeSchema>) {
    const out = await this.db.withContext(dbCtx(a), async (tx): Promise<{ ok: true; body: any } | { ok: false; status: number; code: string; message: string }> => {
      const t = await this.myTask(tx, a, id);
      if (!['assigned', 'en_route'].includes(t.status)) throw conflict('NOT_ACTIVE', `A ${t.status} task cannot be completed`);

      if (t.kind === 'pickup') {
        if (!b.bagCount) throw new AppError(400, 'VALIDATION_ERROR', 'Enter how many bags you collected');
        await tx.query(`UPDATE delivery_tasks SET status = 'completed', completed_at = now(), bag_count = $2, version = version + 1, updated_at = now() WHERE id = $1`, [id, b.bagCount]);
        await this.tasks.event(tx, a, t, 'task.completed', { bagCount: b.bagCount }, b.note);
        return { ok: true, body: { id, status: 'completed', bagCount: b.bagCount } };
      }

      if (!b.proof) throw new AppError(400, 'VALIDATION_ERROR', 'Proof of delivery is required');
      const o = (await tx.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [t.order_id])).rows[0];
      const stages = await this.workflow.stages(tx, o.workflow_definition_id);
      const i = stages.findIndex((s) => s.id === o.current_stage_id);
      if (o.status === 'cancelled') throw conflict('ORDER_CANCELLED', 'This order was cancelled');
      if (stages[i]?.orderStatus !== 'ready' || !stages[i + 1]?.isTerminal) throw conflict('ORDER_NOT_READY', 'The order is not ready for delivery yet');
      if (Number(o.total_minor) - Number(o.paid_minor) > 0) throw conflict('BALANCE_DUE', 'Payment is still due on this order');

      if (b.proof.type === 'otp') {
        if (t.otp_attempts >= MAX_OTP_ATTEMPTS) return { ok: false, status: 409, code: 'OTP_LOCKED', message: 'Too many wrong codes. Ask dispatch to reset the delivery code.' };
        const expected = Buffer.from(this.tasks.reveal(t.otp_enc) ?? ''); const given = Buffer.from(b.proof.code);
        if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
          await tx.query(`UPDATE delivery_tasks SET otp_attempts = otp_attempts + 1 WHERE id = $1`, [id]);
          await this.tasks.event(tx, a, t, 'task.otp_failed', { attempt: t.otp_attempts + 1 });
          return { ok: false, status: 422, code: 'OTP_INVALID', message: `That code is not correct (${MAX_OTP_ATTEMPTS - t.otp_attempts - 1} tries left)` };
        }
      }
      const proof = b.proof.type === 'otp' ? { type: 'otp' } : b.proof;
      await tx.query(`UPDATE delivery_tasks SET status = 'completed', completed_at = now(), proof = $2, otp_enc = NULL, version = version + 1, updated_at = now() WHERE id = $1`, [id, JSON.stringify(proof)]);
      await this.tasks.event(tx, a, t, 'task.completed', { proof: proof.type }, b.note);
      // Hand the order over (same transition as the counter hand-over), attributed to the driver.
      const done = stages[i + 1];
      await tx.query(`UPDATE orders SET current_stage_id = $2, stage_entered_at = now(), status = $3, version = version + 1, updated_at = now() WHERE id = $1`, [o.id, done.id, done.orderStatus]);
      const ev = (type: string, payload: Record<string, unknown>) => tx.query(`INSERT INTO order_events (id, tenant_id, branch_id, order_id, type, actor_user_id, note, payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [uuidv7(), a.tenantId, o.branch_id, o.id, type, a.userId, b.note ?? null, JSON.stringify(payload)]);
      await ev('stage.changed', { from: stages[i].key, to: done.key, via: 'delivery' });
      await ev('order.handed_over', { via: 'delivery', proof: proof.type });
      await this.audit.record(tx, a, { action: 'order.handed_over', entityType: 'order', entityId: o.id, branchId: o.branch_id, detail: { via: 'delivery', taskId: id, proof: proof.type } });
      return { ok: true, body: { id, status: 'completed', orderStatus: done.orderStatus } };
    });
    if (!out.ok) throw new AppError(out.status, out.code, out.message);
    return out.body;
  }
}
