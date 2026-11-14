import { Inject, Injectable, Logger } from '@nestjs/common';
import { authenticator } from 'otplib';
import { Database } from '@eazy/database';
import { AuditService } from '../audit/audit.service.js';
import { FieldCipher } from '../common/crypto.js';
import { badRequest, notFound, unauthorized } from '../common/errors.js';
import { APP_CONFIG, FIELD_CIPHER } from '../common/tokens.js';
import type { Actor } from '../common/types.js';
import type { AppConfig } from '../config.js';
import { DATABASE } from '../db/db.module.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';

const GENERIC = () => unauthorized('INVALID_CREDENTIALS', 'Invalid email or password');

@Injectable()
export class AuthService {
  private readonly log = new Logger('Auth');
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(PasswordService) private readonly pw: PasswordService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async login(p: { email: string; password: string; totp?: string; tenantSlug?: string; ip?: string; userAgent?: string }) {
    const found = await this.db.pool.query(`SELECT * FROM auth_find_user($1)`, [p.email.toLowerCase()]);
    const u = found.rows[0];
    if (!u || u.status !== 'active') { await this.pw.fakeVerify(p.password); throw GENERIC(); }
    if (u.locked_until && new Date(u.locked_until) > new Date()) { await this.pw.fakeVerify(p.password); throw GENERIC(); }

    const ok = await this.pw.verify(u.password_hash, p.password);
    if (!ok) {
      await this.db.pool.query(`SELECT auth_record_login($1,false,$2,$3)`, [u.id, this.cfg.maxFailedLogins, this.cfg.lockMinutes]);
      this.log.warn(`failed login for user ${u.id}`);
      throw GENERIC();
    }
    let mfaVerified = false;
    if (u.mfa_enabled) {
      if (!p.totp) throw unauthorized('MFA_REQUIRED', 'A verification code is required');
      const secret = this.cipher.decrypt(u.mfa_secret);
      if (!authenticator.check(p.totp, secret)) {
        await this.db.pool.query(`SELECT auth_record_login($1,false,$2,$3)`, [u.id, this.cfg.maxFailedLogins, this.cfg.lockMinutes]);
        throw unauthorized('MFA_INVALID', 'Invalid verification code');
      }
      mfaVerified = true;
    }
    await this.db.pool.query(`SELECT auth_record_login($1,true,$2,$3)`, [u.id, this.cfg.maxFailedLogins, this.cfg.lockMinutes]);

    const memberships = await this.listMemberships(u.id);
    const chosen = p.tenantSlug ? memberships.find((m) => m.slug === p.tenantSlug) : memberships[0];
    if (p.tenantSlug && !chosen) throw GENERIC(); // do not reveal which tenants exist
    const sess = await this.sessions.create({ userId: u.id, tenantId: chosen?.tenantId, mfaVerified, ip: p.ip, userAgent: p.userAgent });
    if (chosen) {
      await this.db.withContext({ tenantId: chosen.tenantId, userId: u.id }, (tx) =>
        this.audit.record(tx, { tenantId: chosen.tenantId, userId: u.id, ip: p.ip }, { action: 'auth.login', entityType: 'user', entityId: u.id }));
    }
    return { ...sess, userId: u.id };
  }

  async listMemberships(userId: string) {
    return this.db.withContext({ userId }, async (tx) => {
      const r = await tx.query(
        `SELECT t.id AS tenant_id, t.slug, t.name, m.status FROM user_memberships m JOIN tenants t ON t.id = m.tenant_id
          WHERE m.user_id = $1 AND m.status = 'active' AND t.status NOT IN ('cancelled','offboarding') ORDER BY t.name`, [userId]);
      return r.rows.map((x) => ({ tenantId: x.tenant_id as string, slug: x.slug as string, name: x.name as string }));
    });
  }

  async me(actor: Actor) {
    const user = await this.db.withContext({ userId: actor.userId }, async (tx) => {
      const r = await tx.query(`SELECT id, email, full_name, mfa_enabled, must_change_password FROM users WHERE id = $1`, [actor.userId]);
      return r.rows[0];
    });
    return {
      user: { id: user.id, email: user.email, fullName: user.full_name, mfaEnabled: user.mfa_enabled, mustChangePassword: user.must_change_password },
      memberships: await this.listMemberships(actor.userId),
      active: actor.tenantId ? {
        tenantId: actor.tenantId, role: actor.roleKey, allBranches: actor.allBranches, branchIds: actor.branchIds,
        permissions: [...actor.permissions.entries()].map(([code, max]) => ({ code, maxAmountMinor: max })),
      } : null,
    };
  }

  async switchTenant(actor: Actor, tenantId: string) {
    const ms = await this.listMemberships(actor.userId);
    if (!ms.some((m) => m.tenantId === tenantId)) throw notFound('Membership');
    await this.sessions.setActiveTenant(actor.sessionId, tenantId);
  }

  async changePassword(actor: Actor, current: string, next: string) {
    const row = await this.db.withContext({ userId: actor.userId }, async (tx) =>
      (await tx.query(`SELECT password_hash FROM users WHERE id = $1`, [actor.userId])).rows[0]);
    if (!row || !(await this.pw.verify(row.password_hash, current))) throw badRequest('INVALID_CURRENT_PASSWORD', 'Current password is incorrect');
    const hash = await this.pw.hash(next);
    await this.db.withContext({ userId: actor.userId }, (tx) =>
      tx.query(`UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1`, [actor.userId, hash]));
    await this.sessions.revokeAllForUser(actor.userId, actor.sessionId);
  }

  async mfaSetup(actor: Actor) {
    const secret = authenticator.generateSecret();
    const user = await this.db.withContext({ userId: actor.userId }, async (tx) => {
      const r = await tx.query(`UPDATE users SET mfa_secret = $2, mfa_enabled = false WHERE id = $1 AND mfa_enabled = false RETURNING email`,
        [actor.userId, this.cipher.encrypt(secret)]);
      return r.rows[0];
    });
    if (!user) throw badRequest('MFA_ALREADY_ENABLED', 'MFA is already enabled');
    return { secret, otpauthUrl: authenticator.keyuri(user.email, 'EazyLaundry', secret) };
  }

  async mfaEnable(actor: Actor, token: string) {
    await this.db.withContext({ userId: actor.userId }, async (tx) => {
      const r = await tx.query(`SELECT mfa_secret, mfa_enabled FROM users WHERE id = $1`, [actor.userId]);
      const row = r.rows[0];
      if (!row?.mfa_secret || row.mfa_enabled) throw badRequest('MFA_NOT_PENDING', 'No MFA setup in progress');
      if (!authenticator.check(token, this.cipher.decrypt(row.mfa_secret))) throw badRequest('MFA_INVALID', 'Invalid verification code');
      await tx.query(`UPDATE users SET mfa_enabled = true WHERE id = $1`, [actor.userId]);
    });
    await this.sessions.revokeAllForUser(actor.userId, actor.sessionId);
  }
}
