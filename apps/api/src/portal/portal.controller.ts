import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { Database, type Tx } from '@eazy/database';
import { AuditService } from '../audit/audit.service.js';
import { CustomerOnly } from '../common/access.js';
import { phone } from '../common/canada.js';
import { CurrentCustomer } from '../common/current-actor.js';
import { AppError, conflict, notFound } from '../common/errors.js';
import { uuidv7 } from '../common/ids.js';
import type { Actor, CustomerActor } from '../common/types.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { addressSchema } from '../customers/customers.controller.js';
import { DATABASE } from '../db/db.module.js';
import { TasksService, windowSchema } from '../logistics/tasks.service.js';
import { ZonesService } from '../logistics/zones.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { buildReceipt } from '../orders/orders.controller.js';

const profileSchema = z.object({ fullName: z.string().trim().min(2).max(120).optional(), phone: phone.nullable().optional() }).refine((v) => Object.keys(v).length > 0, 'Nothing to update');
const bookingSchema = z.object({ addressId: z.string().uuid(), window: windowSchema, notes: z.string().trim().max(500).optional(), branchId: z.string().uuid().optional() });
const MAX_OPEN_PICKUPS = 5;
const N = (v: unknown) => Number(v);

/** Customer-facing view of where an order is. Internal stages, rework and staff notes are never exposed. */
function progress(o: { status: string; stage_key: string | null }) {
  if (o.status === 'cancelled') return { step: 'cancelled', label: 'Cancelled' };
  if (o.status === 'completed') return { step: 'completed', label: 'Completed' };
  if (o.status === 'ready') return { step: 'ready', label: 'Ready' };
  return ['received', 'intake', null].includes(o.stage_key) ? { step: 'received', label: 'Received' } : { step: 'processing', label: 'Being cleaned' };
}

/** Customer sessions get a pseudo-actor only so shared services (tasks, audit) can record who did what. */
const asActor = (c: CustomerActor): Actor => ({ sessionId: c.sessionId, userId: c.customerId, tenantId: c.tenantId, mfaVerified: false, mustChangePassword: false, permissions: new Map(), allBranches: true, branchIds: [] });
const ctx = (c: CustomerActor) => ({ tenantId: c.tenantId, customerId: c.customerId, allBranches: true });

@Controller('portal')
export class PortalController {
  constructor(
    @Inject(DATABASE) private readonly db: Database, @Inject(AuditService) private readonly audit: AuditService, @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(ZonesService) private readonly zones: ZonesService, @Inject(NotificationsService) private readonly notify: NotificationsService,
  ) {}

  private async addresses(tx: Tx) {
    const r = await tx.query(`SELECT id, label, line1, line2, city, province, postal_code, delivery_instructions, is_default FROM customer_addresses ORDER BY is_default DESC, created_at`);
    return r.rows.map((x) => ({ id: x.id, label: x.label, line1: x.line1, line2: x.line2, city: x.city, province: x.province, postalCode: x.postal_code, deliveryInstructions: x.delivery_instructions, isDefault: x.is_default }));
  }

  @Get('me')
  @CustomerOnly()
  me(@CurrentCustomer() c: CustomerActor) {
    return this.db.withContext(ctx(c), async (tx) => {
      const cu = (await tx.query(`SELECT full_name, email, phone FROM customers WHERE id = $1`, [c.customerId])).rows[0];
      const brand = await this.notify.brand(tx);
      return { customer: { fullName: cu.full_name, email: cu.email, phone: cu.phone }, business: { name: brand.business, slug: brand.slug }, addresses: await this.addresses(tx) };
    });
  }

  @Patch('me')
  @CustomerOnly()
  update(@CurrentCustomer() c: CustomerActor, @Body(new ZodPipe(profileSchema)) b: z.infer<typeof profileSchema>) {
    return this.db.withContext(ctx(c), async (tx) => {
      const cur = (await tx.query(`SELECT full_name, phone FROM customers WHERE id = $1 FOR UPDATE`, [c.customerId])).rows[0];
      try {
        await tx.query('SAVEPOINT p');
        await tx.query(`UPDATE customers SET full_name = $2, phone = $3, version = version + 1, updated_at = now() WHERE id = $1`,
          [c.customerId, b.fullName ?? cur.full_name, b.phone === undefined ? cur.phone : b.phone]);
      } catch (e: any) { await tx.query('ROLLBACK TO SAVEPOINT p'); if (e.code === '23505') throw conflict('PHONE_UNAVAILABLE', 'That phone number cannot be used'); throw e; }
      return { ok: true };
    });
  }

