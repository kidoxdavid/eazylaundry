import 'reflect-metadata';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, OWNER_URL, addStaff, makeApp, postKey, registerTenant } from './helpers.js';

async function shop(app: any) {
  const t = await registerTenant(app); // cash.require_shift defaults to TRUE here
  const shirt = (await t.client.post('/services', { code: 'SH', name: 'Shirt', pricingModel: 'per_item', price: { unitPriceMinor: 1000 } })).body.id;
  const customer = (await t.client.post('/customers', { fullName: 'Ada Lovelace', phone: '7805550101' })).body.id;
  const order = async (c: Client = t.client, branchId = t.branchId) => (await postKey(c, '/orders', { branchId, customerId: customer, lines: [{ serviceId: shirt, quantity: 1 }] })).body; // 1050
  return { t, shirt, customer, order };
}
const pay = (c: Client, id: string, body: any) => postKey(c, `/orders/${id}/payments`, body);
const openTill = (c: Client, branchId: string, float = 10000) => c.post('/cash-shifts', { branchId, openingFloatMinor: float });

describe('cash shifts (tills)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>; let s: Awaited<ReturnType<typeof shop>>;
  let cashier: Awaited<ReturnType<typeof addStaff>>, cashier2: Awaited<ReturnType<typeof addStaff>>, manager: Awaited<ReturnType<typeof addStaff>>;
  beforeAll(async () => {
    app = await makeApp(); s = await shop(app);
    cashier = await addStaff(s.t.client, 'cashier'); cashier2 = await addStaff(s.t.client, 'cashier'); manager = await addStaff(s.t.client, 'branch_manager');
  });
  afterAll(async () => { await app.close(); });
  const current = async (c: Client) => (await c.get(`/cash-shifts/current?branchId=${s.t.branchId}`)).body.shift;

  it('cash needs an open till by default; card and e-transfer do not', async () => {
    const o = await s.order();
    const blocked = await pay(cashier.client, o.id, { method: 'cash', amountMinor: 1050 });
    expect(blocked.status).toBe(409); expect(blocked.body.code).toBe('SHIFT_REQUIRED');
    expect((await pay(cashier.client, o.id, { method: 'card_external', amountMinor: 50 })).status).toBe(201);
  });

  it('opens a till, records cash into it, and hides the expected total from the person counting (blind count)', async () => {
    const r = await openTill(cashier.client, s.t.branchId, 10000);
    expect(r.status).toBe(201);
    expect((await openTill(cashier.client, s.t.branchId)).body.code).toBe('SHIFT_ALREADY_OPEN');
    const o = await s.order();
    const p = await pay(cashier.client, o.id, { method: 'cash', amountMinor: 1050, tenderedMinor: 2000 });
    expect(p.body).toMatchObject({ changeMinor: 950, balanceMinor: 0 });
    const mine = await current(cashier.client);
    expect(mine).toMatchObject({ openingFloatMinor: 10000, cashSalesMinor: 1050, cashPaymentCount: 1, expectedCashMinor: null, status: 'open' });
    const mgr = (await manager.client.get(`/cash-shifts/${r.body.id}`)).body;
    expect(mgr.expectedCashMinor).toBe(11050); // 100.00 float + 10.50 sale (change given does not count)
  });

  it('tills are personal: two people can run tills, nobody else can see or close mine, supervisors can', async () => {
    expect((await openTill(cashier2.client, s.t.branchId, 5000)).status).toBe(201);
    const mineId = (await current(cashier.client)).id;
    expect((await cashier2.client.get(`/cash-shifts/${mineId}`)).status).toBe(404);
    expect((await cashier2.client.post(`/cash-shifts/${mineId}/close`, { countedCashMinor: 1 })).status).toBe(404);
    expect((await cashier2.client.post(`/cash-shifts/${mineId}/movements`, { type: 'pay_in', amountMinor: 100, reason: 'sneaky' })).status).toBe(404);
    const own = (await cashier2.client.get('/cash-shifts')).body.items as any[];
    expect(own).toHaveLength(1); expect(own[0].id).not.toBe(mineId); // sees only their own till
    expect(((await manager.client.get('/cash-shifts')).body.items as any[]).length).toBeGreaterThanOrEqual(2);
  });

  it('records pay-ins and pay-outs with a reason, only by the till owner, and they feed the expected total', async () => {
    const id = (await current(cashier.client)).id;
    expect((await cashier.client.post(`/cash-shifts/${id}/movements`, { type: 'pay_out', amountMinor: 500, reason: 'ab' })).status).toBe(400);
    expect((await cashier.client.post(`/cash-shifts/${id}/movements`, { type: 'pay_out', amountMinor: 500, reason: 'Bought hangers' })).status).toBe(201);
    expect((await cashier.client.post(`/cash-shifts/${id}/movements`, { type: 'pay_in', amountMinor: 2000, reason: 'Float top-up' })).status).toBe(201);
    expect((await manager.client.post(`/cash-shifts/${id}/movements`, { type: 'pay_in', amountMinor: 100, reason: 'Manager adds' })).body.code).toBe('NOT_YOUR_TILL');
    const d = (await manager.client.get(`/cash-shifts/${id}`)).body;
    expect(d).toMatchObject({ payInMinor: 2000, payOutMinor: 500, expectedCashMinor: 10000 + 1050 + 2000 - 500 });
    expect(d.movements.map((m: any) => m.reason)).toEqual(['Bought hangers', 'Float top-up']);
  });

  it('closing needs the physical count; any variance must be explained; the result is permanent', async () => {
    const id = (await current(cashier.client)).id; // expected 12550
    const bad = await cashier.client.post(`/cash-shifts/${id}/close`, { countedCashMinor: 12500 });
    expect(bad.status).toBe(422); expect(bad.body.code).toBe('VARIANCE_NOTE_REQUIRED');
    const ok = await cashier.client.post(`/cash-shifts/${id}/close`, { countedCashMinor: 12500, note: 'Short $0.50, gave wrong change' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'closed', expectedCashMinor: 12550, countedCashMinor: 12500, varianceMinor: -50, closeNote: 'Short $0.50, gave wrong change' });
    expect((await cashier.client.post(`/cash-shifts/${id}/close`, { countedCashMinor: 12550 })).body.code).toBe('SHIFT_CLOSED');
    expect((await cashier.client.post(`/cash-shifts/${id}/movements`, { type: 'pay_in', amountMinor: 100, reason: 'too late' })).body.code).toBe('SHIFT_CLOSED');
    expect(await current(cashier.client)).toBeNull();
    const o = await s.order();
    expect((await pay(cashier.client, o.id, { method: 'cash', amountMinor: 1050 })).body.code).toBe('SHIFT_REQUIRED'); // closed till takes no more cash
    const audit = ((await s.t.client.get('/audit-logs?limit=200')).body.items as any[]).find((i) => i.action === 'cash_shift.closed');
    expect(audit.detail).toMatchObject({ varianceMinor: -50, expectedCashMinor: 12550 });
    // the database rejects an internally inconsistent closed shift
    const c = new pg.Client({ connectionString: OWNER_URL }); await c.connect();
    try {
      await c.query(`SELECT set_config('app.tenant_id', $1, false), set_config('app.all_branches', 'true', false)`, [s.t.tenantId]);
      await expect(c.query(`UPDATE cash_shifts SET variance_minor = 0 WHERE id = $1`, [id])).rejects.toMatchObject({ code: '23514' });
    } finally { await c.end(); }
  });

  it('a perfect count closes without a note, and a supervisor can close someone else\'s till', async () => {
    const id = (await current(cashier2.client)).id; // float 5000, no sales
    const r = await manager.client.post(`/cash-shifts/${id}/close`, { countedCashMinor: 5000 });
    expect(r.body).toMatchObject({ varianceMinor: 0, status: 'closed' });
    const a = ((await s.t.client.get('/audit-logs?limit=200')).body.items as any[]).filter((i) => i.action === 'cash_shift.closed');
    expect(a.some((x) => x.detail.closedByOpener === false)).toBe(true);
  });

  it('simultaneous attempts to open a till create exactly one', async () => {
    const c3 = await addStaff(s.t.client, 'cashier');
    const rs = await Promise.all([openTill(c3.client, s.t.branchId), openTill(c3.client, s.t.branchId), openTill(c3.client, s.t.branchId)]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409, 409]);
  });

  it('the till requirement is a business setting', async () => {
    const T = await shop(app);
    const o = await T.order();
    expect((await pay(T.t.client, o.id, { method: 'cash', amountMinor: 100 })).status).toBe(409);
    await T.t.client.put('/config/cash.require_shift', { scope: 'tenant', value: false });
    expect((await pay(T.t.client, o.id, { method: 'cash', amountMinor: 100 })).status).toBe(201);
  });

  it('tills are branch- and tenant-isolated', async () => {
    const T = await shop(app); const B = await shop(app);
    const north = (await T.t.client.post('/branches', { code: 'NORTH', name: 'North' })).body.id;
    const scoped = await addStaff(T.t.client, 'cashier', { allBranches: false, branchIds: [north] });
    expect((await openTill(scoped.client, T.t.branchId)).status).toBe(404);
    const mine = await openTill(scoped.client, north);
    expect(mine.status).toBe(201);
    const mgr = await addStaff(T.t.client, 'branch_manager', { allBranches: false, branchIds: [T.t.branchId] });
    expect((await mgr.client.get(`/cash-shifts/${mine.body.id}`)).status).toBe(404); // other branch
    expect((await B.t.client.get(`/cash-shifts/${mine.body.id}`)).status).toBe(404);
    expect((await B.t.client.post(`/cash-shifts/${mine.body.id}/close`, { countedCashMinor: 0 })).status).toBe(404);
    expect(((await B.t.client.get('/cash-shifts')).body.items as any[])).toHaveLength(0);
    expect((await openTill(B.t.client, north)).status).toBe(404);
  });
});

