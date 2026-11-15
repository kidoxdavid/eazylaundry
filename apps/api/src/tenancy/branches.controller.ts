import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { Database } from '@eazy/database';
import { RequirePermission } from '../common/access.js';
import { AuditService } from '../audit/audit.service.js';
import { CurrentActor } from '../common/current-actor.js';
import { canAccessBranch, dbCtx } from '../common/db-context.js';
import { notFound } from '../common/errors.js';
import { uuidv7 } from '../common/ids.js';
import type { Actor } from '../common/types.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { EntitlementService } from '../billing/entitlements.service.js';
import { DATABASE } from '../db/db.module.js';
import { PROVINCES, postalCode } from '../common/canada.js';

const tz = z.string().refine((t) => { try { new Intl.DateTimeFormat('en', { timeZone: t }); return true; } catch { return false; } }, 'Unknown time zone');
const address = z.object({
  line1: z.string().max(120).optional(), line2: z.string().max(120).optional(), city: z.string().max(80).optional(),
  province: z.string().toUpperCase().pipe(z.enum(PROVINCES)).optional(), postalCode: postalCode.optional(),
}).strict();
const createSchema = z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,8}$/), name: z.string().trim().min(2).max(80), address: address.default({}), timezone: tz.default('America/Edmonton') });
const patchSchema = z.object({ name: z.string().trim().min(2).max(80), address, timezone: tz, status: z.enum(['active', 'archived']) }).partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');

const map = (r: any) => ({ id: r.id, code: r.code, name: r.name, address: r.address, timezone: r.timezone, status: r.status });

@Controller('branches')
export class BranchesController {
  constructor(@Inject(DATABASE) private readonly db: Database, @Inject(AuditService) private readonly audit: AuditService,
              @Inject(EntitlementService) private readonly ent: EntitlementService) {}

  @Get()
  @RequirePermission('branch.read')
  list(@CurrentActor() a: Actor) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const r = await tx.query(`SELECT * FROM branches ORDER BY code`);
      return { items: r.rows.filter((b) => canAccessBranch(a, b.id)).map(map) };
    });
  }

  @Post()
  @RequirePermission('branch.manage')
  create(@CurrentActor() a: Actor, @Body(new ZodPipe(createSchema)) b: z.infer<typeof createSchema>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      await this.ent.assertLimit(tx, a.tenantId!, 'limit.branches', Number((await tx.query(`SELECT count(*) AS n FROM branches WHERE status = 'active'`)).rows[0].n));
      const id = uuidv7();
      const r = await tx.query(`INSERT INTO branches (id, tenant_id, code, name, address, timezone) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [id, a.tenantId, b.code, b.name, JSON.stringify(b.address), b.timezone]);
      await this.audit.record(tx, a, { action: 'branch.created', entityType: 'branch', entityId: id, detail: { code: b.code } });
      return map(r.rows[0]);
    });
  }

  @Patch(':id')
  @RequirePermission('branch.manage')
  update(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(patchSchema)) b: z.infer<typeof patchSchema>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      if (!canAccessBranch(a, id)) throw notFound('Branch');
      if (b.status === 'active' && (await tx.query(`SELECT 1 FROM branches WHERE id = $1 AND status = 'archived'`, [id])).rowCount) {
        // restoring an archived branch uses a branch slot again
        await this.ent.assertLimit(tx, a.tenantId!, 'limit.branches', Number((await tx.query(`SELECT count(*) AS n FROM branches WHERE status = 'active'`)).rows[0].n));
      }
      const r = await tx.query(
        `UPDATE branches SET name = coalesce($2, name), address = coalesce($3, address), timezone = coalesce($4, timezone),
                status = coalesce($5, status) WHERE id = $1 RETURNING *`,
        [id, b.name ?? null, b.address ? JSON.stringify(b.address) : null, b.timezone ?? null, b.status ?? null]);
      if (!r.rows[0]) throw notFound('Branch');
      await this.audit.record(tx, a, { action: 'branch.updated', entityType: 'branch', entityId: id, branchId: id, detail: b });
      return map(r.rows[0]);
    });
  }
}
