import 'reflect-metadata';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '@eazy/database';
import { NotificationsWorker } from '../src/notifications/worker.js';
import { APP_URL, Client, OWNER_URL, WORKER_URL, makeApp, postKey, registerTenant } from './helpers.js';

const PW = 'portal-password-123';
const addr = { line1: '10 Jasper Ave', city: 'Edmonton', province: 'AB', postalCode: 'T5J 2R4' };
const win = (h = 2) => ({ start: new Date(Date.now() + h * 3600_000).toISOString(), end: new Date(Date.now() + (h + 2) * 3600_000).toISOString() });
const uniqEmail = (p = 'cust') => `${p}${randomUUID().slice(0, 8)}@example.test`;

type App = Awaited<ReturnType<typeof makeApp>>;
async function asWorker<T>(fn: (c: pg.Client) => Promise<T>) { const c = new pg.Client({ connectionString: WORKER_URL }); await c.connect(); try { return await fn(c); } finally { await c.end(); } }
/** The most recent message queued for an address (the dev "logged" body keeps the link; nothing is actually sent). */
const lastMail = (to: string, template: string) => asWorker(async (c) => (await c.query(`SELECT body_text, status FROM notifications WHERE to_address = $1 AND template = $2 ORDER BY created_at DESC LIMIT 1`, [to, template])).rows[0]);
const tokenFrom = (body: string) => /token=([A-Za-z0-9_-]+)/.exec(body)![1];

async function business(app: App) {
  const t = await registerTenant(app);
  await t.client.put('/config/cash.require_shift', { scope: 'tenant', value: false });
  const shirt = (await t.client.post('/services', { code: 'SH', name: 'Shirt', description: 'Pressed and folded', pricingModel: 'per_item', turnaroundHours: 24, price: { unitPriceMinor: 1000 } })).body.id;
  await t.client.post('/delivery-zones', { name: 'Central', postalPrefixes: ['T5J'], feeMinor: 500 });
  const base = `/public/${t.slug}`;
  const c = new Client(app);
  const signup = async (email = uniqEmail(), name = 'Ada Lovelace', verify = true) => {
    const r = await c.post(`${base}/register`, { fullName: name, email, password: PW });
    expect(r.status).toBe(202);
    if (verify) {
      await app.get(NotificationsWorker).runOnce();
      const m = await lastMail(email, 'portal.verify_email');
      expect((await new Client(app).post(`${base}/verify-email`, { token: tokenFrom(m.body_text) })).status).toBe(200);
    }
    return email;
  };
  const login = async (email: string, password = PW) => { const cc = new Client(app); const r = await cc.post(`${base}/login`, { email, password }); return { cc, r }; };
  const customerAccount = async (name = 'Ada Lovelace') => { const email = await signup(undefined, name); const { cc } = await login(email); return { email, cc }; };
  return { t, shirt, base, signup, login, customerAccount, anon: c };
}
const addAddress = (cc: Client, over: any = {}) => cc.post('/portal/addresses', { ...addr, ...over });

