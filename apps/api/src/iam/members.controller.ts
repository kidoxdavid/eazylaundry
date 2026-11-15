import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { Database } from '@eazy/database';
import { AuditService } from '../audit/audit.service.js';
import { PasswordService } from '../auth/password.service.js';
import { SessionService } from '../auth/session.service.js';
import { RequirePermission } from '../common/access.js';
import { CurrentActor } from '../common/current-actor.js';
import { dbCtx } from '../common/db-context.js';
import { conflict, forbidden, notFound } from '../common/errors.js';
import { uuidv7 } from '../common/ids.js';
import type { Actor } from '../common/types.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { EntitlementService } from '../billing/entitlements.service.js';
import { DATABASE } from '../db/db.module.js';
import { AuthorizationService } from './authorization.service.js';

const createSchema = z.object({
  email: z.string().trim().toLowerCase().email(), fullName: z.string().trim().min(2).max(80),
  roleId: z.string().uuid(), allBranches: z.boolean().default(false), branchIds: z.array(z.string().uuid()).max(100).default([]),
  temporaryPassword: z.string().min(12).max(128),
});
const patchSchema = z.object({
  roleId: z.string().uuid(), status: z.enum(['active', 'suspended']), allBranches: z.boolean(), branchIds: z.array(z.string().uuid()).max(100),
}).partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');

@Controller('members')
export class MembersController {
  constructor(
    @Inject(DATABASE) private readonly db: Database, @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AuthorizationService) private readonly authz: AuthorizationService, @Inject(PasswordService) private readonly pw: PasswordService,
    @Inject(SessionService) private readonly sessions: SessionService, @Inject(EntitlementService) private readonly ent: EntitlementService,
  ) {}

  @Get()
  @RequirePermission('member.read')
  list(@CurrentActor() a: Actor) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const r = await tx.query(
        `SELECT m.id, m.status, m.all_branches, m.role_id, r.name AS role_name, u.email, u.full_name,
                coalesce((SELECT array_agg(branch_id) FROM membership_branches mb WHERE mb.membership_id = m.id), '{}') AS branch_ids
           FROM user_memberships m JOIN users u ON u.id = m.user_id JOIN roles r ON r.tenant_id = m.tenant_id AND r.id = m.role_id
          ORDER BY u.full_name`);
      return { items: r.rows.map((x) => ({ id: x.id, email: x.email, fullName: x.full_name, status: x.status, roleId: x.role_id,
        roleName: x.role_name, allBranches: x.all_branches, branchIds: x.branch_ids })) };
    });
  }

  private async rolePerms(tx: any, roleId: string) {
    const role = (await tx.query(`SELECT id, key FROM roles WHERE id = $1`, [roleId])).rows[0];
    if (!role) throw notFound('Role');
    const p = await tx.query(`SELECT permission_code, max_amount_minor FROM role_permissions WHERE role_id = $1`, [roleId]);
    return { role, grants: p.rows.map((x: any) => ({ code: x.permission_code, maxAmountMinor: x.max_amount_minor === null ? null : Number(x.max_amount_minor) })) };
  }

  @Post()
  @RequirePermission('member.manage')
  create(@CurrentActor() a: Actor, @Body(new ZodPipe(createSchema)) b: z.infer<typeof createSchema>) {
    return this.pw.hash(b.temporaryPassword).then((hash) => this.db.withContext(dbCtx(a), async (tx) => {
      await this.ent.assertLimit(tx, a.tenantId!, 'limit.staff_seats', Number((await tx.query(`SELECT count(*) AS n FROM user_memberships WHERE status = 'active'`)).rows[0].n));
      const { grants } = await this.rolePerms(tx, b.roleId);
      this.authz.assertCanGrant(a, grants);
      this.authz.assertBranchScope(a, b.allBranches, b.branchIds);
      // Existing users keep their credentials; the response is identical either way (no account enumeration).
      const u = (await tx.query(`SELECT id, created FROM auth_ensure_user($1,$2,$3,$4,true)`, [uuidv7(), b.email, hash, b.fullName])).rows[0];
      const id = uuidv7();
      try {
        await tx.query(`INSERT INTO user_memberships (id, tenant_id, user_id, role_id, all_branches) VALUES ($1,$2,$3,$4,$5)`, [id, a.tenantId, u.id, b.roleId, b.allBranches]);
      } catch (e: any) {
        if (e.code === '23505') throw conflict('ALREADY_MEMBER', 'This person is already a member');
        throw e;
      }
      for (const br of b.branchIds) await tx.query(`INSERT INTO membership_branches (tenant_id, membership_id, branch_id) VALUES ($1,$2,$3)`, [a.tenantId, id, br]);
      await this.audit.record(tx, a, { action: 'member.created', entityType: 'membership', entityId: id, detail: { roleId: b.roleId, allBranches: b.allBranches, branchIds: b.branchIds } });
      return { id };
    }));
  }

  @Patch(':id')
  @RequirePermission('member.manage')
  update(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(patchSchema)) b: z.infer<typeof patchSchema>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const m = (await tx.query(`SELECT id, user_id, role_id, status, all_branches FROM user_memberships WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!m) throw notFound('Member');
      if (m.id === a.membershipId || m.user_id === a.userId) throw forbidden('SELF_MODIFICATION', 'You cannot change your own membership');
      if (b.status === 'active' && m.status !== 'active') {
        await this.ent.assertLimit(tx, a.tenantId!, 'limit.staff_seats', Number((await tx.query(`SELECT count(*) AS n FROM user_memberships WHERE status = 'active'`)).rows[0].n));
      }
      const target = await this.rolePerms(tx, m.role_id);
      this.authz.assertCanManageRolePerms(a, target.grants);
      if (b.roleId && b.roleId !== m.role_id) {
        const next = await this.rolePerms(tx, b.roleId);
        this.authz.assertCanGrant(a, next.grants);
      }
      if (b.allBranches !== undefined || b.branchIds) this.authz.assertBranchScope(a, b.allBranches ?? false, b.branchIds ?? []);

      // Never leave a business without an active owner.
      const leavingOwner = target.role.key === 'owner' && ((b.status && b.status !== 'active') || (b.roleId && b.roleId !== m.role_id));
      if (leavingOwner) {
        const owners = await tx.query(`SELECT count(*)::int AS n FROM user_memberships m JOIN roles r ON r.tenant_id = m.tenant_id AND r.id = m.role_id
                                        WHERE r.key = 'owner' AND m.status = 'active' AND m.id <> $1`, [id]);
        if (owners.rows[0].n < 1) throw conflict('LAST_OWNER', 'A business must keep at least one active owner');
      }
      await tx.query(`UPDATE user_memberships SET role_id = coalesce($2, role_id), status = coalesce($3, status),
                      all_branches = coalesce($4, all_branches) WHERE id = $1`, [id, b.roleId ?? null, b.status ?? null, b.allBranches ?? null]);
      if (b.branchIds) {
        await tx.query(`DELETE FROM membership_branches WHERE membership_id = $1`, [id]);
        for (const br of b.branchIds) await tx.query(`INSERT INTO membership_branches (tenant_id, membership_id, branch_id) VALUES ($1,$2,$3)`, [a.tenantId, id, br]);
      }
      await this.audit.record(tx, a, { action: 'member.updated', entityType: 'membership', entityId: id, detail: b });
      if (b.status === 'suspended' || b.roleId) await this.sessions.revokeForMembership(m.user_id, a.tenantId!);
      return { id };
    });
  }
}
