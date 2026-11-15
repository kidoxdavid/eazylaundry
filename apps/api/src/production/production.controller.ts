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
import { DATABASE } from '../db/db.module.js';
import { loadOrder, mapOrder } from '../orders/orders.controller.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { REASON_CODES, SCAN_TOKEN_RE, WorkflowService, type StageRow } from './workflow.service.js';

const advanceSchema = z.object({ fromStageKey: z.string().min(2).max(31), toStageKey: z.string().min(2).max(31).optional(), note: z.string().trim().max(300).optional() });
const qcSchema = z.discriminatedUnion('result', [
  z.object({ result: z.literal('pass'), note: z.string().trim().max(500).optional() }),
  z.object({ result: z.literal('fail'), reasonCode: z.enum(['stain_remains', 'odour', 'wrinkles', 'fold_issue', 'damage', 'missing_item', 'other']),
    reworkStageKey: z.string().min(2).max(31), note: z.string().trim().max(500).optional() }),
]);
const boardQuery = z.object({ branchId: z.string().uuid().optional() });
const labelQuery = z.object({ bags: z.coerce.number().int().min(1).max(30).default(1) });

type Action = { kind: 'advance' | 'qc' | 'handover' | 'none'; label: string; toStageKey: string | null; skipStageKey: string | null; allowed: boolean; blockedReason: string | null };

@Controller()
export class ProductionController {
  constructor(@Inject(DATABASE) private readonly db: Database, @Inject(AuditService) private readonly audit: AuditService,
              @Inject(WorkflowService) private readonly workflow: WorkflowService,
              @Inject(NotificationsService) private readonly notify: NotificationsService) {}

