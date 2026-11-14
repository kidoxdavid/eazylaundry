import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthThrottle, Authenticated, Public } from '../common/access.js';
import { CurrentActor } from '../common/current-actor.js';
import { APP_CONFIG } from '../common/tokens.js';
import type { Actor, AppRequest } from '../common/types.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { Inject } from '@nestjs/common';
import type { AppConfig } from '../config.js';
import { TenantsService } from '../tenancy/tenants.service.js';
import { AuthService } from './auth.service.js';
import { CSRF_COOKIE, SID_COOKIE, SessionService } from './session.service.js';

const password = z.string().min(12, 'Use at least 12 characters').max(128);
const email = z.string().trim().toLowerCase().email().max(254);

const registerSchema = z.object({
  businessName: z.string().trim().min(2).max(80),
  ownerName: z.string().trim().min(2).max(80),
  email, password,
  branchName: z.string().trim().min(2).max(80).default('Main'),
  branchCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,8}$/).default('MAIN'),
  timezone: z.string().default('America/Edmonton').refine((tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }, 'Unknown time zone'),
});
const loginSchema = z.object({ email, password: z.string().min(1).max(128), totp: z.string().regex(/^\d{6}$/).optional(), tenantSlug: z.string().optional() });

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private setCookies(res: Response, s: { token: string; csrf: string }) {
    const base = { sameSite: 'lax' as const, secure: this.cfg.cookieSecure, path: '/', maxAge: this.cfg.sessionTtlHours * 3600_000 };
    res.cookie(SID_COOKIE, s.token, { ...base, httpOnly: true });
    res.cookie(CSRF_COOKIE, s.csrf, { ...base, httpOnly: false });
  }

  @Post('register')
  @Public()
  @AuthThrottle()
  async register(@Body(new ZodPipe(registerSchema)) body: z.infer<typeof registerSchema>, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    const t = await this.tenants.register(body, req.ip);
    const s = await this.sessions.create({ userId: t.userId, tenantId: t.tenantId, mfaVerified: false, ip: req.ip, userAgent: req.headers['user-agent'] });
    this.setCookies(res, s);
    return { tenantId: t.tenantId, slug: t.slug, branchId: t.branchId };
  }

  @Post('login')
  @Public()
  @HttpCode(200)
  @AuthThrottle()
  async login(@Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    const s = await this.auth.login({ ...body, ip: req.ip, userAgent: req.headers['user-agent'] });
    this.setCookies(res, s);
    return { ok: true };
  }

  @Post('logout')
  @Authenticated()
  @HttpCode(204)
  async logout(@CurrentActor() actor: Actor, @Res({ passthrough: true }) res: Response) {
    await this.sessions.revoke(actor.sessionId);
    res.clearCookie(SID_COOKIE, { path: '/' });
    res.clearCookie(CSRF_COOKIE, { path: '/' });
  }

  @Get('me')
  @Authenticated()
  me(@CurrentActor() actor: Actor) { return this.auth.me(actor); }

  @Post('switch-tenant')
  @Authenticated()
  @HttpCode(204)
  async switchTenant(@CurrentActor() actor: Actor, @Body(new ZodPipe(z.object({ tenantId: z.string().uuid() }))) b: { tenantId: string }) {
    await this.auth.switchTenant(actor, b.tenantId);
  }

  @Post('change-password')
  @Authenticated()
  @HttpCode(204)
  async changePassword(@CurrentActor() actor: Actor, @Body(new ZodPipe(z.object({ currentPassword: z.string(), newPassword: password }))) b: { currentPassword: string; newPassword: string }) {
    await this.auth.changePassword(actor, b.currentPassword, b.newPassword);
  }

  @Post('mfa/setup')
  @Authenticated()
  mfaSetup(@CurrentActor() actor: Actor) { return this.auth.mfaSetup(actor); }

  @Post('mfa/enable')
  @Authenticated()
  @HttpCode(204)
  async mfaEnable(@CurrentActor() actor: Actor, @Body(new ZodPipe(z.object({ token: z.string().regex(/^\d{6}$/) }))) b: { token: string }) {
    await this.auth.mfaEnable(actor, b.token);
  }
}
