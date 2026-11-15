import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Database, type Tx } from '@eazy/database';
import { AuthThrottle, PlatformOnly, Public } from '../common/access.js';
import { ENTITLEMENT_KEYS, TRIAL_PLAN, validEntitlementValue } from '../billing/entitlements.service.js';
import { CurrentPlatform } from '../common/current-actor.js';
import { AppError, conflict, notFound } from '../common/errors.js';
import { uuidv7 } from '../common/ids.js';
import { APP_CONFIG } from '../common/tokens.js';
import type { AppRequest, PlatformActor } from '../common/types.js';
import { ZodPipe } from '../common/zod.pipe.js';
import type { AppConfig } from '../config.js';
import { LifecycleService } from './lifecycle.service.js';
import { PCSRF_COOKIE, PSID_COOKIE, PlatformAuthService } from './platform-auth.service.js';

const loginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(128), totp: z.string().regex(/^\d{6}$/) });
const listQuery = z.object({ q: z.string().trim().max(60).optional(), status: z.enum(['trial', 'active', 'past_due', 'suspended', 'cancelled', 'offboarding']).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) });
const planChange = z.object({ planCode: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/), periodEnd: z.string().datetime().optional() });
const statusChange = z.object({ status: z.enum(['active', 'past_due', 'suspended', 'cancelled']), reason: z.string().trim().min(3).max(300) });
const trialExtend = z.object({ days: z.number().int().min(1).max(90) });
const overrideSchema = z.object({ key: z.string(), value: z.unknown(), reason: z.string().trim().min(3).max(300), expiresAt: z.string().datetime().optional() });
const planPatch = z.object({ name: z.string().trim().min(1).max(60), priceMinor: z.number().int().min(0).max(10_000_00).nullable(), active: z.boolean(), isPublic: z.boolean() }).partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');
const planEntitlements = z.object({ entitlements: z.record(z.unknown()) });
const auditQuery = z.object({ tenantId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });

const N = (v: unknown) => Number(v);
const mapTenant = (r: any) => ({
  id: r.id, slug: r.slug, name: r.name, status: r.status, createdAt: r.created_at, plan: r.plan_code ? { code: r.plan_code, name: r.plan_name } : null,
  trialEndsAt: r.trial_ends_at, currentPeriodEnd: r.current_period_end, cancelAtPeriodEnd: r.cancel_at_period_end ?? false, pastDueSince: r.past_due_since, statusReason: r.status_reason,
  usage: { branches: N(r.branches), staffSeats: N(r.seats), ordersThisMonth: N(r.orders_month) },
});
const TENANT_SELECT = `SELECT t.id, t.slug, t.name, t.status, t.created_at, p.code AS plan_code, p.name AS plan_name, s.trial_ends_at, s.current_period_end, s.cancel_at_period_end, s.past_due_since, s.status_reason,
    (SELECT count(id) FROM branches b WHERE b.tenant_id = t.id AND b.status = 'active') AS branches,
    (SELECT count(id) FROM user_memberships m WHERE m.tenant_id = t.id AND m.status = 'active') AS seats,
    (SELECT count(id) FROM orders o WHERE o.tenant_id = t.id AND o.created_at >= date_trunc('month', now())) AS orders_month
  FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id = t.id LEFT JOIN subscription_plans p ON p.id = s.plan_id`;

/**
 * Eazy Group SaaS console API. A separate realm from businesses: its own users (authenticator code mandatory), cookies and database role.
 * The role sees tenant metadata and usage counts, never customers, orders' contents, prices or finances.
 */
