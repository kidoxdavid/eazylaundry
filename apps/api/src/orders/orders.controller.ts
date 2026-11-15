import { Body, Controller, Get, Headers, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Database, type Tx } from '@eazy/database';
import { AuditService } from '../audit/audit.service.js';
import { RequirePermission } from '../common/access.js';
import { CurrentActor } from '../common/current-actor.js';
import { dbCtx } from '../common/db-context.js';
import { AppError, conflict, forbidden, notFound } from '../common/errors.js';
import { hashRequest, once, requireKey } from '../common/idempotency.js';
import { uuidv7 } from '../common/ids.js';
import type { Actor } from '../common/types.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { DATABASE } from '../db/db.module.js';
import { ConfigService } from '../config/config.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { TasksService, windowSchema } from '../logistics/tasks.service.js';
import { quoteSchema } from '../pricing/pricing.controller.js';
import { WorkflowService, newScanToken } from '../production/workflow.service.js';
import { PricingService } from '../pricing/pricing.service.js';

const paymentSchema = z.object({
  method: z.enum(['cash', 'card_external', 'e_transfer', 'other']),
  amountMinor: z.number().int().min(1).max(1_000_000_00),
  tenderedMinor: z.number().int().min(1).max(1_000_000_00).optional(),
  reference: z.string().trim().max(100).optional(),
});
const createSchema = quoteSchema.extend({
  customerId: z.string().uuid(),
  instructions: z.string().trim().max(1000).optional(),
  payment: paymentSchema.optional(),
  /** Required when deliveryAddressId is set: when the customer wants it delivered. */
  deliveryWindow: windowSchema.optional(),
}).refine((v) => !!v.deliveryAddressId === !!v.deliveryWindow, { path: ['deliveryWindow'], message: 'Choose a delivery address and a delivery window together' });
const listQuery = z.object({
  status: z.enum(['open', 'ready', 'completed', 'cancelled']).optional(), branchId: z.string().uuid().optional(), customerId: z.string().uuid().optional(),
  q: z.string().trim().max(60).optional(), unpaid: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30), offset: z.coerce.number().int().min(0).max(10_000).default(0),
});
const cancelSchema = z.object({ reason: z.string().trim().min(3).max(300) });

const escapeLike = (s: string) => s.split('\\').join('\\\\').split('%').join('\\%').split('_').join('\\_');
const N = (v: unknown) => Number(v);
const paymentStatus = (r: any) => (N(r.paid_minor) === 0 ? 'unpaid' : N(r.paid_minor) >= N(r.total_minor) ? 'paid' : 'partial');
export const mapOrder = (r: any) => ({
  stageKey: r.stage_key ?? null, stageName: r.stage_name ?? null, reworkCount: r.rework_count ?? 0, stageEnteredAt: r.stage_entered_at ?? null,
  deliveryFeeMinor: N(r.delivery_fee_minor ?? 0), id: r.id, orderNo: r.order_no, branchId: r.branch_id, customerId: r.customer_id, customerName: r.customer_name, status: r.status, express: r.express,
  currency: r.currency, priceMode: r.price_mode, subtotalMinor: N(r.subtotal_minor), discountMinor: N(r.discount_minor), netMinor: N(r.net_minor),
  taxMinor: N(r.tax_minor), totalMinor: N(r.total_minor), paidMinor: N(r.paid_minor), balanceMinor: N(r.total_minor) - N(r.paid_minor), paymentStatus: paymentStatus(r),
  instructions: r.instructions, promisedAt: r.promised_at, cancelledReason: r.cancelled_reason, version: r.version, createdAt: r.created_at,
});
const mapLine = (r: any) => ({
  lineNo: r.line_no, serviceId: r.service_id, code: r.service_code, name: r.service_name, pricingModel: r.pricing_model, quantity: r.quantity, weightG: r.weight_g,
  unitPriceMinor: N(r.unit_price_minor), baseMinor: N(r.base_minor), minChargeApplied: r.min_charge_applied, expressMinor: N(r.express_minor), discountMinor: N(r.discount_minor),
  netMinor: N(r.net_minor), taxMinor: N(r.tax_minor), totalMinor: N(r.total_minor), taxBreakdown: Object.fromEntries(Object.entries(r.tax_breakdown ?? {}).map(([k, v]) => [k, N(v)])),
});
const mapPayment = (r: any) => ({ id: r.id, method: r.method, amountMinor: N(r.amount_minor), tenderedMinor: r.tendered_minor === null ? null : N(r.tendered_minor),
  changeMinor: N(r.change_minor), reference: r.reference, receivedAt: r.received_at, receivedBy: r.received_by });

