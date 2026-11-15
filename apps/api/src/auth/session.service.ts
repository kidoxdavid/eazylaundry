import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Database } from '@eazy/database';
import { APP_CONFIG } from '../common/tokens.js';
import { sha256 } from '../common/crypto.js';
import { uuidv7 } from '../common/ids.js';
import type { Actor } from '../common/types.js';
import type { AppConfig } from '../config.js';
import { DATABASE } from '../db/db.module.js';

export const SID_COOKIE = 'eazy_sid';
export const CSRF_COOKIE = 'eazy_csrf';

@Injectable()
export class SessionService {
  constructor(@Inject(DATABASE) private readonly db: Database, @Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  async create(p: { userId: string; tenantId?: string; mfaVerified: boolean; ip?: string; userAgent?: string }) {
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    await this.db.pool.query(
      `INSERT INTO sessions (id, token_hash, user_id, active_tenant_id, mfa_verified, ip, user_agent, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(hours => $8))`,
      [uuidv7(), sha256(token), p.userId, p.tenantId ?? null, p.mfaVerified, p.ip ?? null,
       p.userAgent?.slice(0, 300) ?? null, this.cfg.sessionTtlHours]);
    return { token, csrf };
  }

  /** Resolves a cookie token into an Actor, re-reading membership/role state on EVERY request (changes apply immediately). */
  async resolve(token: string, ip?: string): Promise<Actor | null> {
    const s = await this.db.pool.query(
      `SELECT id, user_id, active_tenant_id, mfa_verified, last_seen_at FROM sessions
        WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
          AND last_seen_at > now() - make_interval(mins => $2)`, [sha256(token), this.cfg.sessionIdleMinutes]);
    const row = s.rows[0];
    if (!row) return null;
    await this.db.pool.query(
      `UPDATE sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '60 seconds'`, [row.id]);

    const actor: Actor = {
      sessionId: row.id, userId: row.user_id, mfaVerified: row.mfa_verified, mustChangePassword: false,
      permissions: new Map(), allBranches: false, branchIds: [], ip,
    };

    // The user must still be active.
    const ctxUser = { userId: row.user_id, tenantId: row.active_tenant_id ?? undefined };
    const ok = await this.db.withContext(ctxUser, async (tx) => {
      const u = await tx.query(`SELECT status, must_change_password FROM users WHERE id = $1`, [row.user_id]);
      if (u.rows[0]?.status !== 'active') return false;
      actor.mustChangePassword = u.rows[0].must_change_password;
      if (!row.active_tenant_id) return true;
      const m = await tx.query(
        `SELECT m.id, m.role_id, m.all_branches, r.key AS role_key, t.status AS tenant_status
           FROM user_memberships m
           JOIN roles r ON r.tenant_id = m.tenant_id AND r.id = m.role_id
           JOIN tenants t ON t.id = m.tenant_id
          WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.status = 'active'
            AND t.status NOT IN ('cancelled','offboarding')`, [row.active_tenant_id, row.user_id]);
      const mem = m.rows[0];
      if (!mem) return true; // authenticated but no usable membership in the selected tenant
      actor.tenantId = row.active_tenant_id; actor.membershipId = mem.id; actor.roleId = mem.role_id;
      actor.roleKey = mem.role_key; actor.tenantStatus = mem.tenant_status; actor.allBranches = mem.all_branches;
      const perms = await tx.query(
        `SELECT permission_code, max_amount_minor FROM role_permissions WHERE role_id = $1`, [mem.role_id]);
      for (const p of perms.rows) actor.permissions.set(p.permission_code, p.max_amount_minor === null ? null : Number(p.max_amount_minor));
      const b = await tx.query(`SELECT branch_id FROM membership_branches WHERE membership_id = $1`, [mem.id]);
      actor.branchIds = b.rows.map((x) => x.branch_id);
      return true;
    });
    return ok ? actor : null;
  }

  revoke(sessionId: string) {
    return this.db.pool.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [sessionId]);
  }
  revokeAllForUser(userId: string, exceptSessionId?: string) {
    return this.db.pool.query(
      `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2)`,
      [userId, exceptSessionId ?? null]);
  }
  /** Revoke a user's sessions that are active in a given tenant (used when a membership changes). */
  revokeForMembership(userId: string, tenantId: string) {
    return this.db.pool.query(
      `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND active_tenant_id = $2 AND revoked_at IS NULL`, [userId, tenantId]);
  }
  setActiveTenant(sessionId: string, tenantId: string) {
    return this.db.pool.query(`UPDATE sessions SET active_tenant_id = $2 WHERE id = $1`, [sessionId, tenantId]);
  }
}
