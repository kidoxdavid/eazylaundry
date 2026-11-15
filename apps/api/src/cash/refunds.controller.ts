import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Database, type Tx } from '@eazy/database';
import { AuditService } from '../audit/audit.service.js';
import { RequirePermission } from '../common/access.js';
import { CurrentActor } from '../common/current-actor.js';
import { dbCtx } from '../common/db-context.js';
import { AppError, conflict, forbidden, notFound } from '../common/errors.js';
import { uuidv7 } from '../common/ids.js';
import type { Actor } from '../common/types.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ConfigService } from '../config/config.service.js';
import { DATABASE } from '../db/db.module.js';

const requestSchema = z.object({ paymentId: z.string().uuid(), amountMinor: z.number().int().min(1).max(1_000_000_00), reason: z.string().trim().min(3).max(300) });
const decideSchema = z.object({ note: z.string().trim().max(300).optional() });
const rejectSchema = z.object({ note: z.string().trim().min(3).max(300) });
const completeSchema = z.object({ reference: z.string().trim().max(100).optional() });
const listQuery = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'completed']).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });

const N = (v: unknown) => Number(v);
const canApprove = (a: Actor) => a.permissions.has('payment.refund.approve');
const mapReq = (r: any) => ({ id: r.id, orderId: r.order_id, orderNo: r.order_no, customerName: r.customer_name, paymentId: r.payment_id, method: r.method, amountMinor: N(r.amount_minor),
  reason: r.reason, status: r.status, requestedBy: r.requested_by, requestedAt: r.requested_at, decidedBy: r.decided_by, decidedAt: r.decided_at, decisionNote: r.decision_note, completedAt: r.completed_at });

/** Refund workflow: request -> approve (within the approver's amount limit) -> complete (cash leaves a till). Always linked to the original payment. */
@Controller()
export class RefundsController {
  constructor(@Inject(DATABASE) private readonly db: Database, @Inject(AuditService) private readonly audit: AuditService, @Inject(ConfigService) private readonly cfg: ConfigService) {}