  private async event(tx: Tx, a: Actor, o: { id: string; branch_id: string }, type: string, payload: Record<string, unknown> = {}, note?: string) {
    await tx.query(`INSERT INTO order_events (id, tenant_id, branch_id, order_id, type, actor_user_id, note, payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [uuidv7(), a.tenantId, o.branch_id, o.id, type, a.userId, note ?? null, JSON.stringify(payload)]);
  }

  /** What can THIS user do with this order right now, and if not, why. Used by scan, order detail and the board. */
  private actionFor(o: any, stages: StageRow[], a: Actor): Action {
    const none = (why: string): Action => ({ kind: 'none', label: why, toStageKey: null, skipStageKey: null, allowed: false, blockedReason: why });
    if (o.status === 'cancelled') return none('Order is cancelled');
    const i = stages.findIndex((s) => s.id === o.current_stage_id);
    const cur = stages[i];
    if (!cur) return none('No workflow stage');
    if (cur.isTerminal) return none('Order is complete');
    const next = stages[i + 1];
    const permitted = a.permissions.has(cur.requiredPermission);
    if (cur.isQc) return { kind: 'qc', label: 'Quality inspection', toStageKey: next?.key ?? null, skipStageKey: null, allowed: permitted, blockedReason: permitted ? null : 'Needs quality inspector permission' };
    const balance = Number(o.total_minor) - Number(o.paid_minor);
    const handover = next?.isTerminal;
    const blocked = !permitted ? 'You do not have permission for this step' : handover && balance > 0 ? 'Collect payment before handing over' : null;
    const skip = next?.optional ? stages[i + 2]?.key ?? null : null;
    return { kind: handover ? 'handover' : 'advance', label: handover ? 'Hand over to customer' : `Move to ${next.name}`, toStageKey: next.key, skipStageKey: skip, allowed: !blocked, blockedReason: blocked };
  }

  private async card(tx: Tx, a: Actor, id: string) {
    const o = await loadOrder(tx, id);
    const stages = await this.workflow.stages(tx, o.workflow_definition_id ?? (await this.workflow.ensureDefault(tx, a.tenantId!)).definitionId);
    const lines = (await tx.query(`SELECT service_name, pricing_model, quantity, weight_g FROM order_lines WHERE order_id = $1 ORDER BY line_no`, [id])).rows;
    const m = mapOrder(o);
    const idx = stages.findIndex((s) => s.id === o.current_stage_id);
    return {
      ...m, scanToken: o.scan_token, overdue: o.status === 'open' && new Date(o.promised_at).getTime() < Date.now(),
      lines: lines.map((l) => ({ name: l.service_name, pricingModel: l.pricing_model, quantity: l.quantity, weightG: l.weight_g })),
      stages: stages.map((s, n) => ({ key: s.key, name: s.name, state: n < idx ? 'done' : n === idx ? 'current' : 'todo', optional: s.optional })),
      action: this.actionFor(o, stages, a),
    };
  }

  @Get('workflow')
  @RequirePermission('order.read')
  workflowStages(@CurrentActor() a: Actor) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const wf = await this.workflow.ensureDefault(tx, a.tenantId!);
      return { stages: wf.stages.map(({ id: _id, ...s }) => s), reasonCodes: REASON_CODES.map((r) => ({ ...r, defaultStageKey: wf.stages.some((s) => s.key === r.defaultStageKey) ? r.defaultStageKey : null })) };
    });
  }

  @Get('orders/:id/production')
  @RequirePermission('order.read')
  production(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withContext(dbCtx(a), (tx) => this.card(tx, a, id));
  }

  /** Resolves a scanned label (token) or a typed order number. Unknown and out-of-scope codes look identical (404). */
  @Get('scan/:code')
  @RequirePermission('order.read')
  scan(@CurrentActor() a: Actor, @Param('code') code: string) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const c = code.trim().toUpperCase();
      const col = SCAN_TOKEN_RE.test(c) ? 'scan_token' : /^[A-Z0-9]{2,8}-\d{4}-\d{5}$/.test(c) ? 'order_no' : null;
      if (!col) throw notFound('Order');
      const row = (await tx.query(`SELECT id FROM orders WHERE ${col} = $1`, [c])).rows[0];
      if (!row) throw notFound('Order');
      return this.card(tx, a, row.id);
    });
  }

  private async lockOrder(tx: Tx, id: string) {
    const o = (await tx.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!o) throw notFound('Order');
    if (o.status === 'cancelled') throw conflict('ORDER_CANCELLED', 'This order is cancelled');
    if (o.status === 'completed') throw conflict('ORDER_COMPLETE', 'This order is already handed over');
    const stages = await this.workflow.stages(tx, o.workflow_definition_id);
    const i = stages.findIndex((s) => s.id === o.current_stage_id);
    if (i < 0) throw new AppError(409, 'NO_WORKFLOW', 'This order has no workflow stage');
    return { o, stages, i, cur: stages[i] };
  }

  private async moveTo(tx: Tx, a: Actor, o: any, from: StageRow, to: StageRow, extra: Record<string, unknown> = {}, note?: string) {
    await tx.query(`UPDATE orders SET current_stage_id = $2, stage_entered_at = now(), status = $3, version = version + 1, updated_at = now() WHERE id = $1`, [o.id, to.id, to.orderStatus]);
    await this.event(tx, a, o, 'stage.changed', { from: from.key, to: to.key, ...extra }, note);
    if (to.orderStatus === 'ready') {
      await this.event(tx, a, o, 'order.ready');
      const c = (await tx.query(`SELECT c.email, c.full_name, b.name AS branch,
                                        (SELECT to_char((t.window_start AT TIME ZONE b.timezone), 'Mon DD HH24:MI') || '–' || to_char((t.window_end AT TIME ZONE b.timezone), 'HH24:MI')
                                           FROM delivery_tasks t WHERE t.order_id = o.id AND t.kind = 'delivery' AND t.status NOT IN ('cancelled','failed') ORDER BY t.created_at DESC LIMIT 1) AS delivery
                                   FROM orders o JOIN customers c ON c.tenant_id = o.tenant_id AND c.id = o.customer_id JOIN branches b ON b.id = o.branch_id WHERE o.id = $1`, [o.id])).rows[0];
      const brand = await this.notify.brand(tx);
      await this.notify.enqueue(tx, { tenantId: a.tenantId!, customerId: o.customer_id, orderId: o.id, to: c.email, template: 'order.ready', dedupeKey: `order.ready:${o.id}`,
        vars: { name: c.full_name, orderNo: o.order_no, branch: c.branch, delivery: c.delivery, url: `${brand.base}/orders/${o.id}` } });
    }
    if (to.orderStatus === 'completed') {
      await this.event(tx, a, o, 'order.handed_over', {}, note);
      await this.audit.record(tx, a, { action: 'order.handed_over', entityType: 'order', entityId: o.id, branchId: o.branch_id, detail: { note } });
    }
  }

  /** Move an order to its next stage. `fromStageKey` makes the move safe against double scans and racing users. */
  @Post('orders/:id/advance')
  @HttpCode(200)
  @RequirePermission('order.read')
  advance(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(advanceSchema)) b: z.infer<typeof advanceSchema>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const { o, stages, i, cur } = await this.lockOrder(tx, id);
      if (cur.key !== b.fromStageKey) throw new AppError(409, 'STAGE_CHANGED', `This order is now at "${cur.name}". Refresh and try again.`);
      if (cur.isTerminal) throw conflict('ORDER_COMPLETE', 'This order is already handed over');
      if (cur.isQc) throw new AppError(409, 'USE_QUALITY_INSPECTION', 'Use the quality inspection to move this order on');
      if (!a.permissions.has(cur.requiredPermission)) throw forbidden('PERMISSION_DENIED', `Missing permission: ${cur.requiredPermission}`);
      const next = stages[i + 1];
      const target = b.toStageKey ? stages.find((s) => s.key === b.toStageKey) : next;
      const skipOk = next?.optional && stages[i + 2] && target?.id === stages[i + 2].id;
      if (!target || !(target.id === next?.id || skipOk)) throw new AppError(422, 'INVALID_TRANSITION', 'That stage cannot be reached from here');
      if (target.isTerminal && Number(o.total_minor) - Number(o.paid_minor) > 0) throw conflict('BALANCE_DUE', 'Collect payment before handing the order over');
      await this.moveTo(tx, a, o, cur, target, skipOk ? { skipped: [next.key] } : {}, b.note);
      return { id, stage: { key: target.key, name: target.name }, status: target.orderStatus };
    });
  }

  /** Quality inspection: pass moves on; fail records the reason and sends the order back to an earlier stage. */
  @Post('orders/:id/qc')
  @HttpCode(200)
  @RequirePermission('order.read')
  qc(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(qcSchema)) b: z.infer<typeof qcSchema>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const { o, stages, i, cur } = await this.lockOrder(tx, id);
      if (!cur.isQc) throw new AppError(409, 'NOT_AT_QC', `This order is at "${cur.name}", not at quality control`);
      if (!a.permissions.has(cur.requiredPermission)) throw forbidden('PERMISSION_DENIED', `Missing permission: ${cur.requiredPermission}`);
      if (b.result === 'pass') {
        const next = stages[i + 1];
        await tx.query(`INSERT INTO quality_inspections (id, tenant_id, branch_id, order_id, stage_id, result, note, inspector_user_id) VALUES ($1,$2,$3,$4,$5,'pass',$6,$7)`,
          [uuidv7(), a.tenantId, o.branch_id, id, cur.id, b.note ?? null, a.userId]);
        await this.event(tx, a, o, 'qc.passed', {}, b.note);
        await this.moveTo(tx, a, o, cur, next);
        return { id, result: 'pass', stage: { key: next.key, name: next.name } };
      }
      const target = stages.find((s) => s.key === b.reworkStageKey);
      if (!target || stages.indexOf(target) < 1 || stages.indexOf(target) >= i) throw new AppError(422, 'INVALID_REWORK_STAGE', 'Choose an earlier production stage to send the order back to');
      await tx.query(`INSERT INTO quality_inspections (id, tenant_id, branch_id, order_id, stage_id, result, reason_code, note, rework_stage_id, inspector_user_id) VALUES ($1,$2,$3,$4,$5,'fail',$6,$7,$8,$9)`,
        [uuidv7(), a.tenantId, o.branch_id, id, cur.id, b.reasonCode, b.note ?? null, target.id, a.userId]);
      await tx.query(`UPDATE orders SET rework_count = rework_count + 1 WHERE id = $1`, [id]);
      await this.event(tx, a, o, 'qc.failed', { reasonCode: b.reasonCode, reworkStage: target.key }, b.note);
      await this.moveTo(tx, a, o, cur, target, { rework: true });
      await this.audit.record(tx, a, { action: 'order.qc_failed', entityType: 'order', entityId: id, branchId: o.branch_id, detail: { reasonCode: b.reasonCode, reworkStage: target.key } });
      return { id, result: 'fail', stage: { key: target.key, name: target.name }, reworkCount: o.rework_count + 1 };
    });
  }

  @Get('orders/:id/labels')
  @RequirePermission('order.read')
  labels(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Query(new ZodPipe(labelQuery)) q: z.infer<typeof labelQuery>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const o = await loadOrder(tx, id);
      if (!o.scan_token) throw new AppError(409, 'NO_SCAN_TOKEN', 'This order has no label code');
      const br = (await tx.query(`SELECT to_char(($2::timestamptz AT TIME ZONE b.timezone), 'Mon DD HH24:MI') AS promised_local, b.name FROM branches b WHERE b.id = $1`, [o.branch_id, o.promised_at])).rows[0];
      return { labels: Array.from({ length: q.bags }, (_, n) => ({ orderNo: o.order_no, scanToken: o.scan_token, customerName: o.customer_name, bagIndex: n + 1, bagCount: q.bags,
        express: o.express, promisedLocal: br.promised_local, branch: br.name })) };
    });
  }

  /** Everything in progress, grouped by stage. Counts and cards come from the same query, so they always reconcile. */
  @Get('production/board')
  @RequirePermission('order.read')
  board(@CurrentActor() a: Actor, @Query(new ZodPipe(boardQuery)) q: z.infer<typeof boardQuery>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const wf = await this.workflow.ensureDefault(tx, a.tenantId!);
      const rows = (await tx.query(
        `SELECT o.id, o.order_no, o.branch_id, o.express, o.status, o.promised_at, o.stage_entered_at, o.rework_count, o.current_stage_id, c.full_name AS customer_name,
                (o.total_minor - o.paid_minor) AS balance_minor, (now() > o.promised_at) AS overdue
           FROM orders o JOIN customers c ON c.tenant_id = o.tenant_id AND c.id = o.customer_id
          WHERE o.status IN ('open','ready') AND ($1::uuid IS NULL OR o.branch_id = $1) ORDER BY o.promised_at, o.id LIMIT 500`, [q.branchId ?? null])).rows;
      const now = Date.now();
      return {
        stages: wf.stages.filter((s) => !s.isTerminal).map((s) => {
          const items = rows.filter((r) => r.current_stage_id === s.id).map((r) => {
            const mins = Math.floor((now - new Date(r.stage_entered_at).getTime()) / 60000);
            return { id: r.id, orderNo: r.order_no, customerName: r.customer_name, express: r.express, promisedAt: r.promised_at, overdue: r.status === 'open' && r.overdue,
              minutesInStage: mins, stageOverdue: s.expectedMinutes > 0 && mins > s.expectedMinutes, reworkCount: r.rework_count, balanceMinor: Number(r.balance_minor) };
          });
          return { key: s.key, name: s.name, expectedMinutes: s.expectedMinutes, count: items.length, items };
        }),
      };
    });
  }
}
