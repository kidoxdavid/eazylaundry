import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import { ACCESS_KEY, type Access } from '../common/access.js';
import { forbidden, unauthorized } from '../common/errors.js';
import type { AppRequest } from '../common/types.js';
import { CSRF_COOKIE, SID_COOKIE, SessionService } from './session.service.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

function safeEq(a?: string, b?: string) {
  if (!a || !b) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Global, fail-closed guard: a route without an access declaration is denied. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector, @Inject(SessionService) private readonly sessions: SessionService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const access = this.reflector.getAllAndOverride<Access | undefined>(ACCESS_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!access) throw forbidden('NO_ACCESS_POLICY', 'Route has no access policy');
    if (access.kind === 'public') return true;

    const req = ctx.switchToHttp().getRequest<AppRequest>();
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
    for (const code of access.codes) {
      if (!actor.permissions.has(code)) throw forbidden('PERMISSION_DENIED', `Missing permission: ${code}`);
    }
    return true;
  }
}