@Controller('platform')
export class PlatformController {
  constructor(
    @Inject(PlatformAuthService) private readonly auth: PlatformAuthService, @Inject(LifecycleService) private readonly lifecycle: LifecycleService, @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private database(): Database { return this.auth.require(); }
  private audit(tx: Tx, p: PlatformActor, action: string, tenantId: string | null, detail: Record<string, unknown>) {
    return tx.query(`INSERT INTO platform_audit_logs (id, actor_user_id, action, target_tenant_id, detail, ip) VALUES ($1,$2,$3,$4,$5,$6)`, [uuidv7(), p.userId, action, tenantId, JSON.stringify(detail), p.ip ?? null]);
  }

  // ------------------------------------------------------------------ auth
  @Post('auth/login')
  @Public()
  @AuthThrottle()
  @HttpCode(200)
  async login(@Body(new ZodPipe(loginSchema)) b: z.infer<typeof loginSchema>, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    const s = await this.auth.login({ ...b, ip: req.ip, userAgent: req.headers['user-agent'] });
    const base = { sameSite: 'strict' as const, secure: this.cfg.cookieSecure, path: '/', maxAge: this.auth.ttlMs };
    res.cookie(PSID_COOKIE, s.token, { ...base, httpOnly: true }); res.cookie(PCSRF_COOKIE, s.csrf, { ...base, httpOnly: false });
    return { ok: true };
  }

  @Get('auth/me')
  @PlatformOnly()
  me(@CurrentPlatform() p: PlatformActor) { return { id: p.userId, email: p.email, fullName: p.fullName, role: p.role }; }

  @Post('auth/logout')
  @PlatformOnly()
  @HttpCode(204)
  async logout(@CurrentPlatform() p: PlatformActor, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(p.sessionId);
    res.clearCookie(PSID_COOKIE, { path: '/' }); res.clearCookie(PCSRF_COOKIE, { path: '/' });
  }

  // ------------------------------------------------------------------ tenants
  @Get('tenants')
  @PlatformOnly()
  tenants(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.database().withContext({}, async (tx) => {
      const where: string[] = []; const p: unknown[] = [];
      if (q.status) { p.push(q.status); where.push(`t.status = $${p.length}`); }
      if (q.q) { p.push(`%${q.q.split('\\').join('\\\\').split('%').join('\\%').split('_').join('\\_')}%`); where.push(`(t.name ILIKE $${p.length} OR t.slug ILIKE $${p.length})`); }
      p.push(q.limit);
      const r = await tx.query(`${TENANT_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.created_at DESC LIMIT $${p.length}`, p);
      return { items: r.rows.map(mapTenant) };
    });
  }

  @Get('tenants/:id')
  @PlatformOnly()
  tenant(@Param('id', ParseUUIDPipe) id: string) {
    return this.database().withContext({}, async (tx) => {
      const t = (await tx.query(`${TENANT_SELECT} WHERE t.id = $1`, [id])).rows[0];
      if (!t) throw notFound('Tenant');
      const planEnts = t.plan_code ? (await tx.query(`SELECT e.key, e.value FROM plan_entitlements e JOIN subscriptions s ON s.plan_id = e.plan_id WHERE s.tenant_id = $1`, [id])).rows : [];
      const overrides = (await tx.query(`SELECT key, value, reason, expires_at, created_at FROM tenant_entitlement_overrides WHERE tenant_id = $1 ORDER BY key`, [id])).rows;
      const effective: Record<string, unknown> = Object.fromEntries(planEnts.map((e) => [e.key, e.value]));
      for (const o of overrides) if (!o.expires_at || new Date(o.expires_at) > new Date()) effective[o.key] = o.value;
      return { ...mapTenant(t), entitlements: effective,
        overrides: overrides.map((o) => ({ key: o.key, value: o.value, reason: o.reason, expiresAt: o.expires_at, expired: !!o.expires_at && new Date(o.expires_at) <= new Date() })) };
    });
  }

  @Post('tenants/:id/plan')
  @PlatformOnly('platform_admin', 'billing_ops')
  @HttpCode(200)
  changePlan(@CurrentPlatform() p: PlatformActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(planChange)) b: z.infer<typeof planChange>) {
    return this.database().withContext({}, async (tx) => {
      if (!(await tx.query(`SELECT 1 FROM tenants WHERE id = $1 FOR UPDATE`, [id])).rowCount) throw notFound('Tenant');
      const plan = (await tx.query(`SELECT id, code FROM subscription_plans WHERE code = $1 AND active`, [b.planCode])).rows[0];
      if (!plan) throw new AppError(422, 'UNKNOWN_PLAN', 'No active plan with that code');
      const prev = (await tx.query(`SELECT p.code FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id WHERE s.tenant_id = $1`, [id])).rows[0]?.code ?? null;
      await tx.query(`INSERT INTO subscriptions (tenant_id, plan_id, current_period_start, current_period_end) VALUES ($1,$2, now(), $3)
                      ON CONFLICT (tenant_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, current_period_start = now(), current_period_end = EXCLUDED.current_period_end, updated_at = now()`, [id, plan.id, b.periodEnd ?? null]);
      await this.audit(tx, p, 'tenant.plan_changed', id, { from: prev, to: b.planCode, periodEnd: b.periodEnd ?? null });
      return { id, plan: b.planCode };
    });
  }

