import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Database } from '@eazy/database';
import { sha256 } from '../common/crypto.js';
import { uuidv7 } from '../common/ids.js';
import { APP_CONFIG } from '../common/tokens.js';
import type { CustomerActor } from '../common/types.js';
import type { AppConfig } from '../config.js';
import { DATABASE } from '../db/db.module.js';

export const CSID_COOKIE = 'eazy_csid';
export const CCSRF_COOKIE = 'eazy_ccsrf';
const TTL_DAYS = 14;

@Injectable()
export class CustomerSessionService {
  constructor(@Inject(DATABASE) private readonly db: Database, @Inject(APP_CONFIG) private readonly cfg: AppConfig) {}
  get ttlMs() { return TTL_DAYS * 86_400_000; }

  async create(p: { tenantId: string; accountId: string; customerId: string; ip?: string; userAgent?: string }) {
    const token = randomBytes(32).toString('base64url'); const csrf = randomBytes(24).toString('base64url');
    await this.db.withContext({ tenantId: p.tenantId }, (tx) => tx.query(
      `INSERT INTO customer_sessions (id, token_hash, tenant_id, account_id, customer_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(days => $8))`,
      [uuidv7(), sha256(token), p.tenantId, p.accountId, p.customerId, p.ip ?? null, p.userAgent?.slice(0, 300) ?? null, TTL_DAYS]));
    return { token, csrf };
  }

  /** Token -> signed-in customer, re-checking on every request that the account is still active. */
  async resolve(token: string): Promise<CustomerActor | null> {
    const hash = sha256(token);
    const s = (await this.db.withContext({ sessionHash: hash.toString('hex') }, (tx) => tx.query(
      `SELECT id, tenant_id, account_id, customer_id FROM customer_sessions WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`, [hash]))).rows[0];
    if (!s) return null;
    const a = (await this.db.withContext({ tenantId: s.tenant_id, customerId: s.customer_id, allBranches: true }, (tx) => tx.query(
      `SELECT ca.email, ca.status FROM customer_accounts ca WHERE ca.id = $1 AND ca.customer_id = $2`, [s.account_id, s.customer_id]))).rows[0];
    if (!a || a.status !== 'active') return null;
    return { sessionId: s.id, accountId: s.account_id, customerId: s.customer_id, tenantId: s.tenant_id, email: a.email };
  }

  revoke(tenantId: string, sessionId: string) {
    return this.db.withContext({ tenantId }, (tx) => tx.query(`UPDATE customer_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [sessionId]));
  }
  revokeAllForAccount(tenantId: string, accountId: string) {
    return this.db.withContext({ tenantId }, (tx) => tx.query(`UPDATE customer_sessions SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL`, [accountId]));
  }
}
