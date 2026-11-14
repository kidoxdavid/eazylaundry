import 'reflect-metadata';
import { authenticator } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, PASSWORD, addStaff, makeApp, ownerQuery, registerTenant, uniq } from './helpers.js';

describe('authentication & sessions', () => {
  let app: Awaited<ReturnType<typeof makeApp>>;
  beforeAll(async () => { app = await makeApp({ MAX_FAILED_LOGINS: '3', LOCK_MINUTES: '15' }); });
  afterAll(async () => { await app.close(); });

  it('registers a business, signs in with httpOnly session cookie, and returns identity', async () => {
    const T = await registerTenant(app, 'Sunrise Wash');
    expect(T.slug).toBe('sunrise-wash');
    const me = await T.client.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.active.role).toBe('owner');
    expect(me.body.active.permissions.length).toBeGreaterThan(20);
    const raw = (await new Client(app).post('/auth/login', { email: T.email, password: PASSWORD })).headers['set-cookie'] as string[];
    expect(raw.find((c) => c.startsWith('eazy_sid'))).toMatch(/HttpOnly/i);
    expect(raw.find((c) => c.startsWith('eazy_sid'))).toMatch(/SameSite=Lax/i);
  });

  it('rejects weak passwords, bad postal/timezones and duplicate emails', async () => {
    const c = new Client(app);
    expect((await c.post('/auth/register', { businessName: 'Weak Co', ownerName: 'Wy Weak', email: `${uniq('w')}@example.test`, password: 'short' })).status).toBe(400);
    expect((await c.post('/auth/register', { businessName: 'Tz Co', ownerName: 'Tee Zee', email: `${uniq('t')}@example.test`, password: PASSWORD, timezone: 'Mars/Olympus' })).status).toBe(400);
    const T = await registerTenant(app);
    const dup = await new Client(app).post('/auth/register', { businessName: 'Dup Co', ownerName: 'Dee Dup', email: T.email, password: PASSWORD });
    expect(dup.status).toBe(409);
    // the existing account is untouched
    expect((await new Client(app).post('/auth/login', { email: T.email, password: PASSWORD })).status).toBe(200);
  });

  it('gives identical responses for unknown email and wrong password', async () => {
    const T = await registerTenant(app);
    const a = await new Client(app).post('/auth/login', { email: T.email, password: 'wrong-wrong-wrong' });
    const b = await new Client(app).post('/auth/login', { email: 'nobody@example.test', password: 'wrong-wrong-wrong' });
    expect(a.status).toBe(401); expect(b.status).toBe(401);
    expect(a.body.code).toBe('INVALID_CREDENTIALS'); expect(b.body.code).toBe('INVALID_CREDENTIALS'); expect(a.body.title).toBe(b.body.title);
  });

  it('locks the account after repeated failures, even for the correct password', async () => {
    const T = await registerTenant(app);
    for (let i = 0; i < 3; i++) await new Client(app).post('/auth/login', { email: T.email, password: 'wrong-wrong-wrong' });
    const r = await new Client(app).post('/auth/login', { email: T.email, password: PASSWORD });
    expect(r.status).toBe(401);
  });

  it('requires authentication and a CSRF token for state-changing requests', async () => {
    const T = await registerTenant(app);
    expect((await new Client(app).get('/branches')).status).toBe(401);
    const noCsrf = await T.client.req('post', '/branches', { code: 'NOPE', name: 'No csrf' }, { csrf: false });
    expect(noCsrf.status).toBe(403); expect(noCsrf.body.code).toBe('CSRF');
    expect((await T.client.post('/branches', { code: 'YES', name: 'With csrf' })).status).toBe(201);
  });

  it('logout revokes the session server-side (stolen cookie stops working)', async () => {
    const T = await registerTenant(app);
    const stolen = { ...T.client.cookies };
    expect((await T.client.post('/auth/logout')).status).toBe(204);
    const thief = new Client(app); thief.cookies = stolen;
    expect((await thief.get('/auth/me')).status).toBe(401);
  });

  it('expired sessions and idle sessions are rejected', async () => {
    const T = await registerTenant(app);
    await ownerQuery(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = (SELECT id FROM users WHERE email = $1)`, [T.email]);
    expect((await T.client.get('/auth/me')).status).toBe(401);
    const T2 = await registerTenant(app);
    await ownerQuery(`UPDATE sessions SET last_seen_at = now() - interval '2 hours' WHERE user_id = (SELECT id FROM users WHERE email = $1)`, [T2.email]);
    expect((await T2.client.get('/auth/me')).status).toBe(401);
  });

  it('TOTP MFA: setup, enable, then login requires a valid code', async () => {
    const T = await registerTenant(app);
    const setup = await T.client.post('/auth/mfa/setup');
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect((await T.client.post('/auth/mfa/enable', { token: '000000' })).status).toBe(400);
    expect((await T.client.post('/auth/mfa/enable', { token: authenticator.generate(setup.body.secret) })).status).toBe(204);
    // secret is stored encrypted, never plaintext
    const [row] = await ownerQuery(`SELECT mfa_secret FROM users WHERE email = $1`, [T.email]);
    expect(row.mfa_secret.startsWith('v1:')).toBe(true); expect(row.mfa_secret).not.toContain(setup.body.secret);
    const noCode = await new Client(app).post('/auth/login', { email: T.email, password: PASSWORD });
    expect(noCode.status).toBe(401); expect(noCode.body.code).toBe('MFA_REQUIRED');
    expect((await new Client(app).post('/auth/login', { email: T.email, password: PASSWORD, totp: '123456' })).status).toBe(401);
    expect((await new Client(app).post('/auth/login', { email: T.email, password: PASSWORD, totp: authenticator.generate(setup.body.secret) })).status).toBe(200);
  });

  it('suspending a member ends their active sessions immediately', async () => {
    const T = await registerTenant(app);
    const staff = await addStaff(T.client, 'cashier');
    expect((await staff.client.get('/branches')).status).toBe(200);
    expect((await T.client.patch(`/members/${staff.membershipId}`, { status: 'suspended' })).status).toBe(200);
    expect((await staff.client.get('/branches')).status).toBe(401);
    expect((await new Client(app).post('/auth/login', { email: staff.email, password: `${PASSWORD}-changed` })).status).toBe(200); // the person can still sign in; they just have no active membership
  });

  it('a user in two businesses switches context; adding an existing email never alters their credentials', async () => {
    const A = await registerTenant(app), B = await registerTenant(app);
    const cashierRole = (await A.client.get('/roles')).body.items.find((r: any) => r.key === 'cashier').id;
    const add = await A.client.post('/members', { email: B.email, fullName: 'Attacker Chosen Name', roleId: cashierRole, allBranches: true, temporaryPassword: 'attacker-chosen-pass' });
    expect(add.status).toBe(201);
    expect((await new Client(app).post('/auth/login', { email: B.email, password: 'attacker-chosen-pass' })).status).toBe(401);
    const c = new Client(app);
    expect((await c.post('/auth/login', { email: B.email, password: PASSWORD, tenantSlug: A.slug })).status).toBe(200);
    const me = (await c.get('/auth/me')).body;
    expect(me.memberships).toHaveLength(2);
    expect(me.active.role).toBe('cashier');
    expect((await c.post('/members', {})).status).toBe(403); // cashier in A cannot manage members
    expect((await c.post('/auth/switch-tenant', { tenantId: B.tenantId })).status).toBe(204);
    expect((await c.get('/auth/me')).body.active.role).toBe('owner');
    expect((await new Client(app).post('/auth/login', { email: B.email, password: PASSWORD, tenantSlug: 'unknown-biz' })).status).toBe(401);
  });

  it('changing password revokes other sessions', async () => {
    const T = await registerTenant(app);
    const other = new Client(app); await other.post('/auth/login', { email: T.email, password: PASSWORD });
    expect((await T.client.post('/auth/change-password', { currentPassword: 'nope-nope-nope', newPassword: 'another-long-password' })).status).toBe(400);
    expect((await T.client.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'another-long-password' })).status).toBe(204);
    expect((await other.get('/auth/me')).status).toBe(401);
    expect((await T.client.get('/auth/me')).status).toBe(200);
    expect((await new Client(app).post('/auth/login', { email: T.email, password: 'another-long-password' })).status).toBe(200);
  });
});

describe('temporary passwords', () => {
  it('blocks all business routes until a member sets their own password', async () => {
    const app = await makeApp();
    const T = await registerTenant(app);
    const staff = await addStaff(T.client, 'cashier', { keepTemporaryPassword: true });
    expect((await staff.client.get('/auth/me')).body.user.mustChangePassword).toBe(true);
    const blocked = await staff.client.get('/branches');
    expect(blocked.status).toBe(403); expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await staff.client.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'my-own-long-password' })).status).toBe(204);
    expect((await staff.client.get('/branches')).status).toBe(200);
    expect((await T.client.get('/auth/me')).body.user.mustChangePassword).toBe(false); // owner unaffected
    await app.close();
  });
});

describe('rate limiting', () => {
  it('throttles credential endpoints per IP', async () => {
    const app = await makeApp({ AUTH_THROTTLE_LIMIT: '3' });
    const c = new Client(app);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await c.post('/auth/login', { email: 'nobody@example.test', password: 'wrong-wrong-wrong' })).status);
    await app.close();
    expect(codes).toEqual([401, 401, 401, 429, 429]);
  });
});