describe('storefront accounts', () => {
  let app: App; let B: Awaited<ReturnType<typeof business>>;
  beforeAll(async () => { app = await makeApp(); B = await business(app); });
  afterAll(async () => { await app.close(); });

  it('serves public business info, prices and delivery coverage without leaking internals; unknown or suspended businesses look identical', async () => {
    const info = await B.anon.get(B.base);
    expect(info.body).toMatchObject({ slug: B.t.slug, branches: [{ name: 'Main' }] });
    const svc = (await B.anon.get(`${B.base}/services`)).body.items as any[];
    expect(svc).toHaveLength(1);
    expect(svc[0]).toMatchObject({ name: 'Shirt', unitPriceMinor: 1000, pricingModel: 'per_item', taxable: true });
    expect(Object.keys(svc[0]).sort()).toEqual(['description', 'expressAvailable', 'id', 'minChargeMinor', 'name', 'pricingModel', 'taxable', 'turnaroundHours', 'unitPriceMinor']);
    expect((await B.anon.get(`${B.base}/coverage?postalCode=T5J 2R4`)).body).toMatchObject({ covered: true, zone: 'Central', feeMinor: 500 });
    expect((await B.anon.get(`${B.base}/coverage?postalCode=V6B1A1`)).body.covered).toBe(false);
    const unknown = await B.anon.get('/public/no-such-business'); expect(unknown.status).toBe(404);
    const c = new pg.Client({ connectionString: OWNER_URL }); await c.connect();
    try { await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [B.t.tenantId]); await c.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [B.t.tenantId]); } finally { await c.end(); }
    const suspended = await B.anon.get(B.base); expect(suspended.status).toBe(404); expect(suspended.body.code).toBe(unknown.body.code);
    const c2 = new pg.Client({ connectionString: OWNER_URL }); await c2.connect();
    try { await c2.query(`SELECT set_config('app.tenant_id', $1, false)`, [B.t.tenantId]); await c2.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [B.t.tenantId]); } finally { await c2.end(); }
  });

  it('registers, requires email verification, then signs in; verification links work once', async () => {
    const email = uniqEmail();
    expect((await B.anon.post(`${B.base}/register`, { fullName: 'Weak', email, password: 'short' })).status).toBe(400);
    await B.signup(email, 'Grace Hopper', false);
    const pending = await B.login(email);
    expect(pending.r.status).toBe(403); expect(pending.r.body.code).toBe('EMAIL_NOT_VERIFIED');
    expect((await B.login(email, 'wrong-wrong-wrong')).r.body.code).toBe('INVALID_CREDENTIALS'); // wrong password reveals nothing
    await app.get(NotificationsWorker).runOnce();
    const token = tokenFrom((await lastMail(email, 'portal.verify_email')).body_text);
    expect((await B.anon.post(`${B.base}/verify-email`, { token: 'x'.repeat(43) })).body.code).toBe('INVALID_TOKEN');
    expect((await B.anon.post(`${B.base}/verify-email`, { token })).status).toBe(200);
    expect((await B.anon.post(`${B.base}/verify-email`, { token })).body.code).toBe('INVALID_TOKEN'); // single use
    const { cc, r } = await B.login(email);
    expect(r.status).toBe(200);
    expect((await cc.get('/portal/me')).body).toMatchObject({ customer: { fullName: 'Grace Hopper', email }, business: { slug: B.t.slug } });
    const raw = (await new Client(app).post(`${B.base}/login`, { email, password: PW })).headers['set-cookie'] as string[];
    expect(raw.find((x) => x.startsWith('eazy_csid'))).toMatch(/HttpOnly/i);
  });

  it('registration is indistinguishable for new and existing emails, and an existing account is told by email instead', async () => {
    const email = await B.signup();
    const again = await B.anon.post(`${B.base}/register`, { fullName: 'Someone Else', email, password: PW });
    const fresh = await B.anon.post(`${B.base}/register`, { fullName: 'Brand New', email: uniqEmail(), password: PW });
    expect(again.status).toBe(202); expect(again.body).toEqual(fresh.body);
    expect((await lastMail(email, 'portal.account_exists')).status).toBe('queued');
    // the existing account's password was not replaced by the second registration
    expect((await B.login(email, PW)).r.status).toBe(200);
  });

  it('an unverified registration cannot read a walk-in customer\'s history; verification (proving the email) links it', async () => {
    const email = uniqEmail('walkin');
    const cust = (await B.t.client.post('/customers', { fullName: 'Walk In', email, phone: '7805559991', address: addr })).body.id;
    const order = (await postKey(B.t.client, '/orders', { branchId: B.t.branchId, customerId: cust, lines: [{ serviceId: B.shirt, quantity: 1 }] })).body;
    await B.signup(email, 'Attacker Typed Name', false);
    expect((await B.login(email)).r.status).toBe(403); // pending: no access to anything
    await B.signup; // (no-op) — now verify through the emailed link
    await app.get(NotificationsWorker).runOnce();
    await B.anon.post(`${B.base}/verify-email`, { token: tokenFrom((await lastMail(email, 'portal.verify_email')).body_text) });
    const { cc } = await B.login(email);
    const orders = (await cc.get('/portal/orders')).body.items as any[];
    expect(orders.map((o) => o.orderNo)).toEqual([order.orderNo]); // linked to the existing record
    expect((await cc.get('/portal/me')).body.customer.fullName).toBe('Walk In'); // the record's own name, not the typed one
  });

  it('locks an account after repeated wrong passwords, even for the correct one', async () => {
    const email = await B.signup();
    for (let i = 0; i < 5; i++) await B.login(email, 'wrong-wrong-wrong');
    const r = await B.login(email, PW);
    expect(r.r.status).toBe(401);
  });

  it('password reset: uniform response, single-use expiring link, signs everyone out, old password stops working', async () => {
    const email = await B.signup(); const { cc: oldSession } = await B.login(email);
    const known = await B.anon.post(`${B.base}/forgot-password`, { email }); const unknown = await B.anon.post(`${B.base}/forgot-password`, { email: uniqEmail() });
    expect(known.status).toBe(202); expect(known.body).toEqual(unknown.body);
    await app.get(NotificationsWorker).runOnce();
    const token = tokenFrom((await lastMail(email, 'portal.reset_password')).body_text);
    expect((await B.anon.post(`${B.base}/reset-password`, { token, password: 'short' })).status).toBe(400);
    expect((await B.anon.post(`${B.base}/reset-password`, { token, password: 'a-brand-new-password' })).status).toBe(200);
    expect((await B.anon.post(`${B.base}/reset-password`, { token, password: 'another-new-password' })).body.code).toBe('INVALID_TOKEN');
    expect((await oldSession.get('/portal/me')).status).toBe(401);
    expect((await B.login(email, PW)).r.status).toBe(401);
    expect((await B.login(email, 'a-brand-new-password')).r.status).toBe(200);
  });

  it('customer and staff sessions never satisfy each other\'s routes; customer writes need the CSRF token', async () => {
    const { cc } = await B.customerAccount();
    expect((await cc.get('/customers')).status).toBe(401); // customer cookie on a staff route
    expect((await cc.get('/branches')).status).toBe(401);
    expect((await B.t.client.get('/portal/me')).status).toBe(401); // staff cookie on a portal route
    expect((await cc.req('post', '/portal/addresses', addr, { csrf: false })).body.code).toBe('CSRF');
    expect((await addAddress(cc)).status).toBe(201);
    expect((await cc.post('/portal/logout')).status).toBe(204);
    expect((await cc.get('/portal/me')).status).toBe(401);
  });

  it('manages addresses and profile', async () => {
    const { cc } = await B.customerAccount();
    expect((await addAddress(cc, { postalCode: 'D1D 1D1' })).status).toBe(400);
    const a1 = (await addAddress(cc)).body.id; const a2 = (await addAddress(cc, { label: 'Work', line1: '99 Whyte Ave', isDefault: true })).body.id;
    let list = (await cc.get('/portal/me')).body.addresses as any[];
    expect(list.filter((x) => x.isDefault).map((x) => x.id)).toEqual([a2]);
    expect((await cc.req('delete', `/portal/addresses/${a2}`)).status).toBe(204);
    list = (await cc.get('/portal/me')).body.addresses; expect(list.map((x) => [x.id, x.isDefault])).toEqual([[a1, true]]);
    expect((await cc.patch('/portal/me', { fullName: 'Ada L.', phone: '(587) 555-0142' })).status).toBe(200);
    expect((await cc.get('/portal/me')).body.customer).toMatchObject({ fullName: 'Ada L.', phone: '+15875550142' });
    expect((await cc.patch('/portal/me', {})).status).toBe(400);
  });
});

