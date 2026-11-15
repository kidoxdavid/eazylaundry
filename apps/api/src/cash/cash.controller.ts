import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Database, type Tx } from '@eazy/database';
import { AuditService } from '../audit/audit.service.js';
import { RequirePermission } from '../common/access.js';
import { CurrentActor } from '../common/current-actor.js';
import { canAccessBranch, dbCtx } from '../common/db-context.js';
import { AppError, conflict, forbidden, notFound } from '../common/errors.js';
import { uuidv7 } from '../common/ids.js';
import type { Actor } from '../common/types.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { DATABASE } from '../db/db.module.js';

const money = z.number().int().min(0).max(1_000_000_00);
const openSchema = z.object({ branchId: z.string().uuid(), openingFloatMinor: money });
const moveSchema = z.object({ type: z.enum(['pay_in', 'pay_out']), amountMinor: money.min(1), reason: z.string().trim().min(3).max(200) });
const closeSchema = z.object({ countedCashMinor: money, note: z.string().trim().max(500).optional() });
const listQuery = z.object({ branchId: z.string().uuid().optional(), status: z.enum(['open', 'closed']).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });
const currentQuery = z.object({ branchId: z.string().uuid() });

const N = (v: unknown) => Number(v);
/** Supervisors can see expected cash, all tills, and close other people's tills. */
export const isSupervisor = (a: Actor) => a.permissions.has('payment.refund.approve') || a.permissions.has('finance.read');

export async function shiftTotals(tx: Tx, shiftId: string, openingFloat: number) {
  const pay = (await tx.query(`SELECT coalesce(sum(amount_minor),0) AS s, count(*)::int AS n FROM payments WHERE shift_id = $1 AND method = 'cash'`, [shiftId])).rows[0];
  const ref = (await tx.query(`SELECT coalesce(sum(amount_minor),0) AS s FROM refunds WHERE shift_id = $1`, [shiftId])).rows[0];
  const mv = (await tx.query(`SELECT type, coalesce(sum(amount_minor),0) AS s FROM cash_movements WHERE shift_id = $1 GROUP BY type`, [shiftId])).rows;
  const payIn = N(mv.find((m) => m.type === 'pay_in')?.s ?? 0), payOut = N(mv.find((m) => m.type === 'pay_out')?.s ?? 0);
  const cashSales = N(pay.s), cashRefunds = N(ref.s);
  return { cashSalesMinor: cashSales, cashPaymentCount: pay.n as number, cashRefundsMinor: cashRefunds, payInMinor: payIn, payOutMinor: payOut,
    expectedCashMinor: openingFloat + cashSales - cashRefunds + payIn - payOut };
}

const mapShift = (r: any) => ({ id: r.id, branchId: r.branch_id, openedBy: r.opened_by, openedAt: r.opened_at, openingFloatMinor: N(r.opening_float_minor), status: r.status,
  closedBy: r.closed_by, closedAt: r.closed_at, closeNote: r.close_note });

@Controller('cash-shifts')
export class CashController {
  constructor(@Inject(DATABASE) private readonly db: Database, @Inject(AuditService) private readonly audit: AuditService) {}

  private async detail(tx: Tx, a: Actor, s: any) {
    const base = mapShift(s);
    const totals = await shiftTotals(tx, s.id, N(s.opening_float_minor));
    const movements = (await tx.query(`SELECT id, type, amount_minor, reason, recorded_at FROM cash_movements WHERE shift_id = $1 ORDER BY recorded_at`, [s.id])).rows
      .map((m) => ({ id: m.id, type: m.type, amountMinor: N(m.amount_minor), reason: m.reason, recordedAt: m.recorded_at }));
    const closed = s.status === 'closed';
    // Blind count: the person counting the drawer must not see the expected figure before they commit their count.
    const showExpected = closed || isSupervisor(a);
    const { expectedCashMinor, ...rest } = totals;
    return { ...base, ...rest, movements, expectedCashMinor: closed ? N(s.expected_cash_minor) : showExpected ? expectedCashMinor : null,
      countedCashMinor: closed ? N(s.counted_cash_minor) : null, varianceMinor: closed ? N(s.variance_minor) : null };
  }

  private async mine(tx: Tx, a: Actor, id: string, forUpdate = false) {
    const s = (await tx.query(`SELECT * FROM cash_shifts WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`, [id])).rows[0];
    if (!s || (s.opened_by !== a.userId && !isSupervisor(a))) throw notFound('Shift');
    return s;
  }

