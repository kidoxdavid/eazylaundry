import 'reflect-metadata';
import { authenticator } from 'otplib';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '@eazy/database';
import { PlatformAuthService } from '../src/platform/platform-auth.service.js';
import { APP_URL, Client, OWNER_URL, PLATFORM_URL, addStaff, makeApp, postKey, registerTenant } from './helpers.js';

type App = Awaited<ReturnType<typeof makeApp>>;
const PW = 'platform-password-123';
const addr = { line1: '10 Jasper Ave', city: 'Edmonton', province: 'AB', postalCode: 'T5J 2R4' };
const win = () => ({ start: new Date(Date.now() + 3600_000).toISOString(), end: new Date(Date.now() + 3 * 3600_000).toISOString() });
async function asPlatform<T>(fn: (c: pg.Client) => Promise<T>) { const c = new pg.Client({ connectionString: PLATFORM_URL }); await c.connect(); try { return await fn(c); } finally { await c.end(); } }

/** A signed-in platform operator (password + authenticator code, exactly like production). */
async function operator(app: App, role: 'platform_admin' | 'billing_ops' | 'support_agent' = 'platform_admin') {
  const email = `${role}-${randomUUID().slice(0, 8)}@eazy.test`;
  const u = await app.get(PlatformAuthService).createUser({ email, fullName: `Test ${role}`, password: PW, role });
  const c = new Client(app);
  const r = await c.post('/platform/auth/login', { email, password: PW, totp: authenticator.generate(u.mfaSecret) });
  expect(r.status).toBe(200);
  return { c, email, secret: u.mfaSecret };
}

describe('plans, trials and billing view', () => {
  let app: App;
  beforeAll(async () => { app = await makeApp(); });
  afterAll(async () => { await app.close(); });

  it('new businesses start a 14-day trial with full (Business-level) access; owners see plan, status, entitlements and usage', async () => {
    const t = await registerTenant(app);
    const b = (await t.client.get('/billing')).body;
    expect(b).toMatchObject({ status: 'trial', plan: { code: 'business', name: 'Business', priceMinor: 17900, interval: 'month', currency: 'CAD' }, trialDaysLeft: 14,
      usage: { branches: 1, staffSeats: 1, ordersThisMonth: 0 }, limits: { branches: 5, staffSeats: 40 } });
    expect(b.entitlements).toMatchObject({ 'module.delivery': true, 'module.storefront': true, 'module.commercial': true });
    const cashier = await addStaff(t.client, 'cashier');
    expect((await cashier.client.get('/billing')).status).toBe(403); // billing.read is an owner/finance permission
    expect((await t.client.get('/auth/me')).body.active.status).toBe('trial');
  });

  it('the plan catalogue is seeded with the pricing hypotheses and Enterprise as custom-priced', async () => {
    const op = await operator(app);
    const plans = (await op.c.get('/platform/plans')).body.items as any[];
    expect(plans.map((p) => [p.code, p.priceMinor])).toEqual([['starter', 4900], ['professional', 9900], ['business', 17900], ['enterprise', null]]);
    expect(plans.find((p) => p.code === 'starter').entitlements).toMatchObject({ 'limit.branches': 1, 'limit.staff_seats': 5, 'module.delivery': false });
    expect(plans.find((p) => p.code === 'enterprise').entitlements).toMatchObject({ 'limit.branches': null, 'limit.staff_seats': null });
  });
});

