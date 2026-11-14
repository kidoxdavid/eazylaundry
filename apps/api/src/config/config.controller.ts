import { Body, Controller, Get, Inject, Param, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { Database } from '@eazy/database';
import { AuditService } from '../audit/audit.service.js';
import { RequirePermission } from '../common/access.js';
import { CurrentActor } from '../common/current-actor.js';
import { canAccessBranch, dbCtx } from '../common/db-context.js';
import { badRequest, notFound } from '../common/errors.js';
import { uuidv7 } from '../common/ids.js';
import type { Actor } from '../common/types.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { DATABASE } from '../db/db.module.js';

/** Registry of configurable keys: schema + default. Resolution: branch override > tenant override > default. */
export const CONFIG_REGISTRY = {
  'tax.price_mode': { schema: z.enum(['exclusive', 'inclusive']), default: 'exclusive' },
  'weight.display_unit': { schema: z.enum(['kg', 'lb']), default: 'kg' },
} as const;
type Key = keyof typeof CONFIG_REGISTRY;
const known = (k: string): k is Key => k in CONFIG_REGISTRY;

const putSchema = z.object({ scope: z.enum(['tenant', 'branch']), branchId: z.string().uuid().optional(), value: z.unknown() })
  .refine((v) => v.scope === 'tenant' || !!v.branchId, 'branchId is required for branch scope');

@Controller('config')
export class ConfigController {
  constructor(@Inject(DATABASE) private readonly db: Database, @Inject(AuditService) private readonly audit: AuditService) {}

  @Get(':key')
  @RequirePermission('config.read')
  get(@CurrentActor() a: Actor, @Param('key') key: string, @Query('branchId') branchId?: string) {
    if (!known(key)) throw notFound('Config key');
    return this.db.withContext(dbCtx(a), async (tx) => {
      const latest = async (scope: string, scopeId: string) => (await tx.query(
        `SELECT value, version FROM config_entries WHERE scope = $1 AND scope_id = $2 AND key = $3 AND effective_from <= now()
          ORDER BY version DESC LIMIT 1`, [scope, scopeId, key])).rows[0];
      if (branchId) {
        if (!canAccessBranch(a, branchId) || !(await tx.query(`SELECT 1 FROM branches WHERE id = $1`, [branchId])).rowCount) throw notFound('Branch');
        const b = await latest('branch', branchId);
        if (b) return { key, value: b.value, source: 'branch', version: b.version };
      }
      const t = await latest('tenant', a.tenantId!);
      if (t) return { key, value: t.value, source: 'tenant', version: t.version };
      return { key, value: CONFIG_REGISTRY[key].default, source: 'default', version: 0 };
    });
  }

  @Put(':key')
  @RequirePermission('config.write')
  put(@CurrentActor() a: Actor, @Param('key') key: string, @Body(new ZodPipe(putSchema)) b: z.infer<typeof putSchema>) {
    if (!known(key)) throw notFound('Config key');
    const parsed = CONFIG_REGISTRY[key].schema.safeParse(b.value);
    if (!parsed.success) throw badRequest('INVALID_CONFIG_VALUE', 'Value is not valid for this key');
    return this.db.withContext(dbCtx(a), async (tx) => {
      const scopeId = b.scope === 'tenant' ? a.tenantId! : b.branchId!;
      if (b.scope === 'branch') {
        if (!canAccessBranch(a, scopeId)) throw notFound('Branch');
        if (!(await tx.query(`SELECT 1 FROM branches WHERE id = $1`, [scopeId])).rowCount) throw notFound('Branch');
      }
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`cfg:${a.tenantId}:${b.scope}:${scopeId}:${key}`]);
      const v = (await tx.query(`SELECT coalesce(max(version),0)+1 AS v FROM config_entries WHERE scope=$1 AND scope_id=$2 AND key=$3`, [b.scope, scopeId, key])).rows[0].v;
      await tx.query(`INSERT INTO config_entries (id, tenant_id, scope, scope_id, key, version, value, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [uuidv7(), a.tenantId, b.scope, scopeId, key, v, JSON.stringify(parsed.data), a.userId]);
      await this.audit.record(tx, a, { action: 'config.changed', entityType: 'config', entityId: key, detail: { scope: b.scope, scopeId, version: v, value: parsed.data } });
      return { key, version: v };
    });
  }
}