  private async event(tx: Tx, a: Actor, o: { id: string; branch_id: string }, type: string, payload: Record<string, unknown>, note?: string) {
    await tx.query(`INSERT INTO order_events (id, tenant_id, branch_id, order_id, type, actor_user_id, note, payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [uuidv7(), a.tenantId, o.branch_id, o.id, type, a.userId, note ?? null, JSON.stringify(payload)]);
  }

  /** How much of a payment can still be refunded, counting completed refunds and other live (pending/approved) requests. */
  private async refundable(tx: Tx, paymentId: string, excludeRequestId?: string) {
    const p = (await tx.query(`SELECT amount_minor FROM payments WHERE id = $1`, [paymentId])).rows[0];
    const done = N((await tx.query(`SELECT coalesce(sum(amount_minor),0) AS s FROM refunds WHERE payment_id = $1`, [paymentId])).rows[0].s);
    const live = N((await tx.query(`SELECT coalesce(sum(amount_minor),0) AS s FROM refund_requests WHERE payment_id = $1 AND status IN ('pending','approved') AND ($2::uuid IS NULL OR id <> $2)`, [paymentId, excludeRequestId ?? null])).rows[0].s);
    return N(p.amount_minor) - done - live;
  }

  private checkLimit(a: Actor, amount: number) {
    const limit = a.permissions.get('payment.refund.approve');
    if (limit !== null && limit !== undefined && amount > limit) throw forbidden('REFUND_LIMIT_EXCEEDED', 'This refund is above your approval limit');
  }

  @Post('orders/:id/refund-requests')
  @RequirePermission('payment.refund.request')
  request(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(requestSchema)) b: z.infer<typeof requestSchema>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const o = (await tx.query(`SELECT id, branch_id, order_no FROM orders WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!o) throw notFound('Order');
      const link = (await tx.query(`SELECT 1 FROM payment_allocations WHERE order_id = $1 AND payment_id = $2`, [id, b.paymentId])).rowCount;
      if (!link) throw notFound('Payment');
      const room = await this.refundable(tx, b.paymentId);
      if (b.amountMinor > room) throw new AppError(422, 'REFUND_EXCEEDS_PAYMENT', `At most ${room} (minor units) can still be refunded on this payment`);
      // A requester who may approve this amount (e.g. the owner) is approved immediately, and the decision is still recorded.
      const selfApprove = canApprove(a) && (() => { const l = a.permissions.get('payment.refund.approve'); return l === null || l === undefined || b.amountMinor <= l; })();
      const rid = uuidv7();
      await tx.query(`INSERT INTO refund_requests (id, tenant_id, branch_id, order_id, payment_id, amount_minor, reason, status, requested_by, decided_by, decided_at)
                      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, ${selfApprove ? 'now()' : 'NULL'})`,
        [rid, a.tenantId, o.branch_id, id, b.paymentId, b.amountMinor, b.reason, selfApprove ? 'approved' : 'pending', a.userId, selfApprove ? a.userId : null]);
      await this.event(tx, a, o, 'refund.requested', { requestId: rid, amountMinor: b.amountMinor, autoApproved: selfApprove }, b.reason);
      await this.audit.record(tx, a, { action: 'refund.requested', entityType: 'order', entityId: id, branchId: o.branch_id, detail: { requestId: rid, amountMinor: b.amountMinor, autoApproved: selfApprove } });
      return { id: rid, status: selfApprove ? 'approved' : 'pending' };
    });
  }

  @Get('refund-requests')
  @RequirePermission('payment.refund.request')
  list(@CurrentActor() a: Actor, @Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const p: unknown[] = []; const where: string[] = [];
      if (q.status) { p.push(q.status); where.push(`r.status = $${p.length}`); }
      if (!canApprove(a)) { p.push(a.userId); where.push(`r.requested_by = $${p.length}`); }
      p.push(q.limit);
      const rows = (await tx.query(
        `SELECT r.*, o.order_no, c.full_name AS customer_name, pay.method FROM refund_requests r
           JOIN orders o ON o.tenant_id = r.tenant_id AND o.id = r.order_id JOIN customers c ON c.tenant_id = o.tenant_id AND c.id = o.customer_id
           JOIN payments pay ON pay.tenant_id = r.tenant_id AND pay.id = r.payment_id
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.requested_at DESC LIMIT $${p.length}`, p)).rows;
      return { items: rows.map(mapReq) };
    });
  }

  private async lockRequest(tx: Tx, id: string) {
    const r = (await tx.query(`SELECT * FROM refund_requests WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!r) throw notFound('Refund request');
    return r;
  }

  @Post('refund-requests/:id/approve')
  @RequirePermission('payment.refund.approve')
  @HttpCode(200)
  approve(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(decideSchema)) b: z.infer<typeof decideSchema>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const r = await this.lockRequest(tx, id);
      if (r.status !== 'pending') throw conflict('NOT_PENDING', `This request is already ${r.status}`);
      this.checkLimit(a, N(r.amount_minor));
      await tx.query(`UPDATE refund_requests SET status = 'approved', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1`, [id, a.userId, b.note ?? null]);
      await this.audit.record(tx, a, { action: 'refund.approved', entityType: 'refund_request', entityId: id, branchId: r.branch_id, detail: { amountMinor: N(r.amount_minor), requestedBy: r.requested_by } });
      return { id, status: 'approved' };
    });
  }

  @Post('refund-requests/:id/reject')
  @RequirePermission('payment.refund.approve')
  @HttpCode(200)
  reject(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(rejectSchema)) b: z.infer<typeof rejectSchema>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const r = await this.lockRequest(tx, id);
      if (r.status !== 'pending') throw conflict('NOT_PENDING', `This request is already ${r.status}`);
      await tx.query(`UPDATE refund_requests SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1`, [id, a.userId, b.note]);
      await this.event(tx, a, { id: r.order_id, branch_id: r.branch_id }, 'refund.rejected', { requestId: id }, b.note);
      await this.audit.record(tx, a, { action: 'refund.rejected', entityType: 'refund_request', entityId: id, branchId: r.branch_id, detail: { note: b.note } });
      return { id, status: 'rejected' };
    });
  }

  /** Pays the refund out. Cash comes out of the paying user's open till; the order's paid amount drops by the refund. */
  @Post('refund-requests/:id/complete')
  @RequirePermission('payment.refund.request')
  @HttpCode(200)
  complete(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(completeSchema)) b: z.infer<typeof completeSchema>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const r = await this.lockRequest(tx, id);
      if (r.status === 'completed') throw conflict('ALREADY_COMPLETED', 'This refund has already been paid out');
      if (r.status !== 'approved') throw conflict('NOT_APPROVED', `This request is ${r.status}, not approved`);
      const o = (await tx.query(`SELECT id, branch_id, currency, paid_minor FROM orders WHERE id = $1 FOR UPDATE`, [r.order_id])).rows[0];
      const pay = (await tx.query(`SELECT method FROM payments WHERE id = $1`, [r.payment_id])).rows[0];
      const room = await this.refundable(tx, r.payment_id, id);
      const amount = N(r.amount_minor);
      if (amount > room || amount > N(o.paid_minor)) throw new AppError(422, 'REFUND_EXCEEDS_PAYMENT', 'This refund is more than what is left to refund on the payment');
      let shiftId: string | null = null;
      if (pay.method === 'cash') {
        shiftId = (await tx.query(`SELECT id FROM cash_shifts WHERE branch_id = $1 AND opened_by = $2 AND status = 'open'`, [o.branch_id, a.userId])).rows[0]?.id ?? null;
        if (!shiftId && (await this.cfg.resolve(tx, a.tenantId!, 'cash.require_shift', o.branch_id)).value) throw conflict('SHIFT_REQUIRED', 'Open your till before paying out a cash refund');
      }
      const refundId = uuidv7();
      await tx.query(`INSERT INTO refunds (id, tenant_id, branch_id, request_id, order_id, payment_id, method, amount_minor, currency, reference, shift_id, refunded_by)
                      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [refundId, a.tenantId, o.branch_id, id, r.order_id, r.payment_id, pay.method, amount, o.currency, b.reference ?? null, shiftId, a.userId]);
      await tx.query(`UPDATE orders SET paid_minor = paid_minor - $2, version = version + 1, updated_at = now() WHERE id = $1`, [r.order_id, amount]);
      await tx.query(`UPDATE refund_requests SET status = 'completed', completed_at = now() WHERE id = $1`, [id]);
      await this.event(tx, a, o, 'refund.completed', { refundId, requestId: id, method: pay.method, amountMinor: amount });
      await this.audit.record(tx, a, { action: 'refund.completed', entityType: 'order', entityId: r.order_id, branchId: o.branch_id,
        detail: { refundId, paymentId: r.payment_id, method: pay.method, amountMinor: amount, approvedBy: r.decided_by, requestedBy: r.requested_by } });
      return { id, status: 'completed', refundId, method: pay.method, amountMinor: amount };
    });
  }
}