describe('entitlements: limits block creation, never existing data', () => {
  let app: App; let op: Awaited<ReturnType<typeof operator>>;
  beforeAll(async () => { app = await makeApp(); op = await operator(app); });
  afterAll(async () => { await app.close(); });
  const override = (tenantId: string, key: string, value: unknown, extra: any = {}) => op.c.req('put', `/platform/tenants/${tenantId}/overrides`, { key, value, reason: 'Support request', ...extra });

  it('branch limit: creation is refused at the limit with a clear code, existing branches are untouched, overrides win and can expire', async () => {
    const t = await registerTenant(app);
    expect((await override(t.tenantId, 'limit.branches', 1)).status).toBe(200);
    const blocked = await t.client.post('/branches', { code: 'TWO', name: 'Second' });
    expect(blocked.status).toBe(402); expect(blocked.body.code).toBe('ENTITLEMENT_EXCEEDED');
    expect(((await t.client.get('/branches')).body.items as any[])).toHaveLength(1);
    expect((await override(t.tenantId, 'limit.branches', 2)).status).toBe(200);
    expect((await t.client.post('/branches', { code: 'TWO', name: 'Second' })).status).toBe(201);
    expect((await t.client.post('/branches', { code: 'TRE', name: 'Third' })).status).toBe(402);
    // an expired override is ignored: the plan's limit (5) applies again
    expect((await override(t.tenantId, 'limit.branches', 1, { expiresAt: new Date(Date.now() - 1000).toISOString() })).status).toBe(200);
    expect((await t.client.post('/branches', { code: 'TRE', name: 'Third' })).status).toBe(201);
    expect((await t.client.get('/billing')).body.usage.branches).toBe(3);
  });

  it('downgrading never deletes or hides data: existing branches stay usable, only new ones are blocked until usage drops below the limit', async () => {
    const t = await registerTenant(app);
    const b2 = (await t.client.post('/branches', { code: 'TWO', name: 'Second' })).body.id; const b3 = (await t.client.post('/branches', { code: 'TRE', name: 'Third' })).body.id;
    expect((await op.c.post(`/platform/tenants/${t.tenantId}/plan`, { planCode: 'starter' })).status).toBe(200); // limit 1, usage 3
    expect(((await t.client.get('/branches')).body.items as any[])).toHaveLength(3);
    expect((await t.client.patch(`/branches/${b2}`, { name: 'Still editable' })).status).toBe(200);
    expect((await t.client.post('/branches', { code: 'FOU', name: 'Fourth' })).body.code).toBe('ENTITLEMENT_EXCEEDED');
    await t.client.patch(`/branches/${b2}`, { status: 'archived' }); await t.client.patch(`/branches/${b3}`, { status: 'archived' });
    expect((await t.client.post('/branches', { code: 'FOU', name: 'Fourth' })).status).toBe(402); // 1 active == limit 1
    expect((await t.client.patch(`/branches/${b2}`, { status: 'active' })).status).toBe(402); // restoring also needs a free slot
    await t.client.patch(`/branches/${t.branchId}`, { status: 'archived' });
    expect((await t.client.post('/branches', { code: 'FOU', name: 'Fourth' })).status).toBe(201);
  });

  it('staff-seat limit counts active memberships; suspending someone frees a seat; reactivating needs one', async () => {
    const t = await registerTenant(app);
    await override(t.tenantId, 'limit.staff_seats', 2);
    const first = await addStaff(t.client, 'cashier');
    const roles = (await t.client.get('/roles')).body.items as any[];
    const extra = await t.client.post('/members', { email: `x${randomUUID().slice(0, 6)}@example.test`, fullName: 'Extra Person', roleId: roles.find((r) => r.key === 'cashier').id, temporaryPassword: 'temporary-pass-123' });
    expect(extra.status).toBe(402); expect(extra.body.code).toBe('ENTITLEMENT_EXCEEDED');
    expect((await t.client.patch(`/members/${first.membershipId}`, { status: 'suspended' })).status).toBe(200);
    expect((await t.client.post('/members', { email: `y${randomUUID().slice(0, 6)}@example.test`, fullName: 'Replacement', roleId: roles.find((r) => r.key === 'cashier').id, temporaryPassword: 'temporary-pass-123' })).status).toBe(201);
    expect((await t.client.patch(`/members/${first.membershipId}`, { status: 'active' })).status).toBe(402);
  });

  it('modules: delivery is off on Starter (zones, bookings, delivery orders refused) and an override turns it on; storefront can be switched off', async () => {
    const t = await registerTenant(app);
    await op.c.post(`/platform/tenants/${t.tenantId}/plan`, { planCode: 'starter' });
    const svc = (await t.client.post('/services', { code: 'SH', name: 'Shirt', pricingModel: 'per_item', price: { unitPriceMinor: 1000 } })).body.id;
    const cust = (await t.client.post('/customers', { fullName: 'Ada Lovelace', phone: '7805550101', address: addr })).body.id;
    const addressId = (await t.client.get(`/customers/${cust}`)).body.addresses[0].id;
    const zone = await t.client.post('/delivery-zones', { name: 'Central', postalPrefixes: ['T5J'] });
    expect(zone.status).toBe(402); expect(zone.body.code).toBe('ENTITLEMENT_REQUIRED');
    expect((await t.client.post('/delivery-tasks', { branchId: t.branchId, customerId: cust, addressId, window: win() })).status).toBe(402);
    expect((await override(t.tenantId, 'module.delivery', true)).status).toBe(200);
    expect((await t.client.post('/delivery-zones', { name: 'Central', postalPrefixes: ['T5J'] })).status).toBe(201);
    expect((await postKey(t.client, '/orders', { branchId: t.branchId, customerId: cust, lines: [{ serviceId: svc, quantity: 1 }], deliveryAddressId: addressId, deliveryWindow: win() })).status).toBe(201);
    await override(t.tenantId, 'module.delivery', false);
    expect((await postKey(t.client, '/orders', { branchId: t.branchId, customerId: cust, lines: [{ serviceId: svc, quantity: 1 }], deliveryAddressId: addressId, deliveryWindow: win() })).body.code).toBe('ENTITLEMENT_REQUIRED');
    expect((await postKey(t.client, '/orders', { branchId: t.branchId, customerId: cust, lines: [{ serviceId: svc, quantity: 1 }] })).status).toBe(201); // ordinary orders unaffected
    // storefront off => the business has no public storefront (identical to an unknown business)
    const anon = new Client(app);
    expect((await anon.get(`/public/${t.slug}`)).status).toBe(200);
    await override(t.tenantId, 'module.storefront', false);
    const off = await anon.get(`/public/${t.slug}`); const unknown = await anon.get('/public/nope-nope');
    expect(off.status).toBe(404); expect(off.body.code).toBe(unknown.body.code);
    expect((await anon.post(`/public/${t.slug}/register`, { fullName: 'X Y', email: 'x@example.test', password: 'portal-password-123' })).status).toBe(404);
  });

  it('rejects unknown entitlement keys and invalid values', async () => {
    const t = await registerTenant(app);
    expect((await override(t.tenantId, 'limit.nonsense', 1)).body.code).toBe('INVALID_ENTITLEMENT');
    expect((await override(t.tenantId, 'limit.branches', -1)).status).toBe(422);
    expect((await override(t.tenantId, 'module.delivery', 'yes')).status).toBe(422);
    expect((await override(t.tenantId, 'limit.branches', null)).status).toBe(200); // null = unlimited
    expect((await override(t.tenantId, 'limit.branches', 1, { reason: 'x' })).status).toBe(400); // a reason is mandatory
  });
});

