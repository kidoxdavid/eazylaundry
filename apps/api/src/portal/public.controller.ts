import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { z } from 'zod';
import { Database, type Tx } from '@eazy/database';
import { PasswordService } from '../auth/password.service.js';
import { AuthThrottle, CustomerOnly, Public } from '../common/access.js';
import { phone } from '../common/canada.js';
import { sha256 } from '../common/crypto.js';
import { CurrentCustomer } from '../common/current-actor.js';
import { AppError, notFound, unauthorized } from '../common/errors.js';
import { uuidv7 } from '../common/ids.js';
import { APP_CONFIG } from '../common/tokens.js';
import type { AppRequest, CustomerActor } from '../common/types.js';
import { ZodPipe } from '../common/zod.pipe.js';
import type { AppConfig } from '../config.js';
import { DATABASE } from '../db/db.module.js';
import { EntitlementService } from '../billing/entitlements.service.js';
import { ZonesService, compactPostal } from '../logistics/zones.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { CCSRF_COOKIE, CSID_COOKIE, CustomerSessionService } from './customer-session.service.js';

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(12, 'Use at least 12 characters').max(128);
const registerSchema = z.object({ fullName: z.string().trim().min(2).max(120), email, phone: phone.optional(), password });
const loginSchema = z.object({ email, password: z.string().min(1).max(128) });
const tokenSchema = z.object({ token: z.string().min(20).max(100) });
const forgotSchema = z.object({ email });
const resetSchema = z.object({ token: z.string().min(20).max(100), password });

const VERIFY_HOURS = 24; const RESET_HOURS = 1; const MAX_FAILED = 5; const LOCK_MINUTES = 15;
const hashToken = (t: string) => sha256(t);
const newToken = () => randomBytes(32).toString('base64url');

export interface PublicTenant { id: string; name: string; slug: string }

@Controller()
export class PublicController {
  constructor(
    @Inject(DATABASE) private readonly db: Database, @Inject(APP_CONFIG) private readonly cfg: AppConfig, @Inject(PasswordService) private readonly pw: PasswordService,
    @Inject(CustomerSessionService) private readonly sessions: CustomerSessionService, @Inject(NotificationsService) private readonly notify: NotificationsService,
    @Inject(ZonesService) private readonly zones: ZonesService, @Inject(EntitlementService) private readonly ent: EntitlementService,
  ) {}

  /** Resolves a storefront slug to its business, then continues in THAT business's context. Unknown and inactive businesses look identical. */
  private run<T>(slug: string, fn: (tx: Tx, t: PublicTenant) => Promise<T>): Promise<T> {
    return this.db.withContext({ publicSlug: slug }, async (tx) => {
      const t = (await tx.query(`SELECT id, name, slug, status FROM tenants WHERE slug = $1`, [slug])).rows[0];
      if (!t || !['trial', 'active', 'past_due'].includes(t.status)) throw notFound('Business');
      await tx.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.public_slug', '', true)`, [t.id]);
      // A business whose plan has no storefront does not have one: identical to an unknown business.
      if (!(await this.ent.hasModule(tx, t.id, 'module.storefront'))) throw notFound('Business');
      return fn(tx, { id: t.id, name: t.name, slug: t.slug });
    });
  }

  private setCookies(res: Response, s: { token: string; csrf: string }) {
    const base = { sameSite: 'lax' as const, secure: this.cfg.cookieSecure, path: '/', maxAge: this.sessions.ttlMs };
    res.cookie(CSID_COOKIE, s.token, { ...base, httpOnly: true });
    res.cookie(CCSRF_COOKIE, s.csrf, { ...base, httpOnly: false });
  }

  // ---------------------------------------------------------------- public storefront data
  @Get('public/:slug')
  @Public()
  info(@Param('slug') slug: string) {
    return this.run(slug, async (tx, t) => {
      const branches = (await tx.query(`SELECT name, address->>'city' AS city FROM branches WHERE status = 'active' ORDER BY created_at`)).rows;
      return { name: t.name, slug: t.slug, branches: branches.map((b) => ({ name: b.name, city: b.city })) };
    });
  }

  @Get('public/:slug/services')
  @Public()
  services(@Param('slug') slug: string) {
    return this.run(slug, async (tx) => {
      const r = await tx.query(
        `SELECT s.id, s.name, s.description, s.pricing_model, s.tax_category, s.express_capable, s.turnaround_hours,
                p.unit_price_minor, p.min_charge_minor, p.express_type, p.express_percent, p.express_fixed_minor
           FROM services s JOIN LATERAL (
             SELECT sp.* FROM service_prices sp JOIN price_lists pl ON pl.tenant_id = sp.tenant_id AND pl.id = sp.price_list_id
              WHERE sp.service_id = s.id AND pl.is_default AND sp.branch_id IS NULL AND sp.valid_from <= now() ORDER BY sp.valid_from DESC, sp.id DESC LIMIT 1) p ON true
          WHERE s.archived_at IS NULL ORDER BY lower(s.name)`);
      return { items: r.rows.map((x) => ({ id: x.id, name: x.name, description: x.description, pricingModel: x.pricing_model, taxable: x.tax_category === 'taxable', expressAvailable: x.express_capable && x.express_type !== 'none',
        turnaroundHours: x.turnaround_hours, unitPriceMinor: Number(x.unit_price_minor), minChargeMinor: Number(x.min_charge_minor) })) };
    });
  }

