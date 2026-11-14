import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { OWNER_URL, addStaff, makeApp, registerTenant } from './helpers.js';

const wf = (over: any = {}) => ({ code: 'WF', name: 'Wash & Fold', pricingModel: 'per_kg', expressCapable: true, turnaroundHours: 48,
  price: { unitPriceMinor: 250, minChargeMinor: 1000, express: { type: 'percent', percent: 50 } }, ...over });

describe('catalogue & pricing API', () => {
  let app: Awaited<ReturnType<typeof makeApp>>;
  let T: Awaited<ReturnType<typeof registerTenant>>;
  let wfId: string;
  beforeAll(async () => {
    app = await makeApp(); T = await registerTenant(app);
    wfId = (await T.client.post('/services', wf())).body.id;
  });
  afterAll(async () => { await app.close(); });

  const quote = (client: any, body: any) => client.post('/pricing/quote', { branchId: T.branchId, ...body });

  it('creates services with a first price and lists current prices', async () => {
    const list = (await T.client.get('/services')).body.items as any[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ code: 'WF', pricingModel: 'per_kg', price: { unitPriceMinor: 250, minChargeMinor: 1000, express: { type: 'percent', percent: 50 } } });
    expect((await T.client.post('/services', wf())).status).toBe(409); // duplicate code
    expect((await T.client.post('/services', wf({ code: 'X', expressCapable: true, price: { unitPriceMinor: 100 } }))).status).toBe(400); // express w/o surcharge
    expect((await T.client.post('/services', wf({ code: 'bad code!' }))).status).toBe(400);
  });

  it('quotes a wash-and-fold order entirely on the server, with GST seeded for Alberta', async () => {
    const r = await quote(T.client, { lines: [{ serviceId: wfId, weightG: 6500 }] });
    expect(r.status).toBe(201);
    expect(r.body.currency).toBe('CAD');
    expect(r.body.lines[0]).toMatchObject({ baseMinor: 1625, unitPriceMinor: 250, minChargeApplied: false });
    expect(r.body).toMatchObject({ subtotalMinor: 1625, taxMinor: 81, totalMinor: 1706, taxByComponent: { GST: 81 }, priceMode: 'exclusive' });
    const min = await quote(T.client, { lines: [{ serviceId: wfId, weightG: 1000 }] });
    expect(min.body.lines[0]).toMatchObject({ baseMinor: 1000, minChargeApplied: true });
    const exp = await quote(T.client, { lines: [{ serviceId: wfId, weightG: 6500 }], express: true });
    expect(exp.body.lines[0].expressMinor).toBe(813); // 50% of 1625 = 812.5 -> 813
  });

  it('validates quote inputs', async () => {
    expect((await quote(T.client, { lines: [{ serviceId: wfId }] })).body.code).toBe('WEIGHT_REQUIRED');
    expect((await quote(T.client, { lines: [] })).status).toBe(400);
    expect((await quote(T.client, { lines: [{ serviceId: '00000000-0000-4000-8000-000000000000', quantity: 1 }] })).status).toBe(404);
    expect((await T.client.post('/pricing/quote', { branchId: '00000000-0000-4000-8000-000000000000', lines: [{ serviceId: wfId, weightG: 1000 }] })).status).toBe(404);
  });

  it('price changes append history and never alter earlier price versions', async () => {
    const before = (await T.client.get(`/services/${wfId}/prices`)).body.items;
    expect(before).toHaveLength(1);
    expect((await T.client.put(`/services/${wfId}/price`, { unitPriceMinor: 300, minChargeMinor: 1000, express: { type: 'percent', percent: 50 } })).status).toBe(200);
    const after = (await T.client.get(`/services/${wfId}/prices`)).body.items;
    expect(after.map((p: any) => p.unitPriceMinor)).toEqual([300, 250]);
    expect((await quote(T.client, { lines: [{ serviceId: wfId, weightG: 6500 }] })).body.lines[0].unitPriceMinor).toBe(300);
    // price rows are append-only at the database level
    const c = new pg.Client({ connectionString: OWNER_URL }); await c.connect();
    try {
      await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [T.tenantId]);
      await expect(c.query(`UPDATE service_prices SET unit_price_minor = 1`)).rejects.toMatchObject({ code: '23001' });
      await expect(c.query(`DELETE FROM service_prices`)).rejects.toMatchObject({ code: '23001' });
    } finally { await c.end(); }
  });

  it('branch-specific prices override the general price for that branch only', async () => {
    const north = (await T.client.post('/branches', { code: 'NORTH', name: 'North' })).body.id;
    await T.client.put(`/services/${wfId}/price`, { branchId: north, unitPriceMinor: 200, minChargeMinor: 0, express: { type: 'percent', percent: 25 } });
    const onNorth = await T.client.post('/pricing/quote', { branchId: north, lines: [{ serviceId: wfId, weightG: 1000 }] });
    expect(onNorth.body.lines[0].unitPriceMinor).toBe(200);
    const main = await quote(T.client, { lines: [{ serviceId: wfId, weightG: 1000 }] });
    expect(main.body.lines[0].unitPriceMinor).toBe(300);
    expect(((await T.client.get(`/services?branchId=${north}`)).body.items as any[])[0].price.unitPriceMinor).toBe(200);
  });

  it('honours the tenant price-mode setting (tax-inclusive) and order-level rounding', async () => {
    const fixed = (await T.client.post('/services', { code: 'BAG', name: 'Laundry bag', pricingModel: 'fixed', price: { unitPriceMinor: 1050 } })).body.id;
    await T.client.put('/config/tax.price_mode', { scope: 'tenant', value: 'inclusive' });
    const r = await quote(T.client, { lines: [{ serviceId: fixed, quantity: 1 }] });
    expect(r.body).toMatchObject({ totalMinor: 1050, netMinor: 1000, taxMinor: 50, priceMode: 'inclusive' });
    await T.client.put('/config/tax.price_mode', { scope: 'tenant', value: 'exclusive' });
    await T.client.put('/config/tax.rounding_level', { scope: 'tenant', value: 'order' });
    expect((await quote(T.client, { lines: [{ serviceId: fixed, quantity: 1 }] })).body.taxPolicy.roundingLevel).toBe('order');
  });

  it('tax rates are effective-dated: a future rate change does not affect today', async () => {
    const T2 = await registerTenant(app);
    const s = (await T2.client.post('/services', { code: 'FX', name: 'Fixed', pricingModel: 'fixed', price: { unitPriceMinor: 10000 } })).body.id;
    expect((await T2.client.post('/tax-rates', { code: 'GST', name: 'GST', rate: '0.07', effectiveFrom: '2099-01-01' })).status).toBe(201);
    const now = await T2.client.post('/pricing/quote', { branchId: T2.branchId, lines: [{ serviceId: s, quantity: 1 }] });
    expect(now.body.taxMinor).toBe(500);
    const rates = (await T2.client.get('/tax-rates')).body.items as any[];
    expect(rates.find((r) => r.rate === '0.050000').effectiveTo).toBe('2099-01-01');
    expect((await T2.client.post('/tax-rates', { code: 'GST', name: 'GST', rate: '0.09', effectiveFrom: '2099-01-01' })).status).toBe(409);
    // add PST today: both components apply
    await T2.client.post('/tax-rates', { code: 'PST', name: 'PST', rate: '0.06', effectiveFrom: '2000-01-01' });
    const both = await T2.client.post('/pricing/quote', { branchId: T2.branchId, lines: [{ serviceId: s, quantity: 1 }] });
    expect(both.body.taxByComponent).toEqual({ GST: 500, PST: 600 });
  });

  it('discounts need the permission and respect the approval limit', async () => {
    const cashier = await addStaff(T.client, 'cashier');
    const tech = await addStaff(T.client, 'dispatcher');
    expect((await tech.client.post('/pricing/quote', { branchId: T.branchId, lines: [{ serviceId: wfId, weightG: 1000 }] })).status).toBe(403); // no order.create
    const fixed = (await T.client.post('/services', { code: 'DISC', name: 'Disc test', pricingModel: 'fixed', price: { unitPriceMinor: 10000 } })).body.id;
    const ok = await cashier.client.post('/pricing/quote', { branchId: T.branchId, lines: [{ serviceId: fixed, quantity: 1 }], discount: { type: 'percent', percent: '10' } });
    expect(ok.status).toBe(201); expect(ok.body.discountMinor).toBe(1000);
    // limited role: discount up to $5.00
    const roles = (await T.client.get('/roles')).body.items as any[];
    const perms = roles.find((r) => r.key === 'cashier').permissions.map((p: any) => (p.code === 'discount.apply' ? { ...p, maxAmountMinor: 500 } : p));
    await T.client.post('/roles', { key: 'junior', name: 'Junior cashier', permissions: perms });
    const junior = await addStaff(T.client, 'junior');
    const over = await junior.client.post('/pricing/quote', { branchId: T.branchId, lines: [{ serviceId: fixed, quantity: 1 }], discount: { type: 'percent', percent: '10' } });
    expect(over.status).toBe(403); expect(over.body.code).toBe('DISCOUNT_LIMIT_EXCEEDED');
    expect((await junior.client.post('/pricing/quote', { branchId: T.branchId, lines: [{ serviceId: fixed, quantity: 1 }], discount: { type: 'fixed', amountMinor: 500 } })).status).toBe(201);
  });

  it('only catalogue managers can change services and prices; others can read', async () => {
    const cashier = await addStaff(T.client, 'cashier');
    expect((await cashier.client.get('/services')).status).toBe(200);
    expect((await cashier.client.post('/services', wf({ code: 'HACK' }))).status).toBe(403);
    expect((await cashier.client.put(`/services/${wfId}/price`, { unitPriceMinor: 1, minChargeMinor: 0, express: { type: 'none' } })).status).toBe(403);
    expect((await cashier.client.post('/tax-rates', { code: 'ZZ', name: 'x', rate: '0.01', effectiveFrom: '2030-01-01' })).status).toBe(403);
  });

  it('branch-scoped managers cannot change prices for all branches or other branches', async () => {
    const north = (await T.client.post('/branches', { code: 'WEST', name: 'West' })).body.id;
    const scoped = await addStaff(T.client, 'owner', { allBranches: false, branchIds: [north] });
    expect((await scoped.client.put(`/services/${wfId}/price`, { unitPriceMinor: 1, minChargeMinor: 0, express: { type: 'percent', percent: 1 } })).status).toBe(403);
    expect((await scoped.client.put(`/services/${wfId}/price`, { branchId: T.branchId, unitPriceMinor: 1, minChargeMinor: 0, express: { type: 'percent', percent: 1 } })).status).toBe(404);
    expect((await scoped.client.put(`/services/${wfId}/price`, { branchId: north, unitPriceMinor: 210, minChargeMinor: 0, express: { type: 'percent', percent: 1 } })).status).toBe(200);
  });

  it('archiving removes a service from the list and from quotes, with optimistic concurrency', async () => {
    const id = (await T.client.post('/services', { code: 'OLD', name: 'Old service', pricingModel: 'fixed', price: { unitPriceMinor: 500 } })).body.id;
    const cur = (await T.client.get('/services')).body.items.find((s: any) => s.id === id);
    expect((await T.client.patch(`/services/${id}`, { version: cur.version, name: 'Renamed' })).body.version).toBe(cur.version + 1);
    expect((await T.client.patch(`/services/${id}`, { version: cur.version, name: 'Stale' })).status).toBe(409);
    expect((await T.client.patch(`/services/${id}`, { version: cur.version + 1, archived: true })).status).toBe(200);
    expect(((await T.client.get('/services')).body.items as any[]).some((s) => s.id === id)).toBe(false);
    expect((await quote(T.client, { lines: [{ serviceId: id, quantity: 1 }] })).status).toBe(404);
  });
});

