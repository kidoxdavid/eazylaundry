import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import { ACCESS_KEY, type Access } from '../common/access.js';
import { AppError, forbidden, unauthorized } from '../common/errors.js';
import type { AppRequest } from '../common/types.js';
import { PCSRF_COOKIE, PSID_COOKIE, PlatformAuthService } from '../platform/platform-auth.service.js';
import { CCSRF_COOKIE, CSID_COOKIE, CustomerSessionService } from '../portal/customer-session.service.js';
import { CSRF_COOKIE, SID_COOKIE, SessionService } from './session.service.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
/** While a business is suspended (trial over / unpaid) it is read-only, EXCEPT work already in flight: customers can still pay and collect. */
const SUSPENDED_ALLOWED = [
  /^\/orders\/[^/]+\/(payments|advance|qc|refund-requests)$/, /^\/delivery-tasks\/[^/]+\/(start|complete|fail)$/, /^\/cash-shifts/, /^\/refund-requests/,
];

function safeEq(a?: string, b?: string) {
  if (!a || !b) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Global, fail-closed guard: a route without an access declaration is denied. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector, @Inject(SessionService) private readonly sessions: SessionService,
              @Inject(CustomerSessionService) private readonly customerSessions: CustomerSessionService, @Inject(PlatformAuthService) private readonly platformAuth: PlatformAuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const access = this.reflector.getAllAndOverride<Access | undefined>(ACCESS_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!access) throw forbidden('NO_ACCESS_POLICY', 'Route has no access policy');
    if (access.kind === 'public') return true;

    const req = ctx.switchToHttp().getRequest<AppRequest>();
    if (access.kind === 'platform') {
      // Eazy Group operations: its own cookie and session store. Business staff and customers can never satisfy this.
      const ptoken = req.cookies?.[PSID_COOKIE];
      if (!ptoken) throw unauthorized();
      const p = await this.platformAuth.resolve(ptoken, req.ip);
      if (!p) throw unauthorized('SESSION_INVALID', 'Session expired or invalid');
      if (!SAFE.has(req.method) && !safeEq(req.headers['x-csrf-token'] as string | undefined, req.cookies?.[PCSRF_COOKIE])) throw forbidden('CSRF', 'Missing or invalid CSRF token');
      if (access.roles.length && !access.roles.includes(p.role)) throw forbidden('PERMISSION_DENIED', 'Your platform role cannot do this');
      req.platform = p;
      return true;
    }
    if (access.kind === 'customer') {
      // Storefront customers: their own cookie + session store. A staff session never satisfies this, and vice versa.
      const ctoken = req.cookies?.[CSID_COOKIE];
      if (!ctoken) throw unauthorized();
      const customer = await this.customerSessions.resolve(ctoken);
      if (!customer) throw unauthorized('SESSION_INVALID', 'Session expired or invalid');
      if (!SAFE.has(req.method) && !safeEq(req.headers['x-csrf-token'] as string | undefined, req.cookies?.[CCSRF_COOKIE])) throw forbidden('CSRF', 'Missing or invalid CSRF token');
      req.customer = customer;
      return true;
    }
    const token = req.cookies?.[SID_COOKIE];
    if (!token) throw unauthorized();
    const actor = await this.sessions.resolve(token, req.ip);
    if (!actor) throw unauthorized('SESSION_INVALID', 'Session expired or invalid');

    if (!SAFE.has(req.method) && !safeEq(req.headers['x-csrf-token'] as string | undefined, req.cookies?.[CSRF_COOKIE])) {
      throw forbidden('CSRF', 'Missing or invalid CSRF token');
    }
    actor.requestId = req.requestId;
    req.actor = actor;
    if (access.kind === 'authenticated') return true;
    if (actor.mustChangePassword) throw forbidden('PASSWORD_CHANGE_REQUIRED', 'You must change your temporary password first');

    if (!actor.tenantId) throw forbidden('NO_ACTIVE_TENANT', 'No active business membership');
    const blockedWhileSuspended = actor.tenantStatus === 'suspended' && !SAFE.has(req.method) && !SUSPENDED_ALLOWED.some((re) => re.test(req.path));
    if (access.kind === 'any') {
      if (blockedWhileSuspended) throw new AppError(402, 'SUBSCRIPTION_SUSPENDED', 'This account is suspended. You can finish existing orders and take payments; contact support or update billing to restore full access.');
      if (!access.codes.some((c) => actor.permissions.has(c))) throw forbidden('PERMISSION_DENIED', `Missing permission: one of ${access.codes.join(', ')}`);
      return true;
    }
    for (const code of access.codes) {
      if (!actor.permissions.has(code)) throw forbidden('PERMISSION_DENIED', `Missing permission: ${code}`);
    }
    if (blockedWhileSuspended) throw new AppError(402, 'SUBSCRIPTION_SUSPENDED', 'This account is suspended. You can finish existing orders and take payments; contact support or update billing to restore full access.');
    return true;
  }
}