/** Order with customer name and current stage, under the caller's RLS context (throws 404 when invisible). */
export async function loadOrder(tx: Tx, id: string) {
  const o = (await tx.query(
    `SELECT o.*, c.full_name AS customer_name, ws.key AS stage_key, ws.name AS stage_name FROM orders o
       JOIN customers c ON c.tenant_id = o.tenant_id AND c.id = o.customer_id
       LEFT JOIN workflow_stages ws ON ws.tenant_id = o.tenant_id AND ws.id = o.current_stage_id WHERE o.id = $1`, [id])).rows[0];
  if (!o) throw notFound('Order');
  return o;
}

@Controller('orders')
export class OrdersController {
  constructor(@Inject(DATABASE) private readonly db: Database, @Inject(AuditService) private readonly audit: AuditService,
              @Inject(PricingService) private readonly pricing: PricingService, @Inject(WorkflowService) private readonly workflow: WorkflowService,
              @Inject(ConfigService) private readonly cfg: ConfigService,
              @Inject(TasksService) private readonly tasks: TasksService, @Inject(NotificationsService) private readonly notify: NotificationsService) {}

  private async event(tx: Tx, a: Actor, order: { id: string; branch_id: string }, type: string, payload: Record<string, unknown> = {}, note?: string) {
    await tx.query(`INSERT INTO order_events (id, tenant_id, branch_id, order_id, type, actor_user_id, note, payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [uuidv7(), a.tenantId, order.branch_id, order.id, type, a.userId, note ?? null, JSON.stringify(payload)]);
  }

  /** Records a payment against an order inside the caller's transaction. The order row is locked, so concurrent payments serialise. */
  private async applyPayment(tx: Tx, a: Actor, orderId: string, p: z.infer<typeof paymentSchema>) {
    const o = (await tx.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId])).rows[0];
    if (!o) throw notFound('Order');
    if (o.status === 'cancelled') throw conflict('ORDER_CANCELLED', 'This order is cancelled');
    const balance = N(o.total_minor) - N(o.paid_minor);
    if (balance <= 0) throw conflict('ALREADY_PAID', 'This order is already fully paid');
    if (p.amountMinor > balance) throw new AppError(422, 'OVERPAYMENT', 'The payment is more than the balance due');
    let tendered: number | null = null; let change = 0;
    if (p.method === 'cash') {
      tendered = p.tenderedMinor ?? p.amountMinor;
      if (tendered < p.amountMinor) throw new AppError(422, 'TENDERED_TOO_LOW', 'The cash handed over is less than the amount being paid');
      change = tendered - p.amountMinor;
    } else if (p.tenderedMinor !== undefined) {
      throw new AppError(422, 'TENDERED_NOT_APPLICABLE', 'Tendered amount only applies to cash');
    }
    // Cash goes into the receiving user's open till at this branch. Whether a till is mandatory is a business setting.
    let shiftId: string | null = null;
    if (p.method === 'cash') {
      shiftId = (await tx.query(`SELECT id FROM cash_shifts WHERE branch_id = $1 AND opened_by = $2 AND status = 'open'`, [o.branch_id, a.userId])).rows[0]?.id ?? null;
      if (!shiftId && (await this.cfg.resolve(tx, a.tenantId!, 'cash.require_shift', o.branch_id)).value) {
        throw conflict('SHIFT_REQUIRED', 'Open your till before taking cash');
      }
    }
    const paymentId = uuidv7();
    await tx.query(`INSERT INTO payments (id, tenant_id, branch_id, method, amount_minor, tendered_minor, change_minor, currency, reference, received_by, shift_id)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [paymentId, a.tenantId, o.branch_id, p.method, p.amountMinor, tendered, change, o.currency, p.reference ?? null, a.userId, shiftId]);
    await tx.query(`INSERT INTO payment_allocations (id, tenant_id, branch_id, payment_id, order_id, amount_minor) VALUES ($1,$2,$3,$4,$5,$6)`,
      [uuidv7(), a.tenantId, o.branch_id, paymentId, orderId, p.amountMinor]);
    await tx.query(`UPDATE orders SET paid_minor = paid_minor + $2, version = version + 1, updated_at = now() WHERE id = $1`, [orderId, p.amountMinor]);
    await this.event(tx, a, o, 'payment.recorded', { paymentId, method: p.method, amountMinor: p.amountMinor, changeMinor: change });
    await this.audit.record(tx, a, { action: 'payment.recorded', entityType: 'order', entityId: orderId, branchId: o.branch_id,
      detail: { paymentId, method: p.method, amountMinor: p.amountMinor } });
    return { paymentId, changeMinor: change, balanceMinor: balance - p.amountMinor };
  }