describe('subscription lifecycle', () => {
  let app: App; let op: Awaited<ReturnType<typeof operator>>;
  beforeAll(async () => { app = await makeApp(); op = await operator(app); });
  afterAll(async () => { await app.close(); });
  const setSub = (tenantId: string, set: string) => asPlatform((c) => c.query(`UPDATE subscriptions SET ${set} WHERE tenant_id = $1`, [tenantId]));
  const status = async (tenantId: string) => (await op.c.get(`/platform/tenants/${tenantId}`)).body;

  async function shop() {
    const t = await registerTenant(app);
    await t.client.put('/config/cash.require_shift', { scope: 'tenant', value: false });
    const svc = (await t.client.post('/services', { code: 'SH', name: 'Shirt', pricingModel: 'per_item', price: { unitPriceMinor: 1000 } })).body.id;
    const cust = (await t.client.post('/customers', { fullName: 'Ada Lovelace', phone: '7805550101' })).body.id;
    const order = (await postKey(t.client, '/orders', { branchId: t.branchId, customerId: cust, lines: [{ serviceId: svc, quantity: 1 }] })).body;
    return { t, svc, cust, order };
  }

  it('a trial that ends makes the business read-only (suspended) but lets it finish existing work and take payments; nothing is deleted', async () => {
    const { t, order } = await shop();
    await setSub(t.tenantId, `trial_ends_at = now() - interval '1 day'`);
    const run = (await op.c.post('/platform/lifecycle/run')).body;
    expect(run.trialsEnded).toContain(t.tenantId);
    expect(await status(t.tenantId)).toMatchObject({ status: 'suspended', statusReason: 'trial_ended' });
    // reads and sign-in still work
    expect((await t.client.get('/customers')).status).toBe(200); expect((await t.client.get(`/orders/${order.id}`)).status).toBe(200); expect((await t.client.get('/auth/me')).status).toBe(200);
    // new records are blocked with a clear, actionable error
    const blocked = await t.client.post('/customers', { fullName: 'New Person', phone: '7805550999' });
    expect(blocked.status).toBe(402); expect(blocked.body.code).toBe('SUBSCRIPTION_SUSPENDED');
    expect((await postKey(t.client, '/orders', { branchId: t.branchId, customerId: (await t.client.get('/customers')).body.items[0].id, lines: [{ serviceId: order.id, quantity: 1 }] })).status).toBe(402);
    expect((await t.client.post('/branches', { code: 'TWO', name: 'Second' })).body.code).toBe('SUBSCRIPTION_SUSPENDED');
    // work already in flight is never blocked: payments, production, hand-over, tills, refunds
    expect((await postKey(t.client, `/orders/${order.id}/payments`, { method: 'card_external', amountMinor: 1050 })).status).toBe(201);
    expect((await t.client.post(`/orders/${order.id}/advance`, { fromStageKey: 'received' })).status).toBe(200);
    expect((await t.client.post('/cash-shifts', { branchId: t.branchId, openingFloatMinor: 0 })).status).toBe(201);
    // the customer storefront stops taking new activity
    expect((await new Client(app).get(`/public/${t.slug}`)).status).toBe(404);
  });

  it('extending the trial or reactivating restores full access', async () => {
    const { t } = await shop();
    await setSub(t.tenantId, `trial_ends_at = now() - interval '1 day'`); await op.c.post('/platform/lifecycle/run');
    expect((await t.client.post('/customers', { fullName: 'N P', phone: '7805550998' })).status).toBe(402);
    const ext = await op.c.post(`/platform/tenants/${t.tenantId}/trial/extend`, { days: 7 });
    expect(ext.status).toBe(200); expect(new Date(ext.body.trialEndsAt).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect((await status(t.tenantId)).status).toBe('trial');
    expect((await t.client.post('/customers', { fullName: 'N P', phone: '7805550998' })).status).toBe(201);
    expect((await op.c.post(`/platform/tenants/${t.tenantId}/trial/extend`, { days: 0 })).status).toBe(400);
    await op.c.post(`/platform/tenants/${t.tenantId}/status`, { status: 'active', reason: 'Paid by invoice #1042' });
    expect((await op.c.post(`/platform/tenants/${t.tenantId}/trial/extend`, { days: 7 })).body.code).toBe('NOT_IN_TRIAL'); // paying customers do not get trial time
  });

  it('a failed payment starts a grace period (full access), then the account becomes read-only', async () => {
    const { t } = await shop();
    expect((await op.c.post(`/platform/tenants/${t.tenantId}/status`, { status: 'past_due', reason: 'Card declined' })).status).toBe(200);
    expect((await t.client.post('/customers', { fullName: 'Grace Period', phone: '7805550997' })).status).toBe(201); // still fully working
    await setSub(t.tenantId, `past_due_since = now() - interval '3 days'`);
    expect((await op.c.post('/platform/lifecycle/run')).body.graceExpired).not.toContain(t.tenantId);
    expect((await status(t.tenantId)).status).toBe('past_due');
    await setSub(t.tenantId, `past_due_since = now() - interval '8 days'`);
    expect((await op.c.post('/platform/lifecycle/run')).body.graceExpired).toContain(t.tenantId);
    expect(await status(t.tenantId)).toMatchObject({ status: 'suspended', statusReason: 'payment_overdue' });
    await op.c.post(`/platform/tenants/${t.tenantId}/status`, { status: 'active', reason: 'Payment received' });
    expect((await t.client.post('/customers', { fullName: 'Back Again', phone: '7805550996' })).status).toBe(201);
  });

  it('a cancellation at period end takes effect on schedule; the business can no longer sign in to it, but its data is kept', async () => {
    const { t, order } = await shop();
    await op.c.post(`/platform/tenants/${t.tenantId}/status`, { status: 'active', reason: 'Subscribed' });
    await setSub(t.tenantId, `cancel_at_period_end = true, current_period_end = now() - interval '1 hour'`);
    expect((await op.c.post('/platform/lifecycle/run')).body.cancelled).toContain(t.tenantId);
    expect((await status(t.tenantId)).status).toBe('cancelled');
    expect((await t.client.get('/branches')).status).toBe(403); // the membership no longer resolves to an active business
    const c = await asPlatform((cl) => cl.query(`SELECT count(id)::int AS n FROM orders WHERE tenant_id = $1`, [t.tenantId]));
    expect(c.rows[0].n).toBe(1); void order; // nothing was deleted
  });

  it('the lifecycle job is idempotent and only touches businesses that qualify', async () => {
    const { t } = await shop();
    await op.c.post('/platform/lifecycle/run');
    expect((await status(t.tenantId)).status).toBe('trial'); // a fresh trial is left alone
    const again = (await op.c.post('/platform/lifecycle/run')).body;
    expect(again.trialsEnded).not.toContain(t.tenantId);
  });
});

describe('platform realm: authentication, roles and audit', () => {
  let app: App;
  beforeAll(async () => { app = await makeApp(); });
  afterAll(async () => { await app.close(); });

  it('signing in needs the password AND a valid authenticator code; failures are uniform and lock the account', async () => {
    const email = `locked-${randomUUID().slice(0, 6)}@eazy.test`;
    const u = await app.get(PlatformAuthService).createUser({ email, fullName: 'Lock Test', password: PW, role: 'platform_admin' });
    const login = (body: any) => new Client(app).post('/platform/auth/login', body);
    expect((await login({ email, password: PW })).status).toBe(400); // code required
    const wrongCode = await login({ email, password: PW, totp: authenticator.generate(u.mfaSecret) === '000000' ? '111111' : '000000' });
    const wrongPw = await login({ email, password: 'wrong-wrong-wrong', totp: authenticator.generate(u.mfaSecret) });
    const unknown = await login({ email: 'nobody@eazy.test', password: PW, totp: '123456' });
    for (const r of [wrongCode, wrongPw, unknown]) { expect(r.status).toBe(401); expect(r.body.code).toBe('INVALID_CREDENTIALS'); }
    for (let i = 0; i < 4; i++) await login({ email, password: 'wrong-wrong-wrong', totp: '000000' });
    expect((await login({ email, password: PW, totp: authenticator.generate(u.mfaSecret) })).status).toBe(401); // locked even with everything right
    const secret = await asPlatform((c) => c.query(`SELECT mfa_secret FROM platform_users WHERE email = $1`, [email]));
    expect(secret.rows[0].mfa_secret).toMatch(/^v1:/); expect(secret.rows[0].mfa_secret).not.toContain(u.mfaSecret); // seed stored encrypted
  });

  it('business and platform sessions never satisfy each other; platform writes need CSRF; logout revokes', async () => {
    const op = await operator(app); const t = await registerTenant(app);
    expect((await t.client.get('/platform/tenants')).status).toBe(401); // business owner cookie on a platform route
    expect((await op.c.get('/branches')).status).toBe(401); // platform cookie on a business route
    expect((await op.c.req('post', `/platform/tenants/${t.tenantId}/trial/extend`, { days: 1 }, { csrf: false })).body.code).toBe('CSRF');
    const stolen = { ...op.c.cookies };
    expect((await op.c.post('/platform/auth/logout')).status).toBe(204);
    const thief = new Client(app); thief.cookies = stolen;
    expect((await thief.get('/platform/auth/me')).status).toBe(401);
  });

  it('roles: support agents read only; billing ops manage subscriptions but not plans; admins do everything; every change is audited', async () => {
    const admin = await operator(app); const billing = await operator(app, 'billing_ops'); const agent = await operator(app, 'support_agent');
    const t = await registerTenant(app);
    expect((await agent.c.get('/platform/tenants')).status).toBe(200); expect((await agent.c.get(`/platform/tenants/${t.tenantId}`)).status).toBe(200);
    expect((await agent.c.post(`/platform/tenants/${t.tenantId}/plan`, { planCode: 'starter' })).status).toBe(403);
    expect((await agent.c.post(`/platform/tenants/${t.tenantId}/status`, { status: 'suspended', reason: 'nope nope' })).status).toBe(403);
    expect((await billing.c.post(`/platform/tenants/${t.tenantId}/plan`, { planCode: 'professional' })).status).toBe(200);
    expect((await billing.c.post(`/platform/tenants/${t.tenantId}/plan`, { planCode: 'no_such_plan' })).body.code).toBe('UNKNOWN_PLAN');
    const plans = (await admin.c.get('/platform/plans')).body.items as any[]; const pro = plans.find((p) => p.code === 'professional');
    expect((await billing.c.patch(`/platform/plans/${pro.id}`, { priceMinor: 1 })).status).toBe(403);
    expect((await admin.c.patch(`/platform/plans/${pro.id}`, { priceMinor: 10900 })).status).toBe(200);
    expect((await admin.c.put(`/platform/plans/${pro.id}/entitlements`, { entitlements: { 'limit.branches': 3, 'limit.bogus': 1 } })).status).toBe(422);
    const afterPlan = (await admin.c.get('/platform/plans')).body.items.find((p: any) => p.code === 'professional');
    expect(afterPlan).toMatchObject({ priceMinor: 10900, version: pro.version + 1 });
    await admin.c.put(`/platform/plans/${pro.id}/entitlements`, { entitlements: pro.entitlements }); // restore
    const trail = (await admin.c.get(`/platform/audit?tenantId=${t.tenantId}`)).body.items as any[];
    expect(trail.map((x) => x.action)).toContain('tenant.plan_changed');
    expect(trail[0]).toMatchObject({ actor: 'Test billing_ops', detail: { from: 'business', to: 'professional' } });
    const global = (await admin.c.get('/platform/audit?limit=100')).body.items as any[];
    expect(global.some((x) => x.action === 'plan.updated')).toBe(true);
    // the audit trail is append-only
    const c = new pg.Client({ connectionString: OWNER_URL }); await c.connect();
    try { await expect(c.query(`UPDATE platform_audit_logs SET action = 'x'`)).rejects.toMatchObject({ code: '23001' }); await expect(c.query(`DELETE FROM platform_audit_logs`)).rejects.toMatchObject({ code: '23001' }); } finally { await c.end(); }
  });

  it('lists tenants with accurate usage counts and supports search and status filters', async () => {
    const op = await operator(app);
    const t = await registerTenant(app, `Zebra Wash ${randomUUID().slice(0, 6)}`);
    await t.client.post('/branches', { code: 'TWO', name: 'Second' }); await addStaff(t.client, 'cashier');
    const svc = (await t.client.post('/services', { code: 'SH', name: 'Shirt', pricingModel: 'per_item', price: { unitPriceMinor: 1000 } })).body.id;
    const cust = (await t.client.post('/customers', { kind: 'guest', fullName: 'Walk-in' })).body.id;
    await t.client.put('/config/cash.require_shift', { scope: 'tenant', value: false });
    for (let i = 0; i < 3; i++) await postKey(t.client, '/orders', { branchId: t.branchId, customerId: cust, lines: [{ serviceId: svc, quantity: 1 }] });
    const row = ((await op.c.get(`/platform/tenants?q=${encodeURIComponent('Zebra Wash')}`)).body.items as any[]).find((x) => x.id === t.tenantId);
    expect(row).toMatchObject({ status: 'trial', plan: { code: 'business' }, usage: { branches: 2, staffSeats: 2, ordersThisMonth: 3 } });
    expect(((await op.c.get('/platform/tenants?status=cancelled')).body.items as any[]).some((x) => x.id === t.tenantId)).toBe(false);
  });

  it('the platform console is disabled (503) when no platform database is configured', async () => {
    const off = await makeApp({ DATABASE_PLATFORM_URL: '' });
    const r = await new Client(off).post('/platform/auth/login', { email: 'a@b.test', password: PW, totp: '123456' });
    expect(r.status).toBe(503); expect(r.body.code).toBe('PLATFORM_DISABLED');
    await off.close();
  });
});

describe('least privilege in the database', () => {
  let app: App;
  beforeAll(async () => { app = await makeApp(); });
  afterAll(async () => { await app.close(); });

  it('the platform role sees metadata and counts only; it cannot read business data or change anything but a tenant\'s status', async () => {
    const t = await registerTenant(app); await t.client.post('/customers', { fullName: 'Secret Person', phone: '7805550123' });
    await asPlatform(async (c) => {
      expect((await c.query(`SELECT count(id)::int AS n FROM user_memberships`)).rows[0].n).toBeGreaterThan(0);
      for (const sql of [`SELECT * FROM customers`, `SELECT full_name FROM customers`, `SELECT * FROM orders`, `SELECT total_minor FROM orders`, `SELECT * FROM services`, `SELECT * FROM service_prices`, `SELECT * FROM payments`,
        `SELECT * FROM users`, `SELECT * FROM audit_logs`, `SELECT address FROM branches`, `SELECT name FROM branches`, `SELECT * FROM notifications`, `UPDATE tenants SET name = 'x'`, `DELETE FROM tenants`,
        `UPDATE branches SET status = 'archived'`, `INSERT INTO customers (id, tenant_id, full_name) VALUES (gen_random_uuid(), gen_random_uuid(), 'x')`, `UPDATE platform_audit_logs SET action = 'x'`]) {
        await expect(c.query(sql), sql).rejects.toMatchObject({ code: '42501' });
      }
    });
  });

  it('the tenant-facing application role cannot reach platform users or sessions, and cannot change a subscription', async () => {
    const t = await registerTenant(app); const other = await registerTenant(app);
    const db = new Database(APP_URL, 2);
    try {
      for (const sql of [`SELECT * FROM platform_users`, `SELECT * FROM platform_sessions`, `SELECT * FROM platform_audit_logs`, `UPDATE subscriptions SET plan_id = plan_id`, `DELETE FROM subscriptions`,
        `UPDATE subscription_plans SET price_minor = 0`, `INSERT INTO tenant_entitlement_overrides (id, tenant_id, key, value, reason, set_by) VALUES (gen_random_uuid(), gen_random_uuid(), 'limit.branches', '99', 'hack', gen_random_uuid())`]) {
        await expect(db.withContext({ tenantId: t.tenantId }, (tx) => tx.query(sql)), sql).rejects.toMatchObject({ code: '42501' });
      }
      // each business sees only its own subscription
      const rows = await db.withContext({ tenantId: t.tenantId }, async (tx) => (await tx.query(`SELECT tenant_id FROM subscriptions`)).rows);
      expect(rows.map((r) => r.tenant_id)).toEqual([t.tenantId]);
      expect((await db.withContext({ tenantId: other.tenantId }, async (tx) => (await tx.query(`SELECT tenant_id FROM subscriptions WHERE tenant_id = $1`, [t.tenantId])).rows))).toHaveLength(0);
      expect((await db.withContext({}, async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM subscriptions`)).rows[0].n))).toBe(0); // no context, no rows
    } finally { await db.close(); }
  });
});