  @Get('public/:slug/coverage')
  @Public()
  coverage(@Param('slug') slug: string, @Query('postalCode') postal: string) {
    return this.run(slug, async (tx) => {
      const p = compactPostal(postal ?? '');
      if (!/^[A-Z]\d[A-Z]\d?[A-Z]?\d?$/.test(p)) throw new AppError(400, 'VALIDATION_ERROR', 'Enter a Canadian postal code');
      const z2 = await this.zones.resolve(tx, p);
      return z2 ? { covered: true, zone: z2.name, feeMinor: Number(z2.feeMinor), freeOverMinor: z2.freeOverMinor === null ? null : Number(z2.freeOverMinor), minOrderMinor: Number(z2.minOrderMinor) } : { covered: false };
    });
  }

  // ---------------------------------------------------------------- accounts
  /**
   * Creates a PENDING account. The response is identical whether or not the email is already known (no account enumeration).
   * If a walk-in customer with this email exists, the account links to it, but only becomes usable after the email is verified.
   */
  @Post('public/:slug/register')
  @Public()
  @AuthThrottle()
  @HttpCode(202)
  async register(@Param('slug') slug: string, @Body(new ZodPipe(registerSchema)) b: z.infer<typeof registerSchema>) {
    const hash = await this.pw.hash(b.password); // always hashed, so both paths cost about the same
    await this.run(slug, async (tx, t) => {
      const brand = await this.notify.brand(tx);
      const existing = (await tx.query(`SELECT id, customer_id, status FROM customer_accounts WHERE email = $1`, [b.email])).rows[0];
      if (existing) {
        await this.notify.enqueue(tx, { tenantId: t.id, customerId: existing.customer_id, to: b.email, template: 'portal.account_exists',
          dedupeKey: `portal.account_exists:${existing.id}:${new Date().toISOString().slice(0, 13)}`, vars: { url: `${brand.base}/login` } });
        return;
      }
      let customerId = (await tx.query(`SELECT id FROM customers WHERE email = $1 AND archived_at IS NULL`, [b.email])).rows[0]?.id as string | undefined;
      if (customerId && (await tx.query(`SELECT 1 FROM customer_accounts WHERE customer_id = $1`, [customerId])).rowCount) customerId = undefined;
      let name = b.fullName;
      if (!customerId) {
        customerId = uuidv7();
        const phoneFree = b.phone && !(await tx.query(`SELECT 1 FROM customers WHERE phone = $1 AND archived_at IS NULL`, [b.phone])).rowCount;
        await tx.query(`INSERT INTO customers (id, tenant_id, kind, full_name, email, phone, created_by) VALUES ($1,$2,'individual',$3,$4,$5,$6)`,
          [customerId, t.id, b.fullName, b.email, phoneFree ? b.phone : null, customerId]);
      } else {
        name = (await tx.query(`SELECT full_name FROM customers WHERE id = $1`, [customerId])).rows[0].full_name;
      }
      const accountId = uuidv7();
      await tx.query(`INSERT INTO customer_accounts (id, tenant_id, customer_id, email, password_hash) VALUES ($1,$2,$3,$4,$5)`, [accountId, t.id, customerId, b.email, hash]);
      const token = newToken();
      await tx.query(`INSERT INTO customer_tokens (id, tenant_id, account_id, purpose, token_hash, expires_at) VALUES ($1,$2,$3,'verify_email',$4, now() + make_interval(hours => $5))`, [uuidv7(), t.id, accountId, hashToken(token), VERIFY_HOURS]);
      await this.notify.enqueue(tx, { tenantId: t.id, customerId, to: b.email, template: 'portal.verify_email', dedupeKey: `portal.verify_email:${accountId}`, vars: { name, url: `${brand.base}/verify?token=${token}` } });
    });
    return { ok: true, message: 'If this email can be used, we have sent a confirmation link.' };
  }

  @Post('public/:slug/verify-email')
  @Public()
  @AuthThrottle()
  @HttpCode(200)
  verify(@Param('slug') slug: string, @Body(new ZodPipe(tokenSchema)) b: z.infer<typeof tokenSchema>) {
    return this.run(slug, async (tx) => {
      const t = (await tx.query(`SELECT id, account_id FROM customer_tokens WHERE token_hash = $1 AND purpose = 'verify_email' AND used_at IS NULL AND expires_at > now() FOR UPDATE`, [hashToken(b.token)])).rows[0];
      if (!t) throw new AppError(400, 'INVALID_TOKEN', 'This link is invalid or has expired');
      await tx.query(`UPDATE customer_tokens SET used_at = now() WHERE id = $1`, [t.id]);
      await tx.query(`UPDATE customer_accounts SET status = 'active', email_verified_at = now() WHERE id = $1 AND status = 'pending'`, [t.account_id]);
      return { ok: true };
    });
  }