  @Post()
  @RequirePermission('order.create')
  create(@CurrentActor() a: Actor, @Headers('idempotency-key') idem: string | undefined, @Body(new ZodPipe(createSchema)) b: z.infer<typeof createSchema>) {
    const key = requireKey(idem);
    if (b.payment && !a.permissions.has('payment.take')) throw forbidden('PERMISSION_DENIED', 'Missing permission: payment.take');
    return this.db.withContext(dbCtx(a), async (tx) => {
      const { replayed, response } = await once(tx, a.tenantId!, 'order.create', key, hashRequest(b), async () => {
        const cust = (await tx.query(`SELECT id, archived_at, email, full_name FROM customers WHERE id = $1`, [b.customerId])).rows[0];
        if (!cust) throw notFound('Customer');
        if (cust.archived_at) throw new AppError(422, 'CUSTOMER_ARCHIVED', 'This customer is archived');

        const ctx = await this.pricing.quote(tx, a, b);
        const q = ctx.quote;
        if (b.payment && b.payment.amountMinor > Number(q.totalMinor)) throw new AppError(422, 'OVERPAYMENT', 'The payment is more than the order total');

        const br = (await tx.query(`SELECT code, to_char((now() AT TIME ZONE timezone), 'YYMM') AS period FROM branches WHERE id = $1`, [b.branchId])).rows[0];
        const seq = (await tx.query(
          `INSERT INTO order_counters (tenant_id, branch_id, period, last_value) VALUES ($1,$2,$3,1)
           ON CONFLICT (tenant_id, branch_id, period) DO UPDATE SET last_value = order_counters.last_value + 1 RETURNING last_value`, [a.tenantId, b.branchId, br.period])).rows[0].last_value;
        const orderNo = `${br.code}-${br.period}-${String(seq).padStart(5, '0')}`;

        // Promised time: longest service turnaround; express is capped at 24h. (Business hours/holidays arrive with the workflow engine.)
        const hours = Math.max(...q.lines.map((l) => { const t = ctx.services.get(l.serviceId)!.turnaroundHours; return l.expressMinor > 0n || (q.express && ctx.services.get(l.serviceId)!.expressCapable) ? Math.min(t, 24) : t; }));
        const id = uuidv7();
        const wf = await this.workflow.ensureDefault(tx, a.tenantId!);
        // The scan token is the opaque value printed on labels. Retry on the (astronomically rare) collision.
        for (let attempt = 0; ; attempt++) {
          try {
            await tx.query('SAVEPOINT ord');
            await tx.query(
              `INSERT INTO orders (id, tenant_id, branch_id, order_no, customer_id, express, currency, price_mode, subtotal_minor, discount_minor, net_minor, tax_minor, total_minor,
                                   instructions, promised_at, created_by, workflow_definition_id, current_stage_id, scan_token,
                                   delivery_fee_minor, delivery_fee_tax_minor, delivery_fee_tax_breakdown)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now() + make_interval(hours => $15), $16, $17, $18, $19, $20, $21, $22)`,
              [id, a.tenantId, b.branchId, orderNo, b.customerId, q.express, ctx.currency, q.priceMode, q.subtotalMinor, q.discountMinor, q.netMinor, q.taxMinor, q.totalMinor,
               b.instructions ?? null, hours, a.userId, wf.definitionId, wf.stages[0].id, newScanToken(),
               q.fee?.amountMinor ?? 0n, q.fee?.taxMinor ?? 0n, JSON.stringify(Object.fromEntries(Object.entries(q.fee?.taxByComponent ?? {}).map(([k, v]) => [k, Number(v)])))]);
            break;
          } catch (e: any) {
            await tx.query('ROLLBACK TO SAVEPOINT ord');
            if (e.code === '23505' && /scan_token/.test(e.constraint ?? '') && attempt < 5) continue;
            throw e;
          }
        }
        let n = 0;
        for (const l of q.lines) {
          await tx.query(
            `INSERT INTO order_lines (id, tenant_id, branch_id, order_id, line_no, service_id, price_id, service_code, service_name, pricing_model, quantity, weight_g, unit_price_minor,
                                      base_minor, min_charge_applied, express_minor, discount_minor, net_minor, tax_minor, total_minor, tax_breakdown, turnaround_hours)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
            [uuidv7(), a.tenantId, b.branchId, id, ++n, l.serviceId, l.priceId, l.code, l.name, l.pricingModel, l.quantity, l.weightG, l.unitPriceMinor, l.baseMinor, l.minChargeApplied,
             l.expressMinor, l.discountMinor, l.netMinor, l.taxMinor, l.totalMinor, JSON.stringify(Object.fromEntries(Object.entries(l.taxByComponent).map(([k, v]) => [k, Number(v)]))),
             ctx.services.get(l.serviceId)!.turnaroundHours]);
        }
        let deliveryTaskId: string | null = null; let deliveryOtp: string | null = null;
        if (ctx.delivery) {
          const cust = (await tx.query(`SELECT full_name, phone, (SELECT 1 FROM customer_addresses WHERE id = $2 AND customer_id = $1) AS owns FROM customers WHERE id = $1`, [b.customerId, b.deliveryAddressId])).rows[0];
          if (!cust.owns) throw new AppError(422, 'ADDRESS_NOT_CUSTOMERS', 'That address does not belong to this customer');
          const created = await this.tasks.create(tx, a, { branchId: b.branchId, kind: 'delivery', orderId: id, customerId: b.customerId, zoneId: ctx.delivery.zoneId,
            window: b.deliveryWindow!, address: ctx.delivery.address, postalCode: ctx.delivery.postalCode, contactName: cust.full_name, contactPhone: cust.phone, notes: null, feeMinor: ctx.delivery.feeMinor });
          deliveryTaskId = created.id; deliveryOtp = created.otp;
        }
        await this.event(tx, a, { id, branch_id: b.branchId }, 'order.created', { orderNo, totalMinor: Number(q.totalMinor), lines: q.lines.length });
        await this.audit.record(tx, a, { action: 'order.created', entityType: 'order', entityId: id, branchId: b.branchId, detail: { orderNo, totalMinor: Number(q.totalMinor) } });
        const brand = await this.notify.brand(tx);
        const tz = (await tx.query(`SELECT to_char((o.promised_at AT TIME ZONE br.timezone), 'Mon DD HH24:MI') AS ready_by,
                                           to_char(($2::timestamptz AT TIME ZONE br.timezone), 'Mon DD HH24:MI') || '–' || to_char(($3::timestamptz AT TIME ZONE br.timezone), 'HH24:MI') AS win
                                      FROM orders o JOIN branches br ON br.id = o.branch_id WHERE o.id = $1`, [id, b.deliveryWindow?.start ?? null, b.deliveryWindow?.end ?? null])).rows[0];
        await this.notify.enqueue(tx, { tenantId: a.tenantId!, customerId: b.customerId, orderId: id, to: cust.email, template: 'order.received', dedupeKey: `order.received:${id}`,
          vars: { name: cust.full_name, orderNo, totalMinor: Number(q.totalMinor), readyBy: tz.ready_by, url: `${brand.base}/orders/${id}` } });
        if (ctx.delivery && deliveryOtp) {
          const ad = ctx.delivery.address as any;
          await this.notify.enqueue(tx, { tenantId: a.tenantId!, customerId: b.customerId, orderId: id, taskId: deliveryTaskId!, to: cust.email, template: 'delivery.scheduled', dedupeKey: `delivery.scheduled:${deliveryTaskId}`,
            vars: { name: cust.full_name, orderNo, window: tz.win, address: [ad.line1, ad.line2, ad.city, ad.province, ad.postalCode].filter(Boolean).join(', '), code: deliveryOtp, url: `${brand.base}/orders/${id}` } });
        }
        const pay = b.payment ? await this.applyPayment(tx, a, id, b.payment) : null;
        return { id, orderNo, totalMinor: Number(q.totalMinor), paidMinor: pay ? b.payment!.amountMinor : 0, changeMinor: pay?.changeMinor ?? 0, deliveryTaskId };
      });
      return { ...response, replayed };
    });
  }

  @Get()
  @RequirePermission('order.read')
  list(@CurrentActor() a: Actor, @Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const where: string[] = []; const p: unknown[] = [];
      const add = (sql: string, v: unknown) => { p.push(v); where.push(sql.replace('?', `$${p.length}`)); };
      if (q.status) add('o.status = ?', q.status);
      if (q.branchId) add('o.branch_id = ?', q.branchId);
      if (q.customerId) add('o.customer_id = ?', q.customerId);
      if (q.unpaid === 'true') where.push(`o.status <> 'cancelled' AND o.paid_minor < o.total_minor`);
      if (q.q) {
        p.push(`%${escapeLike(q.q)}%`);
        where.push(`(o.order_no ILIKE $${p.length} OR c.full_name ILIKE $${p.length})`);
      }
      p.push(q.limit, q.offset);
      const r = await tx.query(
        `SELECT o.*, c.full_name AS customer_name, ws.key AS stage_key, ws.name AS stage_name FROM orders o JOIN customers c ON c.tenant_id = o.tenant_id AND c.id = o.customer_id LEFT JOIN workflow_stages ws ON ws.tenant_id = o.tenant_id AND ws.id = o.current_stage_id
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.created_at DESC, o.id DESC LIMIT $${p.length - 1} OFFSET $${p.length}`, p);
      return { items: r.rows.map(mapOrder) };
    });
  }

  load(tx: Tx, id: string) { return loadOrder(tx, id); }

  @Get(':id')
  @RequirePermission('order.read')
  get(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const o = await this.load(tx, id);
      const lines = await tx.query(`SELECT * FROM order_lines WHERE order_id = $1 ORDER BY line_no`, [id]);
      const pays = await tx.query(`SELECT p.* FROM payments p JOIN payment_allocations pa ON pa.tenant_id = p.tenant_id AND pa.payment_id = p.id WHERE pa.order_id = $1 ORDER BY p.received_at`, [id]);
      const events = await tx.query(`SELECT id, type, actor_user_id, note, payload, occurred_at FROM order_events WHERE order_id = $1 ORDER BY occurred_at, id`, [id]);
      const dt = (await tx.query(`SELECT t.id, t.status, t.window_start, t.window_end, t.fee_minor, t.attempts, u.full_name AS driver_name FROM delivery_tasks t LEFT JOIN users u ON u.id = t.assigned_to
                                   WHERE t.order_id = $1 AND t.kind = 'delivery' ORDER BY t.created_at DESC LIMIT 1`, [id])).rows[0];
      const refunds = (await tx.query(`SELECT id, payment_id, method, amount_minor, reference, refunded_at FROM refunds WHERE order_id = $1 ORDER BY refunded_at`, [id])).rows;
      const refundedFor = (pid: string) => refunds.filter((r) => r.payment_id === pid).reduce((n, r) => n + N(r.amount_minor), 0);
      return { ...mapOrder(o), lines: lines.rows.map(mapLine),
        delivery: dt ? { id: dt.id, status: dt.status, windowStart: dt.window_start, windowEnd: dt.window_end, feeMinor: N(dt.fee_minor), attempts: dt.attempts, driverName: dt.driver_name } : null,
        payments: pays.rows.map((p) => ({ ...mapPayment(p), refundedMinor: refundedFor(p.id), refundableMinor: N(p.amount_minor) - refundedFor(p.id) })),
        refunds: refunds.map((r) => ({ id: r.id, paymentId: r.payment_id, method: r.method, amountMinor: N(r.amount_minor), reference: r.reference, refundedAt: r.refunded_at })),
        events: events.rows.map((e) => ({ id: e.id, type: e.type, actorUserId: e.actor_user_id, note: e.note, payload: e.payload, occurredAt: e.occurred_at })) };
    });
  }

  @Post(':id/payments')
  @RequirePermission('payment.take')
  pay(@CurrentActor() a: Actor, @Headers('idempotency-key') idem: string | undefined, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(paymentSchema)) b: z.infer<typeof paymentSchema>) {
    const key = requireKey(idem);
    return this.db.withContext(dbCtx(a), async (tx) => {
      if (!(await tx.query(`SELECT 1 FROM orders WHERE id = $1`, [id])).rowCount) throw notFound('Order');
      const { replayed, response } = await once(tx, a.tenantId!, `payment:${id}`, key, hashRequest(b), () => this.applyPayment(tx, a, id, b));
      return { ...response, replayed };
    });
  }

  @Post(':id/cancel')
  @RequirePermission('order.cancel')
  cancel(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(cancelSchema)) b: z.infer<typeof cancelSchema>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const o = (await tx.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!o) throw notFound('Order');
      if (o.status !== 'open') throw conflict('NOT_CANCELLABLE', `A ${o.status} order cannot be cancelled`);
      if (N(o.paid_minor) > 0) throw conflict('REFUND_REQUIRED', 'This order has payments. Refund them before cancelling.');
      await tx.query(`UPDATE orders SET status = 'cancelled', cancelled_reason = $2, version = version + 1, updated_at = now() WHERE id = $1`, [id, b.reason]);
      await this.event(tx, a, o, 'order.cancelled', {}, b.reason);
      await this.audit.record(tx, a, { action: 'order.cancelled', entityType: 'order', entityId: id, branchId: o.branch_id, detail: { reason: b.reason } });
      return { id, status: 'cancelled' };
    });
  }

  /** Structured receipt data. Rendering (80mm print / email) is a presentation concern. */
  @Get(':id/receipt')
  @RequirePermission('order.read')
  receipt(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withContext(dbCtx(a), (tx) => buildReceipt(tx, id));
  }
}

/** Receipt data for an order visible to the caller's RLS context (staff, or a customer's own order in the portal). */
export async function buildReceipt(tx: Tx, id: string) {
      const o = await loadOrder(tx, id);
      const lines = (await tx.query(`SELECT * FROM order_lines WHERE order_id = $1 ORDER BY line_no`, [id])).rows.map(mapLine);
      const pays = (await tx.query(`SELECT p.* FROM payments p JOIN payment_allocations pa ON pa.tenant_id = p.tenant_id AND pa.payment_id = p.id WHERE pa.order_id = $1 ORDER BY p.received_at`, [id])).rows.map(mapPayment);
      const br = (await tx.query(`SELECT b.name, b.address, b.timezone, to_char(($2::timestamptz AT TIME ZONE b.timezone), 'YYYY-MM-DD HH24:MI') AS local_time,
                                         to_char(($3::timestamptz AT TIME ZONE b.timezone), 'YYYY-MM-DD HH24:MI') AS promised_local, org.legal_name
                                    FROM branches b JOIN organizations org ON org.tenant_id = b.tenant_id WHERE b.id = $1`, [o.branch_id, o.created_at, o.promised_at])).rows[0];
      const taxByComponent: Record<string, number> = {};
      for (const l of lines) for (const [k, v] of Object.entries(l.taxBreakdown)) taxByComponent[k] = (taxByComponent[k] ?? 0) + (v as number);
      for (const [k, v] of Object.entries(o.delivery_fee_tax_breakdown ?? {})) taxByComponent[k] = (taxByComponent[k] ?? 0) + Number(v);
      const m = mapOrder(o);
      return { business: br.legal_name, branch: br.name, address: br.address, orderNo: m.orderNo, dateLocal: br.local_time, timezone: br.timezone, customerName: m.customerName,
        express: m.express, currency: m.currency, priceMode: m.priceMode, lines, subtotalMinor: m.subtotalMinor, deliveryFeeMinor: m.deliveryFeeMinor, discountMinor: m.discountMinor, taxByComponent, taxMinor: m.taxMinor,
        totalMinor: m.totalMinor, payments: pays, paidMinor: m.paidMinor, balanceMinor: m.balanceMinor, promisedAt: m.promisedAt, promisedLocal: br.promised_local, instructions: m.instructions, status: m.status };
}
