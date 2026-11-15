import 'reflect-metadata';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, OWNER_URL, addStaff, makeApp, registerTenant } from './helpers.js';

type T = Awaited<ReturnType<typeof registerTenant>>;
const key = () => `k-${randomUUID()}`;

async function setup(app: any) {
  const t: T = await registerTenant(app);
  // These suites test order/payment mechanics; till (shift) enforcement has its own suite (cash.test.ts).
  await t.client.put('/config/cash.require_shift', { scope: 'tenant', value: false });
  const wf = (await t.client.post('/services', { code: 'WF', name: 'Wash & Fold', pricingModel: 'per_kg', expressCapable: true, turnaroundHours: 48,
    price: { unitPriceMinor: 250, minChargeMinor: 1000, express: { type: 'percent', percent: 50 } } })).body.id;
  const shirt = (await t.client.post('/services', { code: 'SH', name: 'Shirt', pricingModel: 'per_item', turnaroundHours: 24, price: { unitPriceMinor: 399 } })).body.id;
  const customer = (await t.client.post('/customers', { fullName: 'Ada Lovelace', phone: '7805550101' })).body.id;
  return { t, wf, shirt, customer };
}
/** POST with an Idempotency-Key header (the helper client does not set one). */
async function postWithKey(c: Client, url: string, body: unknown, k: string | null) {
  const supertest = (await import('supertest')).default;
  let r = supertest(c.app.getHttpServer()).post(url).set('Cookie', Object.entries(c.cookies).map(([a, b]) => `${a}=${b}`).join('; ')).set('x-csrf-token', c.cookies.eazy_csrf);
  if (k) r = r.set('Idempotency-Key', k);
  return r.send(body as object);
}

