import { Inject, Injectable } from '@nestjs/common';
import { Database, ROLE_TEMPLATES } from '@eazy/database';
import { AuditService } from '../audit/audit.service.js';
import { PasswordService } from '../auth/password.service.js';
import { conflict } from '../common/errors.js';
import { uuidv7 } from '../common/ids.js';
import { DATABASE } from '../db/db.module.js';

const RESERVED = new Set(['www', 'api', 'app', 'admin', 'platform', 'portal', 'storefront', 'static', 'assets', 'mail',
  'support', 'status', 'billing', 'eazy', 'eazylaundry', 'login', 'register', 'docs', 'cdn']);

export function slugify(name: string) {
  const s = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return s.length >= 3 ? s : `biz-${s}`.replace(/-+$/, '');
}

export interface RegisterInput {
  businessName: string; ownerName: string; email: string; password: string;
  branchName: string; branchCode: string; timezone: string;
}

@Injectable()
export class TenantsService {
  constructor(@Inject(DATABASE) private readonly db: Database, @Inject(PasswordService) private readonly pw: PasswordService,
              @Inject(AuditService) private readonly audit: AuditService) {}

  /**
   * Creates tenant + organization + first branch + role set + owner membership in ONE transaction.
   * RLS context is set to the NEW tenant/user ids, so even registration runs without any bypass.
   */
  async register(input: RegisterInput, ip?: string) {
    const hash = await this.pw.hash(input.password);
    let base = slugify(input.businessName);
    if (RESERVED.has(base)) base = `${base}-co`;
    for (let attempt = 0; attempt < 6; attempt++) {
      const slug = attempt === 0 ? base : `${base.slice(0, 28)}-${Math.random().toString(36).slice(2, 6)}`;
      const tenantId = uuidv7(), userId = uuidv7();
      try {
        return await this.db.withContext({ tenantId, userId, allBranches: true }, async (tx) => {
          const u = await tx.query(`SELECT id, created FROM auth_ensure_user($1,$2,$3,$4,false)`,
            [userId, input.email.toLowerCase(), hash, input.ownerName]);
          if (!u.rows[0].created) throw conflict('EMAIL_IN_USE', 'This email is already registered. Sign in instead.');
          await tx.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3)`, [tenantId, slug, input.businessName]);
          await tx.query(`INSERT INTO organizations (id, tenant_id, legal_name, timezone) VALUES ($1,$2,$3,$4)`,
            [uuidv7(), tenantId, input.businessName, input.timezone]);
          const branchId = uuidv7();
          await tx.query(`INSERT INTO branches (id, tenant_id, code, name, timezone) VALUES ($1,$2,$3,$4,$5)`,
            [branchId, tenantId, input.branchCode, input.branchName, input.timezone]);
          let ownerRoleId = '';
          for (const t of ROLE_TEMPLATES) {
            const roleId = uuidv7();
            if (t.key === 'owner') ownerRoleId = roleId;
            await tx.query(`INSERT INTO roles (id, tenant_id, key, name, is_system) VALUES ($1,$2,$3,$4,true)`, [roleId, tenantId, t.key, t.name]);
            for (const code of t.permissions) {
              await tx.query(`INSERT INTO role_permissions (tenant_id, role_id, permission_code) VALUES ($1,$2,$3)`, [tenantId, roleId, code]);
            }
          }
          const membershipId = uuidv7();
          await tx.query(`INSERT INTO user_memberships (id, tenant_id, user_id, role_id, all_branches) VALUES ($1,$2,$3,$4,true)`,
            [membershipId, tenantId, userId, ownerRoleId]);
          await this.audit.record(tx, { tenantId, userId, membershipId, ip }, {
            action: 'tenant.registered', entityType: 'tenant', entityId: tenantId, detail: { slug } });
          return { tenantId, userId, slug, branchId };
        });
      } catch (e: any) {
        if (e?.code === '23505' && /tenants_slug_key/.test(e.constraint ?? e.message ?? '')) continue;
        throw e;
      }
    }
    throw conflict('SLUG_UNAVAILABLE', 'Could not allocate a business address, try a different name');
  }
}