  @Post('tenants/:id/status')
  @PlatformOnly('platform_admin', 'billing_ops')
  @HttpCode(200)
  changeStatus(@CurrentPlatform() p: PlatformActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(statusChange)) b: z.infer<typeof statusChange>) {
    return this.database().withContext({}, async (tx) => {
      const t = (await tx.query(`SELECT status FROM tenants WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!t) throw notFound('Tenant');
      if (t.status === 'offboarding') throw conflict('OFFBOARDING', 'This business is being offboarded');
      await tx.query(`UPDATE tenants SET status = $2 WHERE id = $1`, [id, b.status]);
      await tx.query(`INSERT INTO subscriptions (tenant_id, plan_id) SELECT $1, id FROM subscription_plans WHERE code = $2 ON CONFLICT DO NOTHING`, [id, TRIAL_PLAN]);
      await tx.query(`UPDATE subscriptions SET status_reason = $2, past_due_since = CASE WHEN $3 = 'past_due' THEN coalesce(past_due_since, now()) ELSE NULL END, updated_at = now() WHERE tenant_id = $1`, [id, b.reason, b.status]);
      await this.audit(tx, p, 'tenant.status_changed', id, { from: t.status, to: b.status, reason: b.reason });
      return { id, status: b.status };
    });
  }

  @Post('tenants/:id/trial/extend')
  @PlatformOnly('platform_admin', 'billing_ops')
  @HttpCode(200)
  extendTrial(@CurrentPlatform() p: PlatformActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(trialExtend)) b: z.infer<typeof trialExtend>) {
    return this.database().withContext({}, async (tx) => {
      const t = (await tx.query(`SELECT status FROM tenants WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!t) throw notFound('Tenant');
      await tx.query(`INSERT INTO subscriptions (tenant_id, plan_id) SELECT $1, id FROM subscription_plans WHERE code = $2 ON CONFLICT DO NOTHING`, [id, TRIAL_PLAN]);
      const s = (await tx.query(`SELECT status_reason FROM subscriptions WHERE tenant_id = $1 FOR UPDATE`, [id])).rows[0];
      if (t.status !== 'trial' && !(t.status === 'suspended' && s.status_reason === 'trial_ended')) throw conflict('NOT_IN_TRIAL', 'Only a business on trial (or whose trial just ended) can be given more trial time');
      const r = (await tx.query(`UPDATE subscriptions SET trial_ends_at = greatest(now(), coalesce(trial_ends_at, now())) + make_interval(days => $2), status_reason = NULL, updated_at = now() WHERE tenant_id = $1 RETURNING trial_ends_at`, [id, b.days])).rows[0];
      await tx.query(`UPDATE tenants SET status = 'trial' WHERE id = $1`, [id]);
      await this.audit(tx, p, 'tenant.trial_extended', id, { days: b.days, trialEndsAt: r.trial_ends_at });
      return { id, trialEndsAt: r.trial_ends_at };
    });
  }

  @Put('tenants/:id/overrides')
  @PlatformOnly('platform_admin', 'billing_ops')
  setOverride(@CurrentPlatform() p: PlatformActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(overrideSchema)) b: z.infer<typeof overrideSchema>) {
    if (!(b.key in ENTITLEMENT_KEYS) || !validEntitlementValue(b.key, b.value)) throw new AppError(422, 'INVALID_ENTITLEMENT', 'Unknown entitlement key or invalid value for it');
    return this.database().withContext({}, async (tx) => {
      if (!(await tx.query(`SELECT 1 FROM tenants WHERE id = $1`, [id])).rowCount) throw notFound('Tenant');
      await tx.query(`INSERT INTO tenant_entitlement_overrides (id, tenant_id, key, value, reason, expires_at, set_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
                      ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, reason = EXCLUDED.reason, expires_at = EXCLUDED.expires_at, set_by = EXCLUDED.set_by, created_at = now()`,
        [uuidv7(), id, b.key, JSON.stringify(b.value), b.reason, b.expiresAt ?? null, p.userId]);
      await this.audit(tx, p, 'tenant.override_set', id, { key: b.key, value: b.value, reason: b.reason, expiresAt: b.expiresAt ?? null });
      return { key: b.key };
    });
  }

  @Delete('tenants/:id/overrides/:key')
  @PlatformOnly('platform_admin', 'billing_ops')
  @HttpCode(204)
  removeOverride(@CurrentPlatform() p: PlatformActor, @Param('id', ParseUUIDPipe) id: string, @Param('key') key: string) {
    return this.database().withContext({}, async (tx) => {
      const r = await tx.query(`DELETE FROM tenant_entitlement_overrides WHERE tenant_id = $1 AND key = $2`, [id, key]);
      if (!r.rowCount) throw notFound('Override');
      await this.audit(tx, p, 'tenant.override_removed', id, { key });
    });
  }

  // ------------------------------------------------------------------ plans
  @Get('plans')
  @PlatformOnly()
  plans() {
    return this.database().withContext({}, async (tx) => {
      const ps = (await tx.query(`SELECT * FROM subscription_plans ORDER BY sort_order, code`)).rows;
      const es = (await tx.query(`SELECT plan_id, key, value FROM plan_entitlements`)).rows;
      return { items: ps.map((x) => ({ id: x.id, code: x.code, name: x.name, priceMinor: x.price_minor === null ? null : N(x.price_minor), interval: x.billing_interval, currency: x.currency, active: x.active, isPublic: x.is_public,
        version: x.version, entitlements: Object.fromEntries(es.filter((e) => e.plan_id === x.id).map((e) => [e.key, e.value])) })) };
    });
  }

  @Patch('plans/:id')
  @PlatformOnly('platform_admin')
  updatePlan(@CurrentPlatform() p: PlatformActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(planPatch)) b: z.infer<typeof planPatch>) {
    return this.database().withContext({}, async (tx) => {
      const cur = (await tx.query(`SELECT * FROM subscription_plans WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!cur) throw notFound('Plan');
      await tx.query(`UPDATE subscription_plans SET name = $2, price_minor = $3, active = $4, is_public = $5, version = version + 1 WHERE id = $1`,
        [id, b.name ?? cur.name, b.priceMinor === undefined ? cur.price_minor : b.priceMinor, b.active ?? cur.active, b.isPublic ?? cur.is_public]);
      await this.audit(tx, p, 'plan.updated', null, { planId: id, code: cur.code, ...b });
      return { id };
    });
  }

  /** Replaces a plan's entitlements. Existing subscribers keep their records; the new values apply to creation checks from now on. */
  @Put('plans/:id/entitlements')
  @PlatformOnly('platform_admin')
  setPlanEntitlements(@CurrentPlatform() p: PlatformActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(planEntitlements)) b: z.infer<typeof planEntitlements>) {
    for (const [k, v] of Object.entries(b.entitlements)) if (!(k in ENTITLEMENT_KEYS) || !validEntitlementValue(k, v)) throw new AppError(422, 'INVALID_ENTITLEMENT', `Invalid entitlement: ${k}`);
    return this.database().withContext({}, async (tx) => {
      const cur = (await tx.query(`SELECT code FROM subscription_plans WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!cur) throw notFound('Plan');
      await tx.query(`DELETE FROM plan_entitlements WHERE plan_id = $1`, [id]);
      for (const [k, v] of Object.entries(b.entitlements)) await tx.query(`INSERT INTO plan_entitlements (plan_id, key, value) VALUES ($1,$2,$3)`, [id, k, JSON.stringify(v)]);
      await tx.query(`UPDATE subscription_plans SET version = version + 1 WHERE id = $1`, [id]);
      await this.audit(tx, p, 'plan.entitlements_replaced', null, { planId: id, code: cur.code, entitlements: b.entitlements });
      return { id };
    });
  }

  // ------------------------------------------------------------------ lifecycle & audit
  @Post('lifecycle/run')
  @PlatformOnly('platform_admin', 'billing_ops')
  @HttpCode(200)
  runLifecycle(@CurrentPlatform() p: PlatformActor) { return this.lifecycle.run(p.userId); }

  @Get('audit')
  @PlatformOnly()
  auditLog(@Query(new ZodPipe(auditQuery)) q: z.infer<typeof auditQuery>) {
    return this.database().withContext({}, async (tx) => {
      const r = await tx.query(`SELECT a.id, a.action, a.target_tenant_id, a.detail, a.occurred_at, u.full_name AS actor FROM platform_audit_logs a LEFT JOIN platform_users u ON u.id = a.actor_user_id
                                 WHERE ($1::uuid IS NULL OR a.target_tenant_id = $1) ORDER BY a.occurred_at DESC, a.id DESC LIMIT $2`, [q.tenantId ?? null, q.limit]);
      return { items: r.rows.map((x) => ({ id: x.id, action: x.action, tenantId: x.target_tenant_id, detail: x.detail, at: x.occurred_at, actor: x.actor ?? 'system' })) };
    });
  }
}