describe('storefront bookings and order tracking', () => {
  let app: App; let B: Awaited<ReturnType<typeof business>>;
  beforeAll(async () => { app = await makeApp(); B = await business(app); });
  afterAll(async () => { await app.close(); });

  it('books a pickup in a covered area, shows it to dispatch, queues a confirmation, and limits open bookings', async () => {
    const { email, cc } = await B.customerAccount();
    const a = (await addAddress(cc)).body.id;
    const far = (await addAddress(cc, { label: 'Far', city: 'Vancouver', province: 'BC', postalCode: 'V6B 1A1' })).body.id;
    expect((await cc.post('/portal/bookings', { addressId: far, window: win() })).body.code).toBe('OUT_OF_ZONE');
    expect((await cc.post('/portal/bookings', { addressId: randomUUID(), window: win() })).status).toBe(404);
    expect((await cc.post('/portal/bookings', { addressId: a, window: { start: win(5).end, end: win(5).start } })).status).toBe(400);
    const r = await cc.post('/portal/bookings', { addressId: a, window: win(), notes: 'Two bags by the door' });
    expect(r.status).toBe(201);
    const task = (await B.t.client.get(`/delivery-tasks/${r.body.id}`)).body;
    expect(task).toMatchObject({ kind: 'pickup', status: 'requested', notes: 'Two bags by the door', contactName: 'Ada Lovelace' });
    expect((await lastMail(email, 'pickup.booked')).status).toBe('queued');
    expect(((await cc.get('/portal/bookings')).body.items as any[])[0]).toMatchObject({ id: r.body.id, status: 'requested' });
    for (let i = 0; i < 4; i++) expect((await cc.post('/portal/bookings', { addressId: a, window: win(3 + i) })).status).toBe(201);
    expect((await cc.post('/portal/bookings', { addressId: a, window: win(9) })).body.code).toBe('TOO_MANY_BOOKINGS');
  });

  it('customers can cancel only their own pickups, and only before the driver is on the way', async () => {
    const { cc } = await B.customerAccount(); const other = await B.customerAccount('Other Person');
    const a = (await addAddress(cc)).body.id; const id = (await cc.post('/portal/bookings', { addressId: a, window: win() })).body.id;
    expect((await other.cc.post(`/portal/bookings/${id}/cancel`)).status).toBe(404);
    expect(((await other.cc.get('/portal/bookings')).body.items as any[])).toHaveLength(0);
    const driver = await (async () => { const roles = (await B.t.client.get('/roles')).body.items as any[]; const email = uniqEmail('drv');
      await B.t.client.post('/members', { email, fullName: 'Dana Driver', roleId: roles.find((r) => r.key === 'driver').id, allBranches: true, temporaryPassword: PW });
      const c = new Client(app); await c.post('/auth/login', { email, password: PW }); await c.post('/auth/change-password', { currentPassword: PW, newPassword: `${PW}-x` }); return c; })();
    const t2 = (await cc.post('/portal/bookings', { addressId: a, window: win(6) })).body.id;
    await B.t.client.post(`/delivery-tasks/${t2}/assign`, { driverUserId: (await driver.get('/auth/me')).body.user.id });
    await driver.post(`/delivery-tasks/${t2}/start`);
    expect((await cc.post(`/portal/bookings/${t2}/cancel`)).body.code).toBe('NOT_CANCELLABLE');
    expect((await cc.post(`/portal/bookings/${id}/cancel`)).body.status).toBe('cancelled');
    expect((await cc.post(`/portal/bookings/${id}/cancel`)).body.code).toBe('NOT_CANCELLABLE');
  });

  it('tracks an order end to end: friendly progress, no internal data, and the delivery code only while it is useful', async () => {
    const email = uniqEmail('track');
    const cust = (await B.t.client.post('/customers', { fullName: 'Track Me', email, phone: '7805550777', address: addr })).body.id;
    const addressId = (await B.t.client.get(`/customers/${cust}`)).body.addresses[0].id;
    await B.signup(email, 'Track Me'); const { cc } = await B.login(email);
    const o = (await postKey(B.t.client, '/orders', { branchId: B.t.branchId, customerId: cust, lines: [{ serviceId: B.shirt, quantity: 2 }], deliveryAddressId: addressId, deliveryWindow: win(), instructions: 'Light starch' })).body;
    let d = (await cc.get(`/portal/orders/${o.id}`)).body;
    expect(d.progress).toMatchObject({ step: 'received', label: 'Received' });
    expect(d.receipt).toMatchObject({ orderNo: o.orderNo, totalMinor: 2625, deliveryFeeMinor: 500, instructions: 'Light starch' });
    const otp = (await B.t.client.get(`/delivery-tasks/${o.deliveryTaskId}`)).body.otp;
    expect(d.delivery).toMatchObject({ status: 'requested', city: 'Edmonton', code: otp });
    for (const k of ['events', 'stageKey', 'reworkCount', 'scanToken', 'createdBy']) expect(JSON.stringify(d)).not.toContain(`"${k}"`);
    const step = (from: string, to?: string) => B.t.client.post(`/orders/${o.id}/advance`, { fromStageKey: from, ...(to ? { toStageKey: to } : {}) });
    await step('received'); await step('intake'); await step('sorting');
    expect((await cc.get(`/portal/orders/${o.id}`)).body.progress.step).toBe('processing');
    await step('washing'); await step('drying', 'folding'); await step('folding'); await B.t.client.post(`/orders/${o.id}/qc`, { result: 'pass' }); await step('packaging');
    expect((await cc.get('/portal/orders')).body.items[0]).toMatchObject({ orderNo: o.orderNo, progress: { step: 'ready' }, balanceMinor: 2625 });
    await postKey(B.t.client, `/orders/${o.id}/payments`, { method: 'card_external', amountMinor: 2625 });
    // dispatch assigns a driver who delivers it
    const roles = (await B.t.client.get('/roles')).body.items as any[]; const demail = uniqEmail('drv2');
    await B.t.client.post('/members', { email: demail, fullName: 'Dana Driver', roleId: roles.find((r) => r.key === 'driver').id, allBranches: true, temporaryPassword: PW });
    const drv = new Client(app); await drv.post('/auth/login', { email: demail, password: PW }); await drv.post('/auth/change-password', { currentPassword: PW, newPassword: `${PW}-x` });
    await B.t.client.post(`/delivery-tasks/${o.deliveryTaskId}/assign`, { driverUserId: (await drv.get('/auth/me')).body.user.id });
    await drv.post(`/delivery-tasks/${o.deliveryTaskId}/start`);
    d = (await cc.get(`/portal/orders/${o.id}`)).body;
    expect(d.delivery).toMatchObject({ status: 'en_route', code: otp }); expect(d.timeline.map((t: any) => t.label)).toContain('Driver is on the way');
    expect((await drv.post(`/delivery-tasks/${o.deliveryTaskId}/complete`, { proof: { type: 'otp', code: otp } })).status).toBe(200);
    d = (await cc.get(`/portal/orders/${o.id}`)).body;
    expect(d.progress.step).toBe('completed'); expect(d.delivery).toMatchObject({ status: 'completed', code: null });
    expect(d.timeline.map((t: any) => t.label)).toEqual(expect.arrayContaining(['Order received', 'Ready', 'Delivered', 'Completed']));
  });

  it('customers only ever see their own orders: other customers\' orders and other businesses\' orders do not exist for them', async () => {
    const a = await B.customerAccount('Alice'); const b = await B.customerAccount('Bob');
    // staff create an order for Alice by linking through her email-matched customer record
    const aliceCust = ((await a.cc.get('/portal/me')).body); void aliceCust;
    const staffCustA = (await B.t.client.get(`/customers?q=${encodeURIComponent(a.email)}`)).body.items[0].id;
    const o = (await postKey(B.t.client, '/orders', { branchId: B.t.branchId, customerId: staffCustA, lines: [{ serviceId: B.shirt, quantity: 1 }] })).body;
    expect(((await a.cc.get('/portal/orders')).body.items as any[]).map((x) => x.id)).toEqual([o.id]);
    expect(((await b.cc.get('/portal/orders')).body.items as any[])).toHaveLength(0);
    expect((await b.cc.get(`/portal/orders/${o.id}`)).status).toBe(404);
    const other = await business(app); const x = await other.customerAccount('Eve');
    expect((await x.cc.get(`/portal/orders/${o.id}`)).status).toBe(404);
    expect(((await x.cc.get('/portal/orders')).body.items as any[])).toHaveLength(0);
  });
});