  @Post('public/:slug/login')
  @Public()
  @AuthThrottle()
  @HttpCode(200)
  async login(@Param('slug') slug: string, @Body(new ZodPipe(loginSchema)) b: z.infer<typeof loginSchema>, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    const generic = () => unauthorized('INVALID_CREDENTIALS', 'Invalid email or password');
    const r = await this.run(slug, async (tx, t) => {
      const a = (await tx.query(`SELECT id, customer_id, password_hash, status, failed_attempts, locked_until FROM customer_accounts WHERE email = $1`, [b.email])).rows[0];
      return { t, a };
    });
    if (!r.a || (r.a.locked_until && new Date(r.a.locked_until) > new Date())) { await this.pw.fakeVerify(b.password); throw generic(); }
    const ok = await this.pw.verify(r.a.password_hash, b.password);
    await this.run(slug, (tx) => tx.query(
      ok ? `UPDATE customer_accounts SET failed_attempts = 0, locked_until = NULL WHERE id = $1`
         : `UPDATE customer_accounts SET failed_attempts = failed_attempts + 1, locked_until = CASE WHEN failed_attempts + 1 >= ${MAX_FAILED} THEN now() + interval '${LOCK_MINUTES} minutes' ELSE locked_until END WHERE id = $1`, [r.a.id]));
    if (!ok) throw generic();
    if (r.a.status === 'pending') throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Please confirm your email address first. Check your inbox for the link.');
    if (r.a.status !== 'active') throw generic();
    const s = await this.sessions.create({ tenantId: r.t.id, accountId: r.a.id, customerId: r.a.customer_id, ip: req.ip, userAgent: req.headers['user-agent'] });
    this.setCookies(res, s);
    return { ok: true };
  }

  @Post('public/:slug/forgot-password')
  @Public()
  @AuthThrottle()
  @HttpCode(202)
  async forgot(@Param('slug') slug: string, @Body(new ZodPipe(forgotSchema)) b: z.infer<typeof forgotSchema>) {
    await this.run(slug, async (tx, t) => {
      const a = (await tx.query(`SELECT a.id, a.customer_id, c.full_name FROM customer_accounts a JOIN customers c ON c.tenant_id = a.tenant_id AND c.id = a.customer_id WHERE a.email = $1 AND a.status = 'active'`, [b.email])).rows[0];
      if (!a) return;
      const token = newToken(); const brand = await this.notify.brand(tx);
      await tx.query(`INSERT INTO customer_tokens (id, tenant_id, account_id, purpose, token_hash, expires_at) VALUES ($1,$2,$3,'reset_password',$4, now() + make_interval(hours => $5))`, [uuidv7(), t.id, a.id, hashToken(token), RESET_HOURS]);
      await this.notify.enqueue(tx, { tenantId: t.id, customerId: a.customer_id, to: b.email, template: 'portal.reset_password', vars: { name: a.full_name, url: `${brand.base}/reset?token=${token}` } });
    });
    return { ok: true, message: 'If an account exists for this email, we have sent a reset link.' };
  }

  @Post('public/:slug/reset-password')
  @Public()
  @AuthThrottle()
  @HttpCode(200)
  async reset(@Param('slug') slug: string, @Body(new ZodPipe(resetSchema)) b: z.infer<typeof resetSchema>) {
    const hash = await this.pw.hash(b.password);
    return this.run(slug, async (tx, t) => {
      const tk = (await tx.query(`SELECT id, account_id FROM customer_tokens WHERE token_hash = $1 AND purpose = 'reset_password' AND used_at IS NULL AND expires_at > now() FOR UPDATE`, [hashToken(b.token)])).rows[0];
      if (!tk) throw new AppError(400, 'INVALID_TOKEN', 'This link is invalid or has expired');
      await tx.query(`UPDATE customer_tokens SET used_at = now() WHERE id = $1`, [tk.id]);
      await tx.query(`UPDATE customer_accounts SET password_hash = $2, failed_attempts = 0, locked_until = NULL WHERE id = $1`, [tk.account_id, hash]);
      await tx.query(`UPDATE customer_sessions SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL`, [tk.account_id]); // everyone is signed out
      return { ok: true };
    });
  }

  @Post('portal/logout')
  @CustomerOnly()
  @HttpCode(204)
  async logout(@CurrentCustomer() c: CustomerActor, @Res({ passthrough: true }) res: Response) {
    await this.sessions.revoke(c.tenantId, c.sessionId);
    res.clearCookie(CSID_COOKIE, { path: '/' }); res.clearCookie(CCSRF_COOKIE, { path: '/' });
  }
}