describe('catalogue — tenant isolation', () => {
  it("another business cannot see, price, change or quote a tenant's services", async () => {
    const app = await makeApp();
    const A = await registerTenant(app), B = await registerTenant(app);
    const sid = (await A.client.post('/services', { code: 'SECRET', name: 'Secret service', pricingModel: 'fixed', price: { unitPriceMinor: 999 } })).body.id;
    expect(JSON.stringify((await B.client.get('/services')).body)).not.toContain('SECRET');
    expect((await B.client.put(`/services/${sid}/price`, { unitPriceMinor: 1, minChargeMinor: 0, express: { type: 'none' } })).status).toBe(404);
    expect((await B.client.patch(`/services/${sid}`, { version: 1, name: 'pwned' })).status).toBe(404);
    expect((await B.client.get(`/services/${sid}/prices`)).status).toBe(404);
    expect((await B.client.post('/pricing/quote', { branchId: B.branchId, lines: [{ serviceId: sid, quantity: 1 }] })).status).toBe(404);
    expect((await B.client.post('/pricing/quote', { branchId: A.branchId, lines: [{ serviceId: sid, quantity: 1 }] })).status).toBe(404);
    expect(JSON.stringify((await B.client.get('/tax-rates')).body)).not.toContain(A.tenantId);
    // each tenant has its own seeded GST
    expect(((await B.client.get('/tax-rates')).body.items as any[])).toHaveLength(1);
    await app.close();
  });
});