describe('customer scope is enforced by the database itself', () => {
  it('a session context sees only its own customer rows in every customer-linked table, even for hand-written queries', async () => {
    const app = await makeApp(); const B = await business(app);
    const a = await B.customerAccount('Alice'); const b = await B.customerAccount('Bob');
    const find = async (email: string) => (await B.t.client.get(`/customers?q=${encodeURIComponent(email)}`)).body.items[0].id as string;
    const [custA, custB] = [await find(a.email), await find(b.email)];
    for (const c of [custA, custB]) {
      const addrId = (await B.t.client.post(`/customers/${c}/addresses`, addr)).body.id; void addrId;
      const o = (await postKey(B.t.client, '/orders', { branchId: B.t.branchId, customerId: c, lines: [{ serviceId: B.shirt, quantity: 1 }], deliveryAddressId: (await B.t.client.get(`/customers/${c}`)).body.addresses[0].id, deliveryWindow: win() })).body;
      await postKey(B.t.client, `/orders/${o.id}/payments`, { method: 'card_external', amountMinor: 100 });
    }
    const db = new Database(APP_URL, 3);
    try {
      for (const t of ['orders', 'order_lines', 'order_events', 'payments', 'payment_allocations', 'delivery_tasks', 'delivery_events', 'customers', 'customer_addresses']) {
        const asA = await db.withContext({ tenantId: B.t.tenantId, customerId: custA, allBranches: true }, async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n);
        const staff = await db.withContext({ tenantId: B.t.tenantId, allBranches: true }, async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n);
        expect(asA, `${t}: customer sees something`).toBeGreaterThan(0);
        expect(asA, `${t}: customer must see strictly less than staff`).toBeLessThan(staff);
      }
      const leak = await db.withContext({ tenantId: B.t.tenantId, customerId: custA, allBranches: true }, async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM orders WHERE customer_id = $1`, [custB])).rows[0].n);
      expect(leak).toBe(0);
      await expect(db.withContext({ tenantId: B.t.tenantId, customerId: custA, allBranches: true }, (tx) =>
        tx.query(`INSERT INTO customer_addresses (id, tenant_id, customer_id, line1, city, province, postal_code) VALUES (gen_random_uuid(), $1, $2, 'x', 'Edmonton', 'AB', 'T5J 2R4')`, [B.t.tenantId, custB]))).rejects.toMatchObject({ code: '42501' });
    } finally { await db.close(); }
    await app.close();
  });
});