describe('refunds', () => {
  let app: Awaited<ReturnType<typeof makeApp>>; let s: Awaited<ReturnType<typeof shop>>;
  let cashier: Awaited<ReturnType<typeof addStaff>>, manager: Awaited<ReturnType<typeof addStaff>>, junior: Awaited<ReturnType<typeof addStaff>>;
  beforeAll(async () => {
    app = await makeApp(); s = await shop(app);
    cashier = await addStaff(s.t.client, 'cashier'); manager = await addStaff(s.t.client, 'branch_manager');
    const mgrPerms = ((await s.t.client.get('/roles')).body.items as any[]).find((r) => r.key === 'branch_manager').permissions
      .map((p: any) => (p.code === 'payment.refund.approve' ? { ...p, maxAmountMinor: 500 } : p));
    await s.t.client.post('/roles', { key: 'junior_mgr', name: 'Junior manager', permissions: mgrPerms });
    junior = await addStaff(s.t.client, 'junior_mgr');
    await openTill(cashier.client, s.t.branchId, 10000);
  });
  afterAll(async () => { await app.close(); });

  /** Paid cash order; returns ids. */
  async function paidOrder(method: 'cash' | 'card_external' = 'cash') {
    const o = await s.order(); // 1050
    const r = await pay(cashier.client, o.id, { method, amountMinor: 1050 });
    expect(r.status).toBe(201);
    const detail = (await s.t.client.get(`/orders/${o.id}`)).body;
    return { id: o.id as string, orderNo: o.orderNo as string, paymentId: detail.payments[0].id as string };
  }
  const request = (c: Client, o: any, amountMinor: number, reason = 'Customer unhappy') => c.post(`/orders/${o.id}/refund-requests`, { paymentId: o.paymentId, amountMinor, reason });

  it('request → approve → complete: the full cycle reduces what the order has paid, refunds cash from the till, and leaves a permanent trail', async () => {
    const o = await paidOrder();
    const rq = await request(cashier.client, o, 1050);
    expect(rq.body.status).toBe('pending');
    expect((await cashier.client.post(`/refund-requests/${rq.body.id}/approve`, {})).status).toBe(403); // cashiers cannot approve
    expect((await cashier.client.post(`/refund-requests/${rq.body.id}/complete`, {})).body.code).toBe('NOT_APPROVED');
    const pending = (await manager.client.get('/refund-requests?status=pending')).body.items as any[];
    expect(pending.find((x) => x.id === rq.body.id)).toMatchObject({ orderNo: o.orderNo, amountMinor: 1050, method: 'cash', customerName: 'Ada Lovelace' });
    expect((await manager.client.post(`/refund-requests/${rq.body.id}/approve`, { note: 'OK' })).body.status).toBe('approved');
    const done = await cashier.client.post(`/refund-requests/${rq.body.id}/complete`, {});
    expect(done.body).toMatchObject({ status: 'completed', method: 'cash', amountMinor: 1050 });
    const d = (await s.t.client.get(`/orders/${o.id}`)).body;
    expect(d).toMatchObject({ paidMinor: 0, balanceMinor: 1050, paymentStatus: 'unpaid' });
    expect(d.payments[0]).toMatchObject({ refundedMinor: 1050, refundableMinor: 0 });
    expect(d.refunds).toHaveLength(1);
    expect(d.events.map((e: any) => e.type)).toEqual(expect.arrayContaining(['refund.requested', 'refund.completed']));
    expect((await cashier.client.post(`/refund-requests/${rq.body.id}/complete`, {})).body.code).toBe('ALREADY_COMPLETED');
    const audit = ((await s.t.client.get('/audit-logs?limit=200')).body.items as any[]).find((i) => i.action === 'refund.completed' && i.detail.refundId === done.body.refundId);
    expect(audit.detail).toMatchObject({ method: 'cash', amountMinor: 1050 });
    expect(audit.detail.approvedBy).toBeTruthy();
  });

  it('approval limits: an approver cannot approve more than their limit; a reason is required to reject', async () => {
    const o = await paidOrder();
    const rq = await request(cashier.client, o, 1000);
    const over = await junior.client.post(`/refund-requests/${rq.body.id}/approve`, {});
    expect(over.status).toBe(403); expect(over.body.code).toBe('REFUND_LIMIT_EXCEEDED');
    expect((await manager.client.post(`/refund-requests/${rq.body.id}/reject`, {})).status).toBe(400);
    expect((await manager.client.post(`/refund-requests/${rq.body.id}/reject`, { note: 'Not eligible' })).body.status).toBe('rejected');
    expect((await manager.client.post(`/refund-requests/${rq.body.id}/approve`, {})).body.code).toBe('NOT_PENDING');
    expect((await cashier.client.post(`/refund-requests/${rq.body.id}/complete`, {})).body.code).toBe('NOT_APPROVED');
    const small = await request(cashier.client, o, 400);
    expect((await junior.client.post(`/refund-requests/${small.body.id}/approve`, {})).body.status).toBe('approved'); // within limit
  });

  it('a refund can never exceed the original payment, counting completed refunds and other live requests', async () => {
    const o = await paidOrder();
    expect((await request(cashier.client, o, 1051)).body.code).toBe('REFUND_EXCEEDS_PAYMENT');
    const a = await request(cashier.client, o, 600);
    expect(a.status).toBe(201);
    expect((await request(cashier.client, o, 451)).body.code).toBe('REFUND_EXCEEDS_PAYMENT'); // 600 already requested
    expect((await request(cashier.client, o, 450)).status).toBe(201);
    // a payment that belongs to another order is not found
    const other = await paidOrder();
    expect((await cashier.client.post(`/orders/${o.id}/refund-requests`, { paymentId: other.paymentId, amountMinor: 100, reason: 'wrong payment' })).status).toBe(404);
  });

  it('three simultaneous attempts to pay out the same refund produce exactly one refund', async () => {
    const o = await paidOrder();
    const rq = await request(manager.client, o, 1050); // manager has unlimited approval -> auto-approved
    expect(rq.body.status).toBe('approved');
    await openTill(manager.client, s.t.branchId, 0);
    const rs = await Promise.all([1, 2, 3].map(() => manager.client.post(`/refund-requests/${rq.body.id}/complete`, {})));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    const d = (await s.t.client.get(`/orders/${o.id}`)).body;
    expect(d.refunds).toHaveLength(1); expect(d.paidMinor).toBe(0);
  });

  it('cash refunds need the payer\'s open till; card refunds do not; the method follows the original payment', async () => {
    const o = await paidOrder('card_external');
    const rq = await request(manager.client, o, 500);
    const noTill = await paidOrder('cash');
    const rq2 = await request(manager.client, noTill, 500);
    // owner has no till open: cash refund blocked, card refund fine
    const ownerClient = s.t.client;
    expect((await ownerClient.post(`/refund-requests/${rq2.body.id}/complete`, {})).body.code).toBe('SHIFT_REQUIRED');
    const card = await ownerClient.post(`/refund-requests/${rq.body.id}/complete`, {});
    expect(card.body).toMatchObject({ method: 'card_external', amountMinor: 500 });
    expect((await s.t.client.get(`/orders/${o.id}`)).body.payments[0]).toMatchObject({ refundedMinor: 500, refundableMinor: 550 });
  });

  it('the till reconciles: expected cash = float + cash sales − cash refunds + pay-ins − pay-outs (independent check)', async () => {
    const T = await shop(app);
    const c = await addStaff(T.t.client, 'cashier'); const m = await addStaff(T.t.client, 'branch_manager');
    const till = (await openTill(c.client, T.t.branchId, 20000)).body.id;
    const ids: any[] = [];
    for (let i = 0; i < 3; i++) { const o = await T.order(); await pay(c.client, o.id, { method: 'cash', amountMinor: 1050, tenderedMinor: 2000 }); ids.push((await T.t.client.get(`/orders/${o.id}`)).body); }
    const rq = await c.client.post(`/orders/${ids[0].id}/refund-requests`, { paymentId: ids[0].payments[0].id, amountMinor: 300, reason: 'Damaged item' });
    await m.client.post(`/refund-requests/${rq.body.id}/approve`, {});
    await c.client.post(`/refund-requests/${rq.body.id}/complete`, {});
    await c.client.post(`/cash-shifts/${till}/movements`, { type: 'pay_out', amountMinor: 700, reason: 'Courier tip' });
    const independent = 20000 + ids.reduce((n, o) => n + o.payments.filter((p: any) => p.method === 'cash').reduce((x: number, p: any) => x + p.amountMinor, 0), 0) - 300 - 700;
    expect(independent).toBe(20000 + 3150 - 300 - 700);
    const closed = await c.client.post(`/cash-shifts/${till}/close`, { countedCashMinor: independent });
    expect(closed.body).toMatchObject({ expectedCashMinor: independent, varianceMinor: 0, cashRefundsMinor: 300, cashSalesMinor: 3150 });
  });

  it('after a full refund the order can be cancelled', async () => {
    const o = await paidOrder();
    const before = await s.t.client.post(`/orders/${o.id}/cancel`, { reason: 'Customer withdrew' });
    expect(before.body.code).toBe('REFUND_REQUIRED');
    const rq = await request(manager.client, o, 1050);
    await openTill(manager.client, s.t.branchId, 0).catch(() => undefined);
    await manager.client.post(`/refund-requests/${rq.body.id}/complete`, {});
    expect((await s.t.client.post(`/orders/${o.id}/cancel`, { reason: 'Customer withdrew' })).body.status).toBe('cancelled');
  });

  it('refund requests are tenant- and branch-isolated; non-approvers only see their own', async () => {
    const T = await shop(app); const B = await shop(app);
    const north = (await T.t.client.post('/branches', { code: 'NORTH', name: 'North' })).body.id;
    const cT = await addStaff(T.t.client, 'cashier'); await T.t.client.put('/config/cash.require_shift', { scope: 'tenant', value: false });
    const o = await T.order(); await pay(cT.client, o.id, { method: 'cash', amountMinor: 1050 });
    const d = (await T.t.client.get(`/orders/${o.id}`)).body;
    const rq = await cT.client.post(`/orders/${o.id}/refund-requests`, { paymentId: d.payments[0].id, amountMinor: 100, reason: 'Late delivery' });
    expect((await B.t.client.post(`/refund-requests/${rq.body.id}/approve`, {})).status).toBe(404);
    expect((await B.t.client.post(`/refund-requests/${rq.body.id}/reject`, { note: 'hostile' })).status).toBe(404);
    expect((await B.t.client.post(`/refund-requests/${rq.body.id}/complete`, {})).status).toBe(404);
    expect((await B.t.client.post(`/orders/${o.id}/refund-requests`, { paymentId: d.payments[0].id, amountMinor: 100, reason: 'hostile' })).status).toBe(404);
    expect(((await B.t.client.get('/refund-requests')).body.items as any[])).toHaveLength(0);
    const northMgr = await addStaff(T.t.client, 'branch_manager', { allBranches: false, branchIds: [north] });
    expect(((await northMgr.client.get('/refund-requests')).body.items as any[])).toHaveLength(0); // main-branch request invisible
    expect((await northMgr.client.post(`/refund-requests/${rq.body.id}/approve`, {})).status).toBe(404);
    const other = await addStaff(T.t.client, 'cashier');
    expect(((await other.client.get('/refund-requests')).body.items as any[])).toHaveLength(0); // not their request
    expect(((await cT.client.get('/refund-requests')).body.items as any[])).toHaveLength(1);
  });

  it('refunds are append-only in the database and require a permission to request', async () => {
    const tech = await addStaff(s.t.client, 'production_tech');
    const o = await paidOrder();
    expect((await tech.client.post(`/orders/${o.id}/refund-requests`, { paymentId: o.paymentId, amountMinor: 100, reason: 'nope' })).status).toBe(403);
    const rq = await request(manager.client, o, 100); await openTill(manager.client, s.t.branchId, 0).catch(() => undefined);
    await manager.client.post(`/refund-requests/${rq.body.id}/complete`, {});
    const c = new pg.Client({ connectionString: OWNER_URL }); await c.connect();
    try {
      await c.query(`SELECT set_config('app.tenant_id', $1, false), set_config('app.all_branches', 'true', false)`, [s.t.tenantId]);
      await expect(c.query(`UPDATE refunds SET amount_minor = 1`)).rejects.toMatchObject({ code: '23001' });
      await expect(c.query(`DELETE FROM refunds`)).rejects.toMatchObject({ code: '23001' });
    } finally { await c.end(); }
  });
});
