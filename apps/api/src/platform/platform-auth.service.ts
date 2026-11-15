import { Inject, Injectable } from '@nestjs/common';
import { authenticator } from 'otplib';
import { randomBytes } from 'node:crypto';
import { Database } from '@eazy/database';
import { PasswordService } from '../auth/password.service.js';
import { FieldCipher } from '../common/crypto.js';
import { sha256 } from '../common/crypto.js';
import { AppError, unauthorized } from '../common/errors.js';
import { uuidv7 } from '../common/ids.js';
import { APP_CONFIG, FIELD_CIPHER, PLATFORM_DB } from '../common/tokens.js';
import type { PlatformActor } from '../common/types.js';
import type { AppConfig } from '../config.js';

export const PSID_COOKIE = 'eazy_psid';
export const PCSRF_COOKIE = 'eazy_pcsrf';
const TTL_HOURS = 8;

/** Platform (Eazy Group operations) sign-in. Password AND an authenticator code are always required. */
@Injectable()
export class PlatformAuthService {
  constructor(
    @Inject(PLATFORM_DB) private readonly db: Database | null, @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher, @Inject(PasswordService) private readonly pw: PasswordService,
  ) {}

  get enabled() { return !!this.db; }
  get ttlMs() { return TTL_HOURS * 3600_000; }
  require(): Database {
    if (!this.db) throw new AppError(503, 'PLATFORM_DISABLED', 'The platform console is not configured on this server');
    return this.db;
  }

  async login(p: { email: string; password: string; totp: string; ip?: string; userAgent?: string }) {
    const db = this.require();
    const generic = () => unauthorized('INVALID_CREDENTIALS', 'Invalid email, password or code');
    const u = (await db.withContext({}, (tx) => tx.query(`SELECT * FROM platform_users WHERE email = $1`, [p.email.toLowerCase()]))).rows[0];
    if (!u || u.status !== 'active' || (u.locked_until && new Date(u.locked_until) > new Date())) { await this.pw.fakeVerify(p.password); throw generic(); }
    const ok = (await this.pw.verify(u.password_hash, p.password)) && authenticator.check(p.totp, this.cipher.decrypt(u.mfa_secret));
    await db.withContext({}, (tx) => tx.query(
      ok ? `UPDATE platform_users SET failed_attempts = 0, locked_until = NULL WHERE id = $1`
         : `UPDATE platform_users SET failed_attempts = failed_attempts + 1, locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END WHERE id = $1`,
      ok ? [u.id] : [u.id, this.cfg.maxFailedLogins, this.cfg.lockMinutes]));
    if (!ok) throw generic();
    const token = randomBytes(32).toString('base64url'); const csrf = randomBytes(24).toString('base64url');
    await db.withContext({}, (tx) => tx.query(
      `INSERT INTO platform_sessions (id, token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5, now() + make_interval(hours => $6))`,
      [uuidv7(), sha256(token), u.id, p.ip ?? null, p.userAgent?.slice(0, 300) ?? null, TTL_HOURS]));
    return { token, csrf };
  }

  async resolve(token: string, ip?: string): Promise<PlatformActor | null> {
    if (!this.db) return null;
    const r = (await this.db.withContext({}, (tx) => tx.query(
      `SELECT s.id AS sid, u.id, u.email, u.full_name, u.role FROM platform_sessions s JOIN platform_users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active'`, [sha256(token)]))).rows[0];
    return r ? { sessionId: r.sid, userId: r.id, email: r.email, fullName: r.full_name, role: r.role, ip } : null;
  }

  async logout(sessionId: string) {
    await this.require().withContext({}, (tx) => tx.query(`UPDATE platform_sessions SET revoked_at = now() WHERE id = $1`, [sessionId]));
  }

  /** Creates a platform user. Returns the authenticator secret ONCE; it is stored encrypted and cannot be shown again. */
  async createUser(p: { email: string; fullName: string; password: string; role: PlatformActor['role'] }) {
    const secret = authenticator.generateSecret();
    const id = uuidv7();
    await this.require().withContext({}, async (tx) => tx.query(`INSERT INTO platform_users (id, email, password_hash, full_name, role, mfa_secret) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, p.email.toLowerCase(), await this.pw.hash(p.password), p.fullName, p.role, this.cipher.encrypt(secret)]));
    return { id, mfaSecret: secret, otpauthUrl: authenticator.keyuri(p.email, 'EazyLaundry Platform', secret) };
  }
}
