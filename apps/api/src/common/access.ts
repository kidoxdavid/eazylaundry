import { SetMetadata } from '@nestjs/common';

export const ACCESS_KEY = 'eazy:access';
export type Access =
  | { kind: 'public' }
  | { kind: 'authenticated' } // any signed-in user, tenant not required
  | { kind: 'permission'; codes: string[] };

/** No auth. Use sparingly: health, login, registration. */
export const Public = () => SetMetadata(ACCESS_KEY, { kind: 'public' } satisfies Access);
/** Signed-in user, no tenant context required (me, switch tenant, MFA, logout). */
export const Authenticated = () => SetMetadata(ACCESS_KEY, { kind: 'authenticated' } satisfies Access);
/** Requires an active tenant membership holding ALL listed permissions. */
export const RequirePermission = (...codes: string[]) =>
  SetMetadata(ACCESS_KEY, { kind: 'permission', codes } satisfies Access);

export const AUTH_THROTTLE_KEY = 'eazy:authThrottle';
/** Applies the stricter, config-driven 'auth' rate limit (per IP) to credential-handling routes. */
export const AuthThrottle = () => SetMetadata(AUTH_THROTTLE_KEY, true);
