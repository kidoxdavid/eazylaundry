import { randomBytes } from 'node:crypto';

export interface AppConfig {
  databaseUrl: string;
  port: number;
  cookieSecure: boolean;
  encryptionSecret: string;
  sessionTtlHours: number;
  sessionIdleMinutes: number;
  throttleLimit: number;
  authThrottleLimit: number;
  maxFailedLogins: number;
  lockMinutes: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const production = env.NODE_ENV === 'production';
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  let encryptionSecret = env.APP_ENCRYPTION_SECRET;
  if (!encryptionSecret) {
    if (production) throw new Error('APP_ENCRYPTION_SECRET is required in production');
    encryptionSecret = randomBytes(32).toString('hex'); // dev/test only: ephemeral, MFA seeds will not survive restart
    console.warn('APP_ENCRYPTION_SECRET not set: using an ephemeral key (development only)');
  }
  const cookieSecure = production ? env.SESSION_COOKIE_SECURE !== 'false' : env.SESSION_COOKIE_SECURE === 'true';
  return {
    databaseUrl,
    port: Number(env.PORT ?? 3000),
    cookieSecure,
    encryptionSecret,
    sessionTtlHours: Number(env.SESSION_TTL_HOURS ?? 12),
    sessionIdleMinutes: Number(env.SESSION_IDLE_MINUTES ?? 30),
    throttleLimit: Number(env.THROTTLE_LIMIT ?? 300),
    authThrottleLimit: Number(env.AUTH_THROTTLE_LIMIT ?? 10),
    maxFailedLogins: Number(env.MAX_FAILED_LOGINS ?? 5),
    lockMinutes: Number(env.LOCK_MINUTES ?? 15),
  };
}