  @Post()
  @RequirePermission('cash.shift.manage')
  open(@CurrentActor() a: Actor, @Body(new ZodPipe(openSchema)) b: z.infer<typeof openSchema>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      if (!canAccessBranch(a, b.branchId)) throw notFound('Branch');
      const br = (await tx.query(`SELECT status FROM branches WHERE id = $1`, [b.branchId])).rows[0];
      if (!br || br.status !== 'active') throw notFound('Branch');
      const id = uuidv7();
      try {
        await tx.query('SAVEPOINT sh');
        await tx.query(`INSERT INTO cash_shifts (id, tenant_id, branch_id, opened_by, opening_float_minor) VALUES ($1,$2,$3,$4,$5)`, [id, a.tenantId, b.branchId, a.userId, b.openingFloatMinor]);
      } catch (e: any) {
        await tx.query('ROLLBACK TO SAVEPOINT sh');
        if (e.code === '23505') throw conflict('SHIFT_ALREADY_OPEN', 'You already have an open till at this branch');
        throw e;
      }
      await this.audit.record(tx, a, { action: 'cash_shift.opened', entityType: 'cash_shift', entityId: id, branchId: b.branchId, detail: { openingFloatMinor: b.openingFloatMinor } });
      return { id };
    });
  }

  @Get('current')
  @RequirePermission('cash.shift.manage')
  current(@CurrentActor() a: Actor, @Query(new ZodPipe(currentQuery)) q: z.infer<typeof currentQuery>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const s = (await tx.query(`SELECT * FROM cash_shifts WHERE branch_id = $1 AND opened_by = $2 AND status = 'open'`, [q.branchId, a.userId])).rows[0];
      return { shift: s ? await this.detail(tx, a, s) : null };
    });
  }

  @Get()
  @RequirePermission('cash.shift.manage')
  list(@CurrentActor() a: Actor, @Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const where: string[] = []; const p: unknown[] = [];
      if (q.branchId) { p.push(q.branchId); where.push(`branch_id = $${p.length}`); }
      if (q.status) { p.push(q.status); where.push(`status = $${p.length}`); }
      if (!isSupervisor(a)) { p.push(a.userId); where.push(`opened_by = $${p.length}`); }
      p.push(q.limit);
      const rows = (await tx.query(`SELECT * FROM cash_shifts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY opened_at DESC LIMIT $${p.length}`, p)).rows;
      return { items: rows.map((s) => ({ ...mapShift(s), expectedCashMinor: s.status === 'closed' ? N(s.expected_cash_minor) : null, countedCashMinor: s.status === 'closed' ? N(s.counted_cash_minor) : null,
        varianceMinor: s.status === 'closed' ? N(s.variance_minor) : null })) };
    });
  }

  @Get(':id')
  @RequirePermission('cash.shift.manage')
  get(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withContext(dbCtx(a), async (tx) => this.detail(tx, a, await this.mine(tx, a, id)));
  }

  @Post(':id/movements')
  @RequirePermission('cash.shift.manage')
  movement(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(moveSchema)) b: z.infer<typeof moveSchema>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const s = await this.mine(tx, a, id, true);
      if (s.opened_by !== a.userId) throw forbidden('NOT_YOUR_TILL', 'Only the person running this till can record cash movements');
      if (s.status !== 'open') throw conflict('SHIFT_CLOSED', 'This till is closed');
      const mid = uuidv7();
      await tx.query(`INSERT INTO cash_movements (id, tenant_id, branch_id, shift_id, type, amount_minor, reason, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [mid, a.tenantId, s.branch_id, id, b.type, b.amountMinor, b.reason, a.userId]);
      await this.audit.record(tx, a, { action: `cash_shift.${b.type}`, entityType: 'cash_shift', entityId: id, branchId: s.branch_id, detail: { amountMinor: b.amountMinor, reason: b.reason } });
      return { id: mid };
    });
  }

  /** Closing needs the physical count. A variance of any size must be explained, and is recorded permanently. */
  @Post(':id/close')
  @RequirePermission('cash.shift.manage')
  @HttpCode(200)
  close(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(closeSchema)) b: z.infer<typeof closeSchema>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const s = await this.mine(tx, a, id, true);
      if (s.status !== 'open') throw conflict('SHIFT_CLOSED', 'This till is already closed');
      const t = await shiftTotals(tx, id, N(s.opening_float_minor));
      const variance = b.countedCashMinor - t.expectedCashMinor;
      if (variance !== 0 && (!b.note || b.note.length < 3)) throw new AppError(422, 'VARIANCE_NOTE_REQUIRED', 'The count does not match. Add a note explaining the difference.');
      await tx.query(`UPDATE cash_shifts SET status = 'closed', closed_by = $2, closed_at = now(), expected_cash_minor = $3, counted_cash_minor = $4, variance_minor = $5, close_note = $6 WHERE id = $1`,
        [id, a.userId, t.expectedCashMinor, b.countedCashMinor, variance, b.note ?? null]);
      await this.audit.record(tx, a, { action: 'cash_shift.closed', entityType: 'cash_shift', entityId: id, branchId: s.branch_id,
        detail: { expectedCashMinor: t.expectedCashMinor, countedCashMinor: b.countedCashMinor, varianceMinor: variance, closedByOpener: s.opened_by === a.userId } });
      return this.detail(tx, a, (await tx.query(`SELECT * FROM cash_shifts WHERE id = $1`, [id])).rows[0]);
    });
  }
}