  @Post('addresses')
  @CustomerOnly()
  addAddress(@CurrentCustomer() c: CustomerActor, @Body(new ZodPipe(addressSchema)) b: z.infer<typeof addressSchema>) {
    return this.db.withContext(ctx(c), async (tx) => {
      const id = uuidv7();
      const n = (await tx.query(`SELECT count(*)::int AS n FROM customer_addresses WHERE customer_id = $1`, [c.customerId])).rows[0].n;
      if (n >= 10) throw new AppError(409, 'TOO_MANY_ADDRESSES', 'You can save up to 10 addresses');
      const makeDefault = b.isDefault || n === 0;
      if (makeDefault) await tx.query(`UPDATE customer_addresses SET is_default = false WHERE customer_id = $1`, [c.customerId]);
      await tx.query(`INSERT INTO customer_addresses (id, tenant_id, customer_id, label, line1, line2, city, province, postal_code, delivery_instructions, is_default) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, c.tenantId, c.customerId, b.label, b.line1, b.line2 ?? null, b.city, b.province, b.postalCode, b.deliveryInstructions ?? null, makeDefault]);
      return { id };
    });
  }

  @Delete('addresses/:id')
  @CustomerOnly()
  @HttpCode(204)
  removeAddress(@CurrentCustomer() c: CustomerActor, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withContext(ctx(c), async (tx) => {
      const r = await tx.query(`DELETE FROM customer_addresses WHERE id = $1 AND customer_id = $2 RETURNING is_default`, [id, c.customerId]).catch((e) => { if (e.code === '23503') throw conflict('ADDRESS_IN_USE', 'This address is used by an open booking'); throw e; });
      if (!r.rowCount) throw notFound('Address');
      if (r.rows[0].is_default) await tx.query(`UPDATE customer_addresses SET is_default = true WHERE id = (SELECT id FROM customer_addresses WHERE customer_id = $1 ORDER BY created_at LIMIT 1)`, [c.customerId]);
    });
  }

  // ------------------------------------------------------------------ pickup bookings
  @Post('bookings')
  @CustomerOnly()
  book(@CurrentCustomer() c: CustomerActor, @Body(new ZodPipe(bookingSchema)) b: z.infer<typeof bookingSchema>) {
    return this.db.withContext(ctx(c), async (tx) => {
      const ad = (await tx.query(`SELECT line1, line2, city, province, postal_code, delivery_instructions FROM customer_addresses WHERE id = $1 AND customer_id = $2`, [b.addressId, c.customerId])).rows[0];
      if (!ad) throw notFound('Address');
      const open = (await tx.query(`SELECT count(*)::int AS n FROM delivery_tasks WHERE customer_id = $1 AND kind = 'pickup' AND status IN ('requested','assigned','en_route')`, [c.customerId])).rows[0].n;
      if (open >= MAX_OPEN_PICKUPS) throw new AppError(409, 'TOO_MANY_BOOKINGS', 'You already have several open pickups. Please wait for one to be collected or cancel one.');
      const zone = await this.zones.resolve(tx, ad.postal_code);
      if (!zone) throw new AppError(422, 'OUT_OF_ZONE', 'Sorry, we do not pick up from this address yet.');
      const branch = (await tx.query(`SELECT id FROM branches WHERE status = 'active' AND ($1::uuid IS NULL OR id = $1) ORDER BY created_at LIMIT 1`, [b.branchId ?? null])).rows[0];
      if (!branch) throw notFound('Branch');
      const cu = (await tx.query(`SELECT full_name, phone, email FROM customers WHERE id = $1`, [c.customerId])).rows[0];
      const { id } = await this.tasks.create(tx, asActor(c), { branchId: branch.id, kind: 'pickup', orderId: null, customerId: c.customerId, zoneId: zone.id, window: b.window,
        address: { line1: ad.line1, line2: ad.line2, city: ad.city, province: ad.province, postalCode: ad.postal_code, instructions: ad.delivery_instructions }, postalCode: ad.postal_code,
        contactName: cu.full_name, contactPhone: cu.phone, notes: b.notes ?? null, feeMinor: 0n });
      await this.audit.record(tx, { tenantId: c.tenantId, userId: c.customerId }, { action: 'portal.pickup_booked', entityType: 'delivery_task', entityId: id, branchId: branch.id });
      const brand = await this.notify.brand(tx);
      const win = (await tx.query(`SELECT to_char(($2::timestamptz AT TIME ZONE b.timezone), 'Mon DD HH24:MI') || '–' || to_char(($3::timestamptz AT TIME ZONE b.timezone), 'HH24:MI') AS t FROM branches b WHERE b.id = $1`, [branch.id, b.window.start, b.window.end])).rows[0].t;
      await this.notify.enqueue(tx, { tenantId: c.tenantId, customerId: c.customerId, taskId: id, to: cu.email, template: 'pickup.booked', dedupeKey: `pickup.booked:${id}`,
        vars: { name: cu.full_name, window: win, address: [ad.line1, ad.line2, ad.city, ad.province, ad.postal_code].filter(Boolean).join(', '), notes: b.notes ?? '', url: `${brand.base}/bookings` } });
      return { id };
    });
  }

  @Get('bookings')
  @CustomerOnly()
  bookings(@CurrentCustomer() c: CustomerActor) {
    return this.db.withContext(ctx(c), async (tx) => {
      const r = await tx.query(`SELECT t.id, t.status, t.window_start, t.window_end, t.address, t.notes, t.bag_count, t.order_id, o.order_no FROM delivery_tasks t LEFT JOIN orders o ON o.tenant_id = t.tenant_id AND o.id = t.order_id
                                 WHERE t.customer_id = $1 AND t.kind = 'pickup' ORDER BY t.window_start DESC LIMIT 50`, [c.customerId]);
      return { items: r.rows.map((x) => ({ id: x.id, status: x.status, windowStart: x.window_start, windowEnd: x.window_end, address: x.address, notes: x.notes, bagCount: x.bag_count, orderId: x.order_id, orderNo: x.order_no })) };
    });
  }

  @Post('bookings/:id/cancel')
  @CustomerOnly()
  @HttpCode(200)
  cancelBooking(@CurrentCustomer() c: CustomerActor, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withContext(ctx(c), async (tx) => {
      const t = (await tx.query(`SELECT id, branch_id, status FROM delivery_tasks WHERE id = $1 AND customer_id = $2 AND kind = 'pickup' FOR UPDATE`, [id, c.customerId])).rows[0];
      if (!t) throw notFound('Booking');
      if (!['requested', 'assigned'].includes(t.status)) throw conflict('NOT_CANCELLABLE', 'This pickup is already on its way or finished. Please call us to change it.');
      await tx.query(`UPDATE delivery_tasks SET status = 'cancelled', version = version + 1, updated_at = now() WHERE id = $1`, [id]);
      await this.tasks.event(tx, asActor(c), t, 'task.cancelled', { by: 'customer' }, 'Cancelled by the customer');
      return { id, status: 'cancelled' };
    });
  }

  // ------------------------------------------------------------------ orders
  @Get('orders')
  @CustomerOnly()
  orders(@CurrentCustomer() c: CustomerActor) {
    return this.db.withContext(ctx(c), async (tx) => {
      const r = await tx.query(
        `SELECT o.id, o.order_no, o.status, o.total_minor, o.paid_minor, o.promised_at, o.created_at, o.express, ws.key AS stage_key,
                (SELECT t.status FROM delivery_tasks t WHERE t.order_id = o.id AND t.kind = 'delivery' AND t.status <> 'cancelled' ORDER BY t.created_at DESC LIMIT 1) AS delivery_status
           FROM orders o LEFT JOIN workflow_stages ws ON ws.tenant_id = o.tenant_id AND ws.id = o.current_stage_id WHERE o.customer_id = $1 ORDER BY o.created_at DESC LIMIT 50`, [c.customerId]);
      return { items: r.rows.map((o) => ({ id: o.id, orderNo: o.order_no, progress: progress(o), totalMinor: N(o.total_minor), balanceMinor: N(o.total_minor) - N(o.paid_minor), promisedAt: o.promised_at, createdAt: o.created_at, express: o.express, deliveryStatus: o.delivery_status ?? null })) };
    });
  }

  @Get('orders/:id')
  @CustomerOnly()
  order(@CurrentCustomer() c: CustomerActor, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withContext(ctx(c), async (tx) => {
      const o = (await tx.query(`SELECT o.id, o.status, o.created_at, o.promised_at, ws.key AS stage_key FROM orders o LEFT JOIN workflow_stages ws ON ws.tenant_id = o.tenant_id AND ws.id = o.current_stage_id WHERE o.id = $1 AND o.customer_id = $2`, [id, c.customerId])).rows[0];
      if (!o) throw notFound('Order');
      const receipt = await buildReceipt(tx, id);
      const d = (await tx.query(`SELECT t.id, t.status, t.window_start, t.window_end, t.address, t.otp_enc FROM delivery_tasks t WHERE t.order_id = $1 AND t.kind = 'delivery' AND t.status <> 'cancelled' ORDER BY t.created_at DESC LIMIT 1`, [id])).rows[0];
      const ev = (await tx.query(`SELECT type, payload, occurred_at FROM order_events WHERE order_id = $1 AND type IN ('order.created','order.ready','order.handed_over') ORDER BY occurred_at`, [id])).rows;
      const dev = d ? (await tx.query(`SELECT type, occurred_at FROM delivery_events WHERE task_id = $1 AND type IN ('task.started','task.completed') ORDER BY occurred_at`, [d.id])).rows : [];
      const LABEL: Record<string, string> = { 'order.created': 'Order received', 'order.ready': 'Ready', 'order.handed_over': 'Completed', 'task.started': 'Driver is on the way', 'task.completed': 'Delivered' };
      const timeline = [...ev, ...dev].sort((a, b) => +new Date(a.occurred_at) - +new Date(b.occurred_at)).map((e) => ({ at: e.occurred_at, label: LABEL[e.type] }));
      const active = d && ['requested', 'assigned', 'en_route'].includes(d.status);
      return {
        id, progress: progress(o), timeline, receipt: { ...receipt, instructions: receipt.instructions },
        delivery: d ? { status: d.status, windowStart: d.window_start, windowEnd: d.window_end, city: d.address.city,
          // The customer's own code: they give it to the driver as proof of delivery. Shown only while the delivery is still active.
          code: active ? this.tasks.reveal(d.otp_enc) : null } : null,
      };
    });
  }
}
