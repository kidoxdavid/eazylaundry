import { Controller, Get, Inject, Query } from '@nestjs/common';
import { z } from 'zod';
import { Database, type Tx } from '@eazy/database';
import { RequirePermission } from '../common/access.js';
import { CurrentActor } from '../common/current-actor.js';
import { dbCtx } from '../common/db-context.js';
import { notFound } from '../common/errors.js';
import type { Actor } from '../common/types.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { DATABASE } from '../db/db.module.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const rangeQuery = z.object({ from: date, to: date, branchId: z.string().uuid().optional() })
  .refine((v) => v.from <= v.to, { message: 'from must not be after to' })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 366, { message: 'Range is limited to 367 days' });
const branchQuery = z.object({ branchId: z.string().uuid().optional() });
type Range = z.infer<typeof rangeQuery>;

const N = (v: unknown) => Number(v);

/**
 * Operational reports computed straight from the append-only records (no cached totals), so they can always be re-derived.
 * Days are the BRANCH's local calendar days. Branch-limited staff only ever see their branches (restrictive RLS applies to every query).
 * Two bases are kept apart on purpose: SALES are by order creation date (what was billed, excluding cancelled orders);
 * COLLECTIONS are by payment/refund date (what money moved). They differ whenever an order is paid later than it was created.
 */