describe('orders & payments', () => {
  let app: Awaited<ReturnType<typeof makeApp>>;
  let s: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => { app = await makeApp(); s = await setup(app); });
  afterAll(async () => { await app.close(); });

  const create = (over: any = {}, k = key()) => postWithKey(s.t.client, '/orders', { branchId: s.t.branchId, customerId: s.customer, lines: [{ serviceId: s.wf, weightG: 6500 }], ...over }, k);

  it('creates an order priced by the server, identical to the quote, with a readable order number', async () => {
    const q = (await s.t.client.post('/pricing/quote', { branchId: s.t.branchId, lines: [{ serviceId: s.wf, weightG: 6500 }] })).body;
    const r = await create();
    expect(r.status).toBe(201);
    expect(r.body.orderNo).toMatch(/^MAIN-\d{4}-\d{5}$/);
    expect(r.body.totalMinor).toBe(q.totalMinor);
    const o = (await s.t.client.get(`/orders/${r.body.id}`)).body;
    expect(o).toMatchObject({ status: 'open', customerName: 'Ada Lovelace', totalMinor: 1706, paidMinor: 0, balanceMinor: 1706, paymentStatus: 'unpaid', currency: 'CAD' });
    expect(o.lines[0]).toMatchObject({ code: 'WF', weightG: 6500, unitPriceMinor: 250, baseMinor: 1625, taxMinor: 81, taxBreakdown: { GST: 81 } });
    expect(o.events.map((e: any) => e.type)).toEqual(['order.created']);
    expect(new Date(o.promisedAt).getTime() - new Date(o.createdAt).getTime()).toBeGreaterThan(47 * 3600_000);
  });

  it('requires an Idempotency-Key and replays safely', async () => {
    expect((await create({}, null as any)).body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const k = key();
    const a = await create({}, k), b = await create({}, k);
    expect(a.status).toBe(201); expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id); expect(b.body.replayed).toBe(true); expect(a.body.replayed).toBe(false);
    const other = await create({ instructions: 'different' }, k);
    expect(other.status).toBe(422); expect(other.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('five simultaneous submissions with the same key create exactly one order', async () => {
    const k = key();
    const before = (await s.t.client.get('/orders?limit=100')).body.items.length;
    const rs = await Promise.all(Array.from({ length: 5 }, () => create({}, k)));
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect((await s.t.client.get('/orders?limit=100')).body.items.length).toBe(before + 1);
  });

  it('order numbers are unique and gap-free under concurrency, and separate per branch', async () => {
    const T2 = await registerTenant(app);
    const svc = (await T2.client.post('/services', { code: 'FX', name: 'Fixed', pricingModel: 'fixed', price: { unitPriceMinor: 500 } })).body.id;
    const cust = (await T2.client.post('/customers', { kind: 'guest', fullName: 'Walk-in' })).body.id;
    const north = (await T2.client.post('/branches', { code: 'NORTH', name: 'North' })).body.id;
    const mk = (branchId: string) => postWithKey(T2.client, '/orders', { branchId, customerId: cust, lines: [{ serviceId: svc, quantity: 1 }] }, key());
    const rs = await Promise.all([...Array(8)].map(() => mk(T2.branchId)).concat([...Array(3)].map(() => mk(north))));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    const seq = (code: string) => rs.map((r) => r.body.orderNo as string).filter((n) => n.startsWith(code + '-')).map((n) => Number(n.split('-')[2])).sort((a, b) => a - b);
    expect(seq('MAIN')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(seq('NORTH')).toEqual([1, 2, 3]);
  });

  it('an order keeps the price it was created with when prices, tax and settings change later', async () => {
    const k = await create();
    const id = k.body.id;
    await s.t.client.put(`/services/${s.wf}/price`, { unitPriceMinor: 999, minChargeMinor: 0, express: { type: 'percent', percent: 50 } });
    await s.t.client.put('/config/tax.price_mode', { scope: 'tenant', value: 'inclusive' });
    const o = (await s.t.client.get(`/orders/${id}`)).body;
    expect(o.totalMinor).toBe(1706); expect(o.priceMode).toBe('exclusive'); expect(o.lines[0].unitPriceMinor).toBe(250);
    // restore for later tests
    await s.t.client.put(`/services/${s.wf}/price`, { unitPriceMinor: 250, minChargeMinor: 1000, express: { type: 'percent', percent: 50 } });
    await s.t.client.put('/config/tax.price_mode', { scope: 'tenant', value: 'exclusive' });
  });

  it('order lines, payments and events are immutable at the database level', async () => {
    const id = (await create({ payment: { method: 'cash', amountMinor: 500 } })).body.id; // has a payment, allocation and events
    const c = new pg.Client({ connectionString: OWNER_URL }); await c.connect();
    try {
      await c.query(`SELECT set_config('app.tenant_id', $1, false), set_config('app.all_branches', 'true', false)`, [s.t.tenantId]);
      await expect(c.query(`UPDATE order_lines SET total_minor = 1 WHERE order_id = $1`, [id])).rejects.toMatchObject({ code: '23001' });
      await expect(c.query(`DELETE FROM order_events WHERE order_id = $1`, [id])).rejects.toMatchObject({ code: '23001' });
      await expect(c.query(`UPDATE payments SET amount_minor = 1`)).rejects.toMatchObject({ code: '23001' });
      await expect(c.query(`UPDATE orders SET paid_minor = total_minor + 1 WHERE id = $1`, [id])).rejects.toMatchObject({ code: '23514' }); // paid <= total
    } finally { await c.end(); }
  });

  it('takes multiple payments: partial, then the rest, with cash change and status transitions', async () => {
    const id = (await create()).body.id; // total 1706
    const pay = (body: any, k = key()) => postWithKey(s.t.client, `/orders/${id}/payments`, body, k);
    const p1 = await pay({ method: 'card_external', amountMinor: 700, reference: 'TERM-1' });
    expect(p1.status).toBe(201); expect(p1.body).toMatchObject({ balanceMinor: 1006, changeMinor: 0 });
    expect((await s.t.client.get(`/orders/${id}`)).body.paymentStatus).toBe('partial');
    expect((await pay({ method: 'card_external', amountMinor: 700, tenderedMinor: 800 })).body.code).toBe('TENDERED_NOT_APPLICABLE');
    expect((await pay({ method: 'cash', amountMinor: 1007 })).body.code).toBe('OVERPAYMENT');
    expect((await pay({ method: 'cash', amountMinor: 1006, tenderedMinor: 1000 })).body.code).toBe('TENDERED_TOO_LOW');
    const p2 = await pay({ method: 'cash', amountMinor: 1006, tenderedMinor: 2000 });
    expect(p2.body).toMatchObject({ balanceMinor: 0, changeMinor: 994 });
    const o = (await s.t.client.get(`/orders/${id}`)).body;
    expect(o).toMatchObject({ paymentStatus: 'paid', paidMinor: 1706, balanceMinor: 0 });
    expect(o.payments).toHaveLength(2);
    expect(o.payments.reduce((a: number, p: any) => a + p.amountMinor, 0)).toBe(o.paidMinor); // payments reconcile to the order
    expect((await pay({ method: 'cash', amountMinor: 1 })).body.code).toBe('ALREADY_PAID');
    expect(o.events.map((e: any) => e.type)).toEqual(['order.created', 'payment.recorded', 'payment.recorded']);
  });

  it('duplicate payment submissions never double-charge (same key, concurrent) and over-payment is blocked across keys', async () => {
    const id = (await create()).body.id;
    const k = key();
    const rs = await Promise.all(Array.from({ length: 4 }, () => postWithKey(s.t.client, `/orders/${id}/payments`, { method: 'cash', amountMinor: 1706 }, k)));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(new Set(rs.map((r) => r.body.paymentId)).size).toBe(1);
    expect((await s.t.client.get(`/orders/${id}`)).body.payments).toHaveLength(1);
    // a *different* key for the same full amount is a new payment attempt and must be rejected (already paid)
    expect((await postWithKey(s.t.client, `/orders/${id}/payments`, { method: 'cash', amountMinor: 1706 }, key())).status).toBe(409);
    // racing two different-key payments that together exceed the balance: only one can win
    const id2 = (await create()).body.id;
    const race = await Promise.all([postWithKey(s.t.client, `/orders/${id2}/payments`, { method: 'cash', amountMinor: 1000 }, key()), postWithKey(s.t.client, `/orders/${id2}/payments`, { method: 'cash', amountMinor: 1000 }, key())]);
    expect(race.map((r) => r.status).sort()).toEqual([201, 422]);
    expect((await s.t.client.get(`/orders/${id2}`)).body.paidMinor).toBe(1000);
  });

  it('accepts an initial payment at order creation, atomically', async () => {
    const r = await create({ payment: { method: 'cash', amountMinor: 1706, tenderedMinor: 2000 } });
    expect(r.body).toMatchObject({ paidMinor: 1706, changeMinor: 294 });
    expect((await s.t.client.get(`/orders/${r.body.id}`)).body.paymentStatus).toBe('paid');
    const tooMuch = await create({ payment: { method: 'cash', amountMinor: 9999 } });
    expect(tooMuch.status).toBe(422);
    const orders = (await s.t.client.get('/orders?limit=100')).body.items as any[];
    expect(orders.filter((o) => o.totalMinor === 1706 && o.paidMinor === 9999)).toHaveLength(0); // nothing half-created
  });

  it('cancels unpaid open orders only, with a reason, and blocks payments afterwards', async () => {
    const id = (await create()).body.id;
    const cancel = (oid: string, body: any = { reason: 'Customer changed their mind' }) => s.t.client.post(`/orders/${oid}/cancel`, body);
    expect((await cancel(id, { reason: 'x' })).status).toBe(400);
    expect((await cancel(id)).body.status).toBe('cancelled');
    expect((await cancel(id)).body.code).toBe('NOT_CANCELLABLE');
    expect((await postWithKey(s.t.client, `/orders/${id}/payments`, { method: 'cash', amountMinor: 100 }, key())).body.code).toBe('ORDER_CANCELLED');
    const paid = (await create({ payment: { method: 'cash', amountMinor: 500 } })).body.id;
    expect((await cancel(paid)).body.code).toBe('REFUND_REQUIRED');
    const o = (await s.t.client.get(`/orders/${id}`)).body;
    expect(o.cancelledReason).toBe('Customer changed their mind'); expect(o.events.map((e: any) => e.type)).toContain('order.cancelled');
  });

  it('returns a complete receipt with GST breakdown, payments and balance', async () => {
    const r = await create({ express: true, payment: { method: 'card_external', amountMinor: 1000 } });
    const rc = (await s.t.client.get(`/orders/${r.body.id}/receipt`)).body;
    expect(rc).toMatchObject({ branch: 'Main', orderNo: r.body.orderNo, customerName: 'Ada Lovelace', express: true, currency: 'CAD', paidMinor: 1000 });
    expect(rc.business).toMatch(/^Biz/);
    expect(rc.taxByComponent.GST).toBe(rc.taxMinor);
    expect(rc.balanceMinor).toBe(rc.totalMinor - 1000);
    expect(rc.promisedLocal).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(rc.lines).toHaveLength(1); expect(rc.dateLocal).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('validates customers, services and discounts', async () => {
    expect((await create({ customerId: randomUUID() })).status).toBe(404);
    const cid = (await s.t.client.post('/customers', { fullName: 'Old Customer', phone: '5875550999' })).body.id;
    const v = (await s.t.client.get(`/customers/${cid}`)).body.version;
    await s.t.client.patch(`/customers/${cid}`, { version: v, archived: true });
    expect((await create({ customerId: cid })).body.code).toBe('CUSTOMER_ARCHIVED');
    expect((await create({ lines: [{ serviceId: s.wf }] })).body.code).toBe('WEIGHT_REQUIRED');
    // guest customers can buy
    const g = (await s.t.client.post('/customers', { kind: 'guest', fullName: 'Walk-in' })).body.id;
    expect((await create({ customerId: g, lines: [{ serviceId: s.shirt, quantity: 3 }] })).status).toBe(201);
  });

  it('enforces permissions: payment.take for initial payments, approval limits on discounts, no creating without order.create', async () => {
    const roles = (await s.t.client.get('/roles')).body.items as any[];
    const cashier = roles.find((r) => r.key === 'cashier').permissions;
    await s.t.client.post('/roles', { key: 'no_pay', name: 'No pay', permissions: cashier.filter((p: any) => p.code !== 'payment.take') });
    const noPay = await addStaff(s.t.client, 'no_pay');
    expect((await postWithKey(noPay.client, '/orders', { branchId: s.t.branchId, customerId: s.customer, lines: [{ serviceId: s.wf, weightG: 2000 }], payment: { method: 'cash', amountMinor: 100 } }, key())).status).toBe(403);
    expect((await postWithKey(noPay.client, '/orders', { branchId: s.t.branchId, customerId: s.customer, lines: [{ serviceId: s.wf, weightG: 2000 }] }, key())).status).toBe(201);
    await s.t.client.post('/roles', { key: 'junior', name: 'Junior', permissions: cashier.map((p: any) => (p.code === 'discount.apply' ? { ...p, maxAmountMinor: 100 } : p)) });
    const junior = await addStaff(s.t.client, 'junior');
    const body = { branchId: s.t.branchId, customerId: s.customer, lines: [{ serviceId: s.wf, weightG: 6500 }] };
    expect((await postWithKey(junior.client, '/orders', { ...body, discount: { type: 'fixed', amountMinor: 500 } }, key())).body.code).toBe('DISCOUNT_LIMIT_EXCEEDED');
    expect((await postWithKey(junior.client, '/orders', { ...body, discount: { type: 'fixed', amountMinor: 100 } }, key())).status).toBe(201);
    const tech = await addStaff(s.t.client, 'production_tech');
    expect((await postWithKey(tech.client, '/orders', body, key())).status).toBe(403);
    expect((await tech.client.get('/orders')).status).toBe(200); // can read orders to work them
    const cashierStaff = await addStaff(s.t.client, 'cashier');
    const oid = (await create()).body.id;
    expect((await cashierStaff.client.post(`/orders/${oid}/cancel`, { reason: 'trying to cancel' })).status).toBe(403);
  });

  it('every order action is audited', async () => {
    const actions = ((await s.t.client.get('/audit-logs?limit=200')).body.items as any[]).map((i) => i.action);
    expect(actions).toEqual(expect.arrayContaining(['order.created', 'payment.recorded', 'order.cancelled']));
  });

  it('lists and searches orders by number, customer, status and unpaid', async () => {
    const all = (await s.t.client.get('/orders?limit=100')).body.items as any[];
    const one = all[0];
    expect(((await s.t.client.get(`/orders?q=${one.orderNo}`)).body.items as any[]).map((o) => o.id)).toContain(one.id);
    expect(((await s.t.client.get('/orders?q=lovelace&limit=100')).body.items as any[]).length).toBeGreaterThan(3);
    expect(((await s.t.client.get('/orders?status=cancelled')).body.items as any[]).every((o) => o.status === 'cancelled')).toBe(true);
    expect(((await s.t.client.get('/orders?unpaid=true&limit=100')).body.items as any[]).every((o) => o.balanceMinor > 0 && o.status !== 'cancelled')).toBe(true);
    expect((await s.t.client.get('/orders?q=%25')).body.items).toHaveLength(0);
  });
});

describe('orders — branch and tenant isolation', () => {
  it('branch-limited staff only see and act on their own branch (enforced by RLS)', async () => {
    const app = await makeApp();
    const s = await setup(app);
    const north = (await s.t.client.post('/branches', { code: 'NORTH', name: 'North' })).body.id;
    const mainOrder = (await postWithKey(s.t.client, '/orders', { branchId: s.t.branchId, customerId: s.customer, lines: [{ serviceId: s.shirt, quantity: 1 }] }, key())).body.id;
    const northOrder = (await postWithKey(s.t.client, '/orders', { branchId: north, customerId: s.customer, lines: [{ serviceId: s.shirt, quantity: 1 }] }, key())).body.id;
    const scoped = await addStaff(s.t.client, 'cashier', { allBranches: false, branchIds: [north] });
    const ids = ((await scoped.client.get('/orders?limit=100')).body.items as any[]).map((o) => o.id);
    expect(ids).toEqual([northOrder]);
    expect((await scoped.client.get(`/orders/${mainOrder}`)).status).toBe(404);
    expect((await scoped.client.get(`/orders/${mainOrder}/receipt`)).status).toBe(404);
    expect((await postWithKey(scoped.client, `/orders/${mainOrder}/payments`, { method: 'cash', amountMinor: 100 }, key())).status).toBe(404);
    expect((await postWithKey(scoped.client, '/orders', { branchId: s.t.branchId, customerId: s.customer, lines: [{ serviceId: s.shirt, quantity: 1 }] }, key())).status).toBe(404);
    expect((await postWithKey(scoped.client, '/orders', { branchId: north, customerId: s.customer, lines: [{ serviceId: s.shirt, quantity: 1 }] }, key())).status).toBe(201);
    await app.close();
  });

  it("another business cannot read, pay, cancel or build orders from a tenant's data", async () => {
    const app = await makeApp();
    const A = await setup(app); const B = await setup(app);
    const aOrder = (await postWithKey(A.t.client, '/orders', { branchId: A.t.branchId, customerId: A.customer, lines: [{ serviceId: A.shirt, quantity: 1 }] }, key())).body.id;
    expect((await B.t.client.get(`/orders/${aOrder}`)).status).toBe(404);
    expect((await B.t.client.get(`/orders/${aOrder}/receipt`)).status).toBe(404);
    expect((await postWithKey(B.t.client, `/orders/${aOrder}/payments`, { method: 'cash', amountMinor: 100 }, key())).status).toBe(404);
    expect((await B.t.client.post(`/orders/${aOrder}/cancel`, { reason: 'hostile cancel' })).status).toBe(404);
    expect((await B.t.client.get('/orders')).body.items).toHaveLength(0);
    // B cannot attach A's customer/service/branch
    expect((await postWithKey(B.t.client, '/orders', { branchId: B.t.branchId, customerId: A.customer, lines: [{ serviceId: B.shirt, quantity: 1 }] }, key())).status).toBe(404);
    expect((await postWithKey(B.t.client, '/orders', { branchId: B.t.branchId, customerId: B.customer, lines: [{ serviceId: A.shirt, quantity: 1 }] }, key())).status).toBe(404);
    expect((await postWithKey(B.t.client, '/orders', { branchId: A.t.branchId, customerId: B.customer, lines: [{ serviceId: B.shirt, quantity: 1 }] }, key())).status).toBe(404);
    // the same idempotency key in two tenants is independent
    const k = key();
    const x = await postWithKey(A.t.client, '/orders', { branchId: A.t.branchId, customerId: A.customer, lines: [{ serviceId: A.shirt, quantity: 1 }] }, k);
    const y = await postWithKey(B.t.client, '/orders', { branchId: B.t.branchId, customerId: B.customer, lines: [{ serviceId: B.shirt, quantity: 1 }] }, k);
    expect(x.body.id).not.toBe(y.body.id); expect(y.body.replayed).toBe(false);
    await app.close();
  });
});
