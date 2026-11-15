import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { OWNER_URL, addStaff, makeApp, postKey, registerTenant } from './helpers.js';

type App = Awaited<ReturnType<typeof makeApp>>;
const local = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Edmonton' });
const range = `from=${local(-1)}&to=${local(1)}`;

async function shop(app: App) {
  const t = await registerTenant(app);
  const shirt = (await t.client.post('/services', { code: 'SH', name: 'Shirt', pricingModel: 'per_item', price: { unitPriceMinor: 1000 } })).body.id;
  const customer = (await t.client.post('/customers', { fullName: 'Ada Lovelace', phone: '7805550101' })).body.id;
  const order = async () => (await postKey(t.client, '/orders', { branchId: t.branchId, customerId: customer, lines: [{ serviceId: shirt, quantity: 1 }] })).body; // 1000 + 50 GST
  const pay = (id: string, method: string, amountMinor: number) => postKey(t.client, `/orders/${id}/payments`, { method, amountMinor });
  return { t, shirt, customer, order, pay };
}

describe('reports', () => {
  let app: App; let s: Awaited<ReturnType<typeof shop>>;
  beforeAll(async () => {
    app = await makeApp(); s = await shop(app);
    const a = await s.order(); await s.pay(a.id, 'card_external', 1050);                 // paid in full by card
    const b = await s.order(); await s.pay(b.id, 'e_transfer', 500);                      // part-paid → 550 owed
    const c = await s.order(); await s.t.client.post(`/orders/${c.id}/cancel`, { reason: 'Customer changed mind' }); // cancelled: never counted
    const paymentId = (await s.t.client.get(`/orders/${a.id}`)).body.payments[0].id;
    const rq = await s.t.client.post(`/orders/${a.id}/refund-requests`, { paymentId, amountMinor: 200, reason: 'Small stain remained' });
    expect((await s.t.client.post(`/refund-requests/${rq.body.id}/complete`, {})).status).toBeLessThan(300);
  });
  afterAll(async () => { await app.close(); });

  it('sales: billed totals exclude cancelled orders and match an independent SQL calculation; services and sources are summarised', async () => {
    const r = (await s.t.client.get(`/reports/sales?${range}`)).body;
    expect(r.totals).toMatchObject({ orders: 2, netMinor: 2000, taxMinor: 100, totalMinor: 2100, averageOrderMinor: 1050 });
    // Independent oracle straight from the table (FORCE RLS: the owner connection needs a tenant context too).
    const c = new pg.Client({ connectionString: OWNER_URL }); await c.connect();
    await c.query(`SELECT set_config('app.tenant_id', $1, false), set_config('app.all_branches', 'true', false)`, [s.t.tenantId]);
    const o = (await c.query(`SELECT sum(total_minor)::int AS t, count(*)::int AS n FROM orders WHERE status <> 'cancelled'`)).rows[0]; await c.end();
    expect([r.totals.totalMinor, r.totals.orders]).toEqual([o.t, o.n]);
    expect(r.daily).toHaveLength(1); expect(r.daily[0]).toMatchObject({ orders: 2, totalMinor: 2100 });
    expect(r.topServices[0]).toMatchObject({ code: 'SH', name: 'Shirt', orders: 2, netMinor: 2000, quantity: 2 });
    expect(r.bySource).toEqual([{ source: 'pos', orders: 2, totalMinor: 2100 }]);
  });

  it('collections: money moved by method, with refunds netted, kept separate from billed sales', async () => {
    const r = (await s.t.client.get(`/reports/collections?${range}`)).body;
    expect(r.totals).toEqual({ collectedMinor: 1550, refundedMinor: 200, netMinor: 1350 });
    expect(r.byMethod).toEqual([{ method: 'card_external', collectedMinor: 1050, refundedMinor: 200, netMinor: 850 }, { method: 'e_transfer', collectedMinor: 500, refundedMinor: 0, netMinor: 500 }]);
    expect(r.daily).toHaveLength(1);
  });

  it('receivables: only live orders with a balance, aged, and the refund does not create a receivable', async () => {
    const r = (await s.t.client.get('/reports/receivables')).body;
    expect(r.totals).toEqual({ orders: 1, owedMinor: 550 });
    expect(r.buckets[0]).toEqual({ bucket: '0-7', orders: 1, owedMinor: 550 });
    expect(r.top[0]).toMatchObject({ owedMinor: 550, customerName: 'Ada Lovelace', ageDays: 0 });
  });

  it('operations: live counts, overdue and quality figures', async () => {
    const r = (await s.t.client.get(`/reports/operations?${range}`)).body;
    expect(r.live).toEqual({ open: 2, ready: 0, overdue: 0 });
    expect(r.quality).toMatchObject({ inspections: 0, failed: 0, failPercent: null });
    expect(r.completed).toMatchObject({ orders: 0, averageHoursToHandover: null, onTimePercent: null });
  });

  it('dates outside the range are not counted; bad ranges and unknown branches are rejected', async () => {
    const past = (await s.t.client.get(`/reports/sales?from=${local(-30)}&to=${local(-20)}`)).body;
    expect(past.totals).toMatchObject({ orders: 0, totalMinor: 0 });
    expect((await s.t.client.get(`/reports/sales?from=${local(1)}&to=${local(-1)}`)).status).toBe(400);
    expect((await s.t.client.get(`/reports/sales?from=2020-01-01&to=2022-01-01`)).status).toBe(400);
    expect((await s.t.client.get(`/reports/sales?${range}&branchId=00000000-0000-4000-8000-000000000000`)).status).toBe(404);
  });

  it('permissions: financial reports need finance.read; counter staff see neither; branch-limited staff only their own branch', async () => {
    const cashier = await addStaff(s.t.client, 'cashier');
    for (const p of ['sales', 'collections', 'operations']) expect((await cashier.client.get(`/reports/${p}?${range}`)).status).toBe(403);
    expect((await cashier.client.get('/reports/receivables')).status).toBe(403);
    const manager = await addStaff(s.t.client, 'branch_manager');
    expect((await manager.client.get(`/reports/sales?${range}`)).status).toBe(200);
    expect((await manager.client.get(`/reports/collections?${range}`)).status).toBe(403);
    const second = (await s.t.client.post('/branches', { code: 'TWO', name: 'Second' })).body.id;
    const limited = await addStaff(s.t.client, 'branch_manager', { allBranches: false, branchIds: [second] });
    expect((await limited.client.get(`/reports/sales?${range}`)).body.totals).toMatchObject({ orders: 0, totalMinor: 0 });
    expect((await limited.client.get(`/reports/operations?${range}`)).body.live).toEqual({ open: 0, ready: 0, overdue: 0 });
  });

  it("another business's figures never appear", async () => {
    const other = await registerTenant(app);
    expect((await other.client.get(`/reports/sales?${range}`)).body.totals).toMatchObject({ orders: 0, totalMinor: 0 });
    expect((await other.client.get(`/reports/collections?${range}`)).body.totals).toEqual({ collectedMinor: 0, refundedMinor: 0, netMinor: 0 });
    expect((await other.client.get('/reports/receivables')).body.totals).toEqual({ orders: 0, owedMinor: 0 });
  });
});

