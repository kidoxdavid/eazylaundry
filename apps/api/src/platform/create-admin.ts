/**
 * Creates the first (or another) platform user. Run once per person:
 *   DATABASE_PLATFORM_URL=... APP_ENCRYPTION_SECRET=... PLATFORM_ADMIN_PASSWORD=... pnpm --filter @eazy/api platform:create-admin you@example.com "Your Name" platform_admin
 * Prints the authenticator secret ONCE. Scan it into an authenticator app; it cannot be shown again.
 */
import 'reflect-metadata';
import { Database } from '@eazy/database';
import { PasswordService } from '../auth/password.service.js';
import { FieldCipher } from '../common/crypto.js';
import { PlatformAuthService } from './platform-auth.service.js';

const [email, name, role = 'platform_admin'] = process.argv.slice(2);
const { DATABASE_PLATFORM_URL, APP_ENCRYPTION_SECRET, PLATFORM_ADMIN_PASSWORD } = process.env;
if (!email || !name || !DATABASE_PLATFORM_URL || !APP_ENCRYPTION_SECRET || !PLATFORM_ADMIN_PASSWORD) {
  console.error('usage: DATABASE_PLATFORM_URL, APP_ENCRYPTION_SECRET and PLATFORM_ADMIN_PASSWORD must be set; args: <email> "<full name>" [platform_admin|billing_ops|support_agent]');
  process.exit(1);
}
if (PLATFORM_ADMIN_PASSWORD.length < 14) { console.error('PLATFORM_ADMIN_PASSWORD must be at least 14 characters'); process.exit(1); }
const db = new Database(DATABASE_PLATFORM_URL, 2);
const svc = new PlatformAuthService(db, {} as any, new FieldCipher(APP_ENCRYPTION_SECRET), new PasswordService());
svc.createUser({ email, fullName: name, password: PLATFORM_ADMIN_PASSWORD, role: role as any })
  .then((r) => { console.log(`created ${email} (${role})\nauthenticator URL (shown once): ${r.otpauthUrl}`); return db.close(); })
  .catch((e) => { console.error(e.message); process.exit(1); });
