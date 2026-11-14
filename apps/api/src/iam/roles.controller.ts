import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { Database } from '@eazy/database';
import { AuditService } from '../audit/audit.service.js';
import { RequirePermission } from '../common/access.js';
import { CurrentActor } from '../common/current-actor.js';
import { dbCtx } from '../common/db-context.js';
import { forbidden, notFound } from '../common/errors.js';
import { uuidv7 } from '../common/ids.js';
import type { Actor } from '../common/types.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { DATABASE } from '../db/db.module.js';
import { AuthorizationService, type PermGrant } from './authorization.service.js';

const permList = z.array(z.object({ code: z.string(), maxAmountMinor: z.number().int().min(0).nullable().default(null) })).max(200);
const createSchema = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), name: z.string().trim().min(2).max(60), permissions: permList });
const putSchema = z.object({ permissions: permList });

@Controller('roles')
export class RolesController {
  constructor(@Inject(DATABASE) private readonly db: Database, @Inject(AuditService) private readonly audit: AuditService,
              @Inject(AuthorizationService) private readonly authz: AuthorizationService) {}

  @Get()
  @RequirePermission('role.read')
  list(@CurrentActor() a: Actor) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const roles = await tx.query(`SELECT id, key, name, is_system FROM roles ORDER BY name`);
      const perms = await tx.query(`SELECT role_id, permission_code, max_amount_minor FROM role_permissions`);
      return { items: roles.rows.map((r) => ({ id: r.id, key: r.key, name: r.name, isSystem: r.is_system,
        permissions: perms.rows.filter((p) => p.role_id === r.id).map((p) => ({ code: p.permission_code, maxAmountMinor: p.max_amount_minor === null ? null : Number(p.max_amount_minor) })) })) };
    });
  }

  private async assertKnown(tx: any, grants: PermGrant[]) {
    const r = await tx.query(`SELECT code FROM permissions WHERE code = ANY($1)`, [grants.map((g) => g.code)]);
    if (r.rows.length !== new Set(grants.map((g) => g.code)).size) throw forbidden('UNKNOWN_PERMISSION', 'Unknown permission code');
  }

  @Post()
  @RequirePermission('role.manage')
  create(@CurrentActor() a: Actor, @Body(new ZodPipe(createSchema)) b: z.infer<typeof createSchema>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      this.authz.assertCanGrant(a, b.permissions);
      await this.assertKnown(tx, b.permissions);
      const id = uuidv7();
      await tx.query(`INSERT INTO roles (id, tenant_id, key, name) VALUES ($1,$2,$3,$4)`, [id, a.tenantId, b.key, b.name]);
      for (const p of b.permissions) {
        await tx.query(`INSERT INTO role_permissions (tenant_id, role_id, permission_code, max_amount_minor) VALUES ($1,$2,$3,$4)`, [a.tenantId, id, p.code, p.maxAmountMinor]);
      }
      await this.audit.record(tx, a, { action: 'role.created', entityType: 'role', entityId: id, detail: { key: b.key, permissions: b.permissions } });
      return { id };
    });
  }

  @Put(':id/permissions')
  @RequirePermission('role.manage')
  replace(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(putSchema)) b: z.infer<typeof putSchema>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const role = (await tx.query(`SELECT id, key FROM roles WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!role) throw notFound('Role');
      if (role.id === a.roleId) throw forbidden('SELF_MODIFICATION', 'You cannot edit your own role');
      if (role.key === 'owner') throw forbidden('IMMUTABLE_ROLE', 'The owner role cannot be modified');
      const cur = await tx.query(`SELECT permission_code, max_amount_minor FROM role_permissions WHERE role_id = $1`, [id]);
      this.authz.assertCanManageRolePerms(a, cur.rows.map((p) => ({ code: p.permission_code, maxAmountMinor: null })));
      this.authz.assertCanGrant(a, b.permissions);
      await this.assertKnown(tx, b.permissions);
      await tx.query(`DELETE FROM role_permissions WHERE role_id = $1`, [id]);
      for (const p of b.permissions) {
        await tx.query(`INSERT INTO role_permissions (tenant_id, role_id, permission_code, max_amount_minor) VALUES ($1,$2,$3,$4)`, [a.tenantId, id, p.code, p.maxAmountMinor]);
      }
      await this.audit.record(tx, a, { action: 'role.permissions_replaced', entityType: 'role', entityId: id,
        detail: { before: cur.rows.map((p) => p.permission_code), after: b.permissions } });
      return { id };
    });
  }
}