@Controller('reports')
export class ReportsController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  private async checkBranch(tx: Tx, branchId?: string) {
    if (branchId && !(await tx.query(`SELECT 1 FROM branches WHERE id = $1`, [branchId])).rowCount) throw notFound('Branch');
  }

  @Get('sales')
  @RequirePermission('report.read')
  sales(@CurrentActor() a: Actor, @Query(new ZodPipe(rangeQuery)) q: Range) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      await this.checkBranch(tx, q.branchId);
      const args = [q.from, q.to, q.branchId ?? null];
      const base = `FROM orders o JOIN branches b ON b.tenant_id = o.tenant_id AND b.id = o.branch_id
                    WHERE o.status <> 'cancelled' AND ($3::uuid IS NULL OR o.branch_id = $3)
                      AND (o.created_at AT TIME ZONE b.timezone)::date BETWEEN $1::date AND $2::date`;
      const daily = (await tx.query(
        `SELECT (o.created_at AT TIME ZONE b.timezone)::date::text AS day, count(*) AS orders, sum(o.net_minor) AS net, sum(o.tax_minor) AS tax, sum(o.total_minor) AS total,
                sum(o.discount_minor) AS discount, sum(o.delivery_fee_minor) AS delivery
         ${base} GROUP BY 1 ORDER BY 1`, args)).rows;
      const sources = (await tx.query(`SELECT o.source, count(*) AS orders, sum(o.total_minor) AS total ${base} GROUP BY 1 ORDER BY 3 DESC`, args)).rows;
      const services = (await tx.query(
        `SELECT l.service_code AS code, max(l.service_name) AS name, count(DISTINCT o.id) AS orders, sum(l.net_minor) AS net, sum(coalesce(l.weight_g,0)) AS weight_g, sum(coalesce(l.quantity,0)) AS quantity
         FROM order_lines l JOIN orders o ON o.tenant_id = l.tenant_id AND o.id = l.order_id JOIN branches b ON b.tenant_id = o.tenant_id AND b.id = o.branch_id
         WHERE o.status <> 'cancelled' AND ($3::uuid IS NULL OR o.branch_id = $3) AND (o.created_at AT TIME ZONE b.timezone)::date BETWEEN $1::date AND $2::date
         GROUP BY l.service_code ORDER BY net DESC LIMIT 15`, args)).rows;
      const sum = (k: string) => daily.reduce((s, r) => s + N(r[k]), 0);
      const orders = sum('orders');
      return {
        from: q.from, to: q.to, branchId: q.branchId ?? null,
        totals: { orders, netMinor: sum('net'), taxMinor: sum('tax'), totalMinor: sum('total'), discountMinor: sum('discount'), deliveryFeeMinor: sum('delivery'), averageOrderMinor: orders ? Math.round(sum('total') / orders) : 0 },
        daily: daily.map((r) => ({ day: r.day, orders: N(r.orders), netMinor: N(r.net), taxMinor: N(r.tax), totalMinor: N(r.total), discountMinor: N(r.discount), deliveryFeeMinor: N(r.delivery) })),
        bySource: sources.map((r) => ({ source: r.source, orders: N(r.orders), totalMinor: N(r.total) })),
        topServices: services.map((r) => ({ code: r.code, name: r.name, orders: N(r.orders), netMinor: N(r.net), weightG: N(r.weight_g), quantity: N(r.quantity) })),
      };
    });
  }

  /** Money actually collected and refunded, by method and by day. */
  @Get('collections')
  @RequirePermission('finance.read')
  collections(@CurrentActor() a: Actor, @Query(new ZodPipe(rangeQuery)) q: Range) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      await this.checkBranch(tx, q.branchId);
      const args = [q.from, q.to, q.branchId ?? null];
      const paid = (await tx.query(
        `SELECT (p.received_at AT TIME ZONE b.timezone)::date::text AS day, p.method, sum(p.amount_minor) AS amount, count(*) AS n
         FROM payments p JOIN branches b ON b.tenant_id = p.tenant_id AND b.id = p.branch_id
         WHERE ($3::uuid IS NULL OR p.branch_id = $3) AND (p.received_at AT TIME ZONE b.timezone)::date BETWEEN $1::date AND $2::date GROUP BY 1,2`, args)).rows;
      const refunded = (await tx.query(
        `SELECT (r.refunded_at AT TIME ZONE b.timezone)::date::text AS day, r.method, sum(r.amount_minor) AS amount, count(*) AS n
         FROM refunds r JOIN branches b ON b.tenant_id = r.tenant_id AND b.id = r.branch_id
         WHERE ($3::uuid IS NULL OR r.branch_id = $3) AND (r.refunded_at AT TIME ZONE b.timezone)::date BETWEEN $1::date AND $2::date GROUP BY 1,2`, args)).rows;
      const days = new Map<string, any>(); const methods = new Map<string, { collectedMinor: number; refundedMinor: number }>();
      const day = (d: string) => { if (!days.has(d)) days.set(d, { day: d, collectedMinor: 0, refundedMinor: 0, netMinor: 0 }); return days.get(d); };
      const meth = (m: string) => { if (!methods.has(m)) methods.set(m, { collectedMinor: 0, refundedMinor: 0 }); return methods.get(m)!; };
      for (const r of paid) { day(r.day).collectedMinor += N(r.amount); meth(r.method).collectedMinor += N(r.amount); }
      for (const r of refunded) { day(r.day).refundedMinor += N(r.amount); meth(r.method).refundedMinor += N(r.amount); }
      for (const d of days.values()) d.netMinor = d.collectedMinor - d.refundedMinor;
      const collected = [...methods.values()].reduce((s, m) => s + m.collectedMinor, 0); const refundedTotal = [...methods.values()].reduce((s, m) => s + m.refundedMinor, 0);
      return {
        from: q.from, to: q.to, branchId: q.branchId ?? null,
        totals: { collectedMinor: collected, refundedMinor: refundedTotal, netMinor: collected - refundedTotal },
        byMethod: [...methods.entries()].map(([method, v]) => ({ method, ...v, netMinor: v.collectedMinor - v.refundedMinor })).sort((x, y) => y.collectedMinor - x.collectedMinor),
        daily: [...days.values()].sort((x, y) => x.day.localeCompare(y.day)),
      };
    });
  }

  /** Orders with money still owed, aged from the order date (as of now). */
  @Get('receivables')
  @RequirePermission('finance.read')
  receivables(@CurrentActor() a: Actor, @Query(new ZodPipe(branchQuery)) q: z.infer<typeof branchQuery>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      await this.checkBranch(tx, q.branchId);
      // Owed = total - still-paid - already refunded: a refund returns money the customer paid, it does not make them owe it again.
      const rows = (await tx.query(
        `SELECT * FROM (
           SELECT o.id, o.order_no, o.status, o.total_minor, o.created_at, c.full_name AS customer_name,
                  o.total_minor - o.paid_minor - coalesce((SELECT sum(r.amount_minor) FROM refunds r WHERE r.tenant_id = o.tenant_id AND r.order_id = o.id), 0) AS owed_minor,
                  greatest(0, floor(extract(epoch FROM (now() - o.created_at)) / 86400))::int AS age_days
           FROM orders o JOIN customers c ON c.tenant_id = o.tenant_id AND c.id = o.customer_id
           WHERE o.status <> 'cancelled' AND ($1::uuid IS NULL OR o.branch_id = $1)) x
         WHERE owed_minor > 0 ORDER BY owed_minor DESC, created_at`, [q.branchId ?? null])).rows;
      const buckets = [{ key: '0-7', min: 0, max: 7 }, { key: '8-30', min: 8, max: 30 }, { key: '31+', min: 31, max: Infinity }]
        .map((b) => { const m = rows.filter((r) => r.age_days >= b.min && r.age_days <= b.max); return { bucket: b.key, orders: m.length, owedMinor: m.reduce((s, r) => s + N(r.owed_minor), 0) }; });
      return {
        branchId: q.branchId ?? null,
        totals: { orders: rows.length, owedMinor: buckets.reduce((s, b) => s + b.owedMinor, 0) }, buckets,
        top: rows.slice(0, 25).map((r) => ({ id: r.id, orderNo: r.order_no, status: r.status, customerName: r.customer_name, totalMinor: N(r.total_minor), owedMinor: N(r.owed_minor), ageDays: r.age_days, createdAt: r.created_at })),
      };
    });
  }

  /** Where work is right now, what is late, and how often finished work fails quality control. */
  @Get('operations')
  @RequirePermission('report.read')
  operations(@CurrentActor() a: Actor, @Query(new ZodPipe(rangeQuery)) q: Range) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      await this.checkBranch(tx, q.branchId);
      const br = q.branchId ?? null;
      const live = (await tx.query(`SELECT status, count(*) AS n FROM orders WHERE status IN ('open','ready') AND ($1::uuid IS NULL OR branch_id = $1) GROUP BY 1`, [br])).rows;
      const overdue = N((await tx.query(`SELECT count(*) AS n FROM orders WHERE status IN ('open','ready') AND promised_at < now() AND ($1::uuid IS NULL OR branch_id = $1)`, [br])).rows[0].n);
      const qc = (await tx.query(
        `SELECT qi.result, count(*) AS n FROM quality_inspections qi JOIN branches b ON b.tenant_id = qi.tenant_id AND b.id = qi.branch_id
         WHERE ($3::uuid IS NULL OR qi.branch_id = $3) AND (qi.inspected_at AT TIME ZONE b.timezone)::date BETWEEN $1::date AND $2::date GROUP BY 1`, [q.from, q.to, br])).rows;
      const reasons = (await tx.query(
        `SELECT qi.reason_code, count(*) AS n FROM quality_inspections qi JOIN branches b ON b.tenant_id = qi.tenant_id AND b.id = qi.branch_id
         WHERE qi.result = 'fail' AND ($3::uuid IS NULL OR qi.branch_id = $3) AND (qi.inspected_at AT TIME ZONE b.timezone)::date BETWEEN $1::date AND $2::date GROUP BY 1 ORDER BY 2 DESC`, [q.from, q.to, br])).rows;
      const done = (await tx.query(
        `SELECT count(*) AS n, avg(extract(epoch FROM (e.at - o.created_at)) / 3600) AS avg_h,
                count(*) FILTER (WHERE e.at <= o.promised_at) AS on_time
         FROM orders o JOIN branches b ON b.tenant_id = o.tenant_id AND b.id = o.branch_id
         JOIN LATERAL (SELECT min(occurred_at) AS at FROM order_events ev WHERE ev.order_id = o.id AND ev.type = 'order.handed_over') e ON e.at IS NOT NULL
         WHERE ($3::uuid IS NULL OR o.branch_id = $3) AND (e.at AT TIME ZONE b.timezone)::date BETWEEN $1::date AND $2::date`, [q.from, q.to, br])).rows[0];
      const pass = N(qc.find((r) => r.result === 'pass')?.n ?? 0), fail = N(qc.find((r) => r.result === 'fail')?.n ?? 0);
      return {
        from: q.from, to: q.to, branchId: br,
        live: { open: N(live.find((r) => r.status === 'open')?.n ?? 0), ready: N(live.find((r) => r.status === 'ready')?.n ?? 0), overdue },
        completed: { orders: N(done.n), averageHoursToHandover: done.avg_h === null ? null : Math.round(N(done.avg_h) * 10) / 10, onTimePercent: N(done.n) ? Math.round((N(done.on_time) / N(done.n)) * 1000) / 10 : null },
        quality: { inspections: pass + fail, failed: fail, failPercent: pass + fail ? Math.round((fail / (pass + fail)) * 1000) / 10 : null, reasons: reasons.map((r) => ({ reason: r.reason_code, count: N(r.n) })) },
      };
    });
  }
}
