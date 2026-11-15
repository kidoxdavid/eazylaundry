import 'reflect-metadata';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, OWNER_URL, addStaff, makeApp, registerTenant } from './helpers.js';

const key = () => `k-${randomUUID()}`;
const jar = (c: Client) => Object.entries(c.cookies).map(([a, b]) => `${a}=${b}`).join('; ');
async function createOrder(c: Client, body: unknown) {
  return supertest(c.app.getHttpServer()).post('/orders').set('Cookie', jar(c)).set('x-csrf-token', c.cookies.eazy_csrf).set('Idempotency-Key', key()).send(body as object);
}
async function payFull(c: Client, orderId: string, amountMinor: number) {
  return supertest(c.app.getHttpServer()).post(`/orders/${orderId}/payments`).set('Cookie', jar(c)).set('x-csrf-token', c.cookies.eazy_csrf).set('Idempotency-Key', key()).send({ method: 'cash', amountMinor });
}

async function shop(app: any) {
  const t = await registerTenant(app);
  await t.client.put('/config/cash.require_shift', { scope: 'tenant', value: false }); // till enforcement is tested in cash.test.ts
  const shirt = (await t.client.post('/services', { code: 'SH', name: 'Shirt', pricingModel: 'per_item', turnaroundHours: 24, price: { unitPriceMinor: 1000 } })).body.id;
  const customer = (await t.client.post('/customers', { fullName: 'Ada Lovelace', phone: '7805550101' })).body.id;
  const newOrder = async (over: any = {}) => (await createOrder(t.client, { branchId: t.branchId, customerId: customer, lines: [{ serviceId: shirt, quantity: 1 }], ...over })).body;
  return { t, shirt, customer, newOrder };
}
const adv = (c: Client, id: string, from: string, to?: string) => c.post(`/orders/${id}/advance`, { fromStageKey: from, ...(to ? { toStageKey: to } : {}) });

describe('production workflow', () => {
  let app: Awaited<ReturnType<typeof makeApp>>;
  let s: Awaited<ReturnType<typeof shop>>;
  let cashier: Awaited<ReturnType<typeof addStaff>>, tech: Awaited<ReturnType<typeof addStaff>>, inspector: Awaited<ReturnType<typeof addStaff>>;
  beforeAll(async () => {
    app = await makeApp(); s = await shop(app);
    cashier = await addStaff(s.t.client, 'cashier'); tech = await addStaff(s.t.client, 'production_tech'); inspector = await addStaff(s.t.client, 'qc_inspector');
  });
  afterAll(async () => { await app.close(); });

  /** Advance an order, using the right role at each step, until it is AT `target` (or at quality control when no stage matches). */
  async function walkTo(id: string, target: string) {
    const path: [string, Client, string?][] = [['received', cashier.client], ['intake', cashier.client], ['sorting', tech.client], ['washing', tech.client],
      ['drying', tech.client, 'folding'], ['folding', tech.client]];
    for (const [from, who, to] of path) {
      if (from === target) return;
      expect((await adv(who, id, from, to)).status, `advance from ${from}`).toBe(200);
    }
  }

  it('seeds a default 11-stage workflow as data, with suggested rework stages per failure reason', async () => {
    const r = (await s.t.client.get('/workflow')).body;
    expect(r.stages.map((x: any) => x.key)).toEqual(['received', 'intake', 'sorting', 'washing', 'drying', 'ironing', 'folding', 'quality_control', 'packaging', 'ready', 'handed_over']);
    expect(r.stages.find((x: any) => x.key === 'ironing').optional).toBe(true);
    expect(r.reasonCodes.find((x: any) => x.code === 'stain_remains').defaultStageKey).toBe('washing');
    expect(r.reasonCodes.find((x: any) => x.code === 'damage').defaultStageKey).toBeNull();
  });

  it('new orders start at "received" with a printable scan token and a stage tracker', async () => {
    const o = await s.newOrder();
    const p = (await s.t.client.get(`/orders/${o.id}/production`)).body;
    expect(p.scanToken).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(p).toMatchObject({ stageKey: 'received', stageName: 'Order received', reworkCount: 0 });
    expect(p.stages[0].state).toBe('current'); expect(p.stages.slice(1).every((x: any) => x.state === 'todo')).toBe(true);
    expect(p.action).toMatchObject({ kind: 'advance', toStageKey: 'intake', allowed: true });
  });

  it('scanning a label or typing the order number opens the order; anything else is a uniform 404', async () => {
    const o = await s.newOrder();
    const token = (await s.t.client.get(`/orders/${o.id}/production`)).body.scanToken as string;
    expect((await tech.client.get(`/scan/${token}`)).body.id).toBe(o.id);
    expect((await tech.client.get(`/scan/${token.toLowerCase()}`)).body.id).toBe(o.id);
    expect((await tech.client.get(`/scan/${o.orderNo}`)).body.id).toBe(o.id);
    const miss = await tech.client.get('/scan/ZZZZZZZZZZ'); const junk = await tech.client.get("/scan/'; DROP TABLE orders;--");
    expect(miss.status).toBe(404); expect(junk.status).toBe(404); expect(miss.body.code).toBe(junk.body.code);
    // the technician sees what THEY can do (received needs order.create, which they lack)
    const card = (await tech.client.get(`/scan/${token}`)).body;
    expect(card.action).toMatchObject({ allowed: false, blockedReason: 'You do not have permission for this step' });
  });

  it('each stage can only be completed by someone holding that stage\'s permission', async () => {
    const o = await s.newOrder();
    expect((await adv(tech.client, o.id, 'received')).status).toBe(403);
    expect((await adv(cashier.client, o.id, 'received')).status).toBe(200); // -> intake
    expect((await adv(cashier.client, o.id, 'intake')).status).toBe(200); // -> sorting
    expect((await adv(cashier.client, o.id, 'sorting')).body.code).toBe('PERMISSION_DENIED'); // counter staff do not run machines
    expect((await adv(tech.client, o.id, 'sorting')).status).toBe(200);
  });

  it('rejects stale or racing moves: wrong fromStage, invalid targets, and simultaneous double scans', async () => {
    const o = await s.newOrder();
    const stale = await adv(cashier.client, o.id, 'sorting');
    expect(stale.status).toBe(409); expect(stale.body.code).toBe('STAGE_CHANGED');
    expect((await adv(cashier.client, o.id, 'received', 'washing')).body.code).toBe('INVALID_TRANSITION'); // cannot jump
    expect((await adv(cashier.client, o.id, 'received', 'nonsense')).body.code).toBe('INVALID_TRANSITION');
    const race = await Promise.all([adv(cashier.client, o.id, 'received'), adv(cashier.client, o.id, 'received'), adv(s.t.client, o.id, 'received')]);
    expect(race.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect((await s.t.client.get(`/orders/${o.id}/production`)).body.stageKey).toBe('intake'); // moved exactly one step
  });

  it('only optional stages can be skipped (ironing), recorded in history', async () => {
    const o = await s.newOrder();
    await walkTo(o.id, 'drying');
    expect((await adv(tech.client, o.id, 'drying', 'quality_control')).body.code).toBe('INVALID_TRANSITION');
    expect((await adv(tech.client, o.id, 'drying', 'folding')).status).toBe(200);
    const ev = (await s.t.client.get(`/orders/${o.id}`)).body.events.filter((e: any) => e.type === 'stage.changed').pop();
    expect(ev.payload).toMatchObject({ from: 'drying', to: 'folding', skipped: ['ironing'] });
  });

  it('quality control: only inspectors, pass moves on, plain advance is refused', async () => {
    const o = await s.newOrder();
    expect((await inspector.client.post(`/orders/${o.id}/qc`, { result: 'pass' })).body.code).toBe('NOT_AT_QC');
    await walkTo(o.id, 'quality_control');
    expect((await adv(tech.client, o.id, 'quality_control')).body.code).toBe('USE_QUALITY_INSPECTION');
    expect((await tech.client.post(`/orders/${o.id}/qc`, { result: 'pass' })).status).toBe(403);
    const card = (await tech.client.get(`/orders/${o.id}/production`)).body;
    expect(card.action).toMatchObject({ kind: 'qc', allowed: false });
    const ok = await inspector.client.post(`/orders/${o.id}/qc`, { result: 'pass', note: 'Looks great' });
    expect(ok.body).toMatchObject({ result: 'pass', stage: { key: 'packaging' } });
    const types = (await s.t.client.get(`/orders/${o.id}`)).body.events.map((e: any) => e.type);
    expect(types).toContain('qc.passed');
  });

  it('quality failure: records the reason, sends the order back to an earlier stage, counts the rework, and the order can still finish', async () => {
    const o = await s.newOrder();
    await walkTo(o.id, 'quality_control');
    expect((await inspector.client.post(`/orders/${o.id}/qc`, { result: 'fail', reasonCode: 'stain_remains' })).status).toBe(400); // rework stage required
    for (const bad of ['quality_control', 'packaging', 'received', 'nope']) {
      expect((await inspector.client.post(`/orders/${o.id}/qc`, { result: 'fail', reasonCode: 'wrinkles', reworkStageKey: bad })).body.code, bad).toBe('INVALID_REWORK_STAGE');
    }
    const fail = await inspector.client.post(`/orders/${o.id}/qc`, { result: 'fail', reasonCode: 'stain_remains', reworkStageKey: 'washing', note: 'Coffee stain on cuff' });
    expect(fail.body).toMatchObject({ result: 'fail', stage: { key: 'washing' }, reworkCount: 1 });
    const detail = (await s.t.client.get(`/orders/${o.id}`)).body;
    expect(detail).toMatchObject({ stageKey: 'washing', reworkCount: 1, status: 'open' });
    const failed = detail.events.find((e: any) => e.type === 'qc.failed');
    expect(failed).toMatchObject({ note: 'Coffee stain on cuff', payload: { reasonCode: 'stain_remains', reworkStage: 'washing' } });
    expect(detail.events.filter((e: any) => e.type === 'stage.changed').pop().payload).toMatchObject({ from: 'quality_control', to: 'washing', rework: true });
    // second pass through production and QC
    for (const from of ['washing', 'drying']) expect((await adv(tech.client, o.id, from)).status).toBe(200);
    expect((await adv(tech.client, o.id, 'ironing', 'folding')).status).toBe(200);
    expect((await adv(tech.client, o.id, 'folding')).body.stage.key).toBe('quality_control');
    expect((await inspector.client.post(`/orders/${o.id}/qc`, { result: 'pass' })).status).toBe(200);
    expect((await s.t.client.get(`/orders/${o.id}/production`)).body.reworkCount).toBe(1);
    expect(((await s.t.client.get('/audit-logs?limit=200')).body.items as any[]).some((i) => i.action === 'order.qc_failed')).toBe(true);
  });

  it('ready/hand-over: ready status is set, unpaid orders cannot be handed over, paid ones complete', async () => {
    const o = await s.newOrder(); // 1000 + 5% = 1050
    await walkTo(o.id, 'quality_control');
    await inspector.client.post(`/orders/${o.id}/qc`, { result: 'pass' });
    expect((await adv(tech.client, o.id, 'packaging')).body).toMatchObject({ stage: { key: 'ready' }, status: 'ready' });
    expect((await s.t.client.get(`/orders/${o.id}`)).body.events.map((e: any) => e.type)).toContain('order.ready');
    expect((await tech.client.get(`/orders/${o.id}/production`)).body.action.allowed).toBe(false); // techs do not hand over
    const blocked = await adv(cashier.client, o.id, 'ready');
    expect(blocked.status).toBe(409); expect(blocked.body.code).toBe('BALANCE_DUE');
    expect((await cashier.client.get(`/orders/${o.id}/production`)).body.action).toMatchObject({ kind: 'handover', allowed: false, blockedReason: 'Collect payment before handing over' });
    expect((await payFull(cashier.client, o.id, 1050)).status).toBe(201);
    const done = await adv(cashier.client, o.id, 'ready');
    expect(done.body).toMatchObject({ stage: { key: 'handed_over' }, status: 'completed' });
    expect((await adv(cashier.client, o.id, 'handed_over')).body.code).toBe('ORDER_COMPLETE');
    expect(((await s.t.client.get('/audit-logs?limit=200')).body.items as any[]).some((i) => i.action === 'order.handed_over')).toBe(true);
  });

  it('cancelled orders cannot move through production', async () => {
    const o = await s.newOrder();
    await s.t.client.post(`/orders/${o.id}/cancel`, { reason: 'Customer called' });
    expect((await adv(cashier.client, o.id, 'received')).body.code).toBe('ORDER_CANCELLED');
    expect((await s.t.client.get(`/orders/${o.id}/production`)).body.action.allowed).toBe(false);
  });

  it('prints one label per bag, all carrying the same scan token', async () => {
    const o = await s.newOrder({ instructions: 'x' });
    const r = (await s.t.client.get(`/orders/${o.id}/labels?bags=3`)).body.labels as any[];
    expect(r.map((l) => `${l.bagIndex}/${l.bagCount}`)).toEqual(['1/3', '2/3', '3/3']);
    expect(new Set(r.map((l) => l.scanToken)).size).toBe(1);
    expect(r[0]).toMatchObject({ orderNo: o.orderNo, customerName: 'Ada Lovelace', branch: 'Main' });
    expect((await s.t.client.get(`/orders/${o.id}/labels?bags=0`)).status).toBe(400);
  });

  it('the production board counts reconcile with the cards, and flag overdue orders and slow stages', async () => {
    const T = await shop(app);
    const a = await T.newOrder(), b = await T.newOrder(), c = await T.newOrder();
    await adv(T.t.client, b.id, 'received');
    const pgc = new pg.Client({ connectionString: OWNER_URL }); await pgc.connect();
    try {
      await pgc.query(`SELECT set_config('app.tenant_id', $1, false), set_config('app.all_branches', 'true', false)`, [T.t.tenantId]);
      await pgc.query(`UPDATE orders SET promised_at = now() - interval '1 hour' WHERE id = $1`, [a.id]);
      await pgc.query(`UPDATE orders SET stage_entered_at = now() - interval '5 hours' WHERE id = $1`, [c.id]);
    } finally { await pgc.end(); }
    const board = (await T.t.client.get('/production/board')).body.stages as any[];
    const all = board.flatMap((s) => s.items);
    expect(board.reduce((n, s) => n + s.count, 0)).toBe(all.length);
    expect(all).toHaveLength(3);
    expect(board.find((s) => s.key === 'received').items.map((i: any) => i.id).sort()).toEqual([a.id, c.id].sort());
    expect(board.find((s) => s.key === 'intake').items[0].id).toBe(b.id);
    expect(all.find((i) => i.id === a.id).overdue).toBe(true);
    expect(all.find((i) => i.id === c.id)).toMatchObject({ stageOverdue: true, overdue: false });
    expect(all.find((i) => i.id === b.id)).toMatchObject({ stageOverdue: false, overdue: false });
  });

  it('first use of the workflow is race-safe: concurrent first orders create exactly one workflow', async () => {
    const T = await shop(app);
    const rs = await Promise.all(Array.from({ length: 4 }, () => createOrder(T.t.client, { branchId: T.t.branchId, customerId: T.customer, lines: [{ serviceId: T.shirt, quantity: 1 }] })));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    const wf = (await T.t.client.get('/workflow')).body.stages as any[];
    expect(wf).toHaveLength(11);
    const board = (await T.t.client.get('/production/board')).body.stages as any[];
    expect(board.reduce((n, x) => n + x.count, 0)).toBe(4);
  });
});

describe('production — branch and tenant isolation', () => {
  it('branch-limited staff only see, scan, move and label their own branch\'s orders; the board is filtered by the database', async () => {
    const app = await makeApp();
    const S = await shop(app);
    const north = (await S.t.client.post('/branches', { code: 'NORTH', name: 'North' })).body.id;
    const mainO = await S.newOrder(); const northO = await S.newOrder({ branchId: north });
    const scoped = await addStaff(S.t.client, 'cashier', { allBranches: false, branchIds: [north] });
    const tokenMain = (await S.t.client.get(`/orders/${mainO.id}/production`)).body.scanToken;
    expect((await scoped.client.get(`/scan/${tokenMain}`)).status).toBe(404);
    expect((await scoped.client.get(`/scan/${mainO.orderNo}`)).status).toBe(404);
    expect((await scoped.client.get(`/orders/${mainO.id}/production`)).status).toBe(404);
    expect((await scoped.client.get(`/orders/${mainO.id}/labels`)).status).toBe(404);
    expect((await adv(scoped.client, mainO.id, 'received')).status).toBe(404);
    expect((await adv(scoped.client, northO.id, 'received')).status).toBe(200);
    const board = (await scoped.client.get('/production/board')).body.stages as any[];
    expect(board.flatMap((s) => s.items).map((i) => i.id)).toEqual([northO.id]);
    await app.close();
  });

  it("another business cannot scan, advance, inspect, label or view a tenant's production data", async () => {
    const app = await makeApp();
    const A = await shop(app), B = await shop(app);
    const o = await A.newOrder();
    const token = (await A.t.client.get(`/orders/${o.id}/production`)).body.scanToken;
    expect((await B.t.client.get(`/scan/${token}`)).status).toBe(404);
    expect((await B.t.client.get(`/scan/${o.orderNo}`)).status).toBe(404);
    expect((await adv(B.t.client, o.id, 'received')).status).toBe(404);
    expect((await B.t.client.post(`/orders/${o.id}/qc`, { result: 'pass' })).status).toBe(404);
    expect((await B.t.client.get(`/orders/${o.id}/labels`)).status).toBe(404);
    expect((await B.t.client.get(`/orders/${o.id}/production`)).status).toBe(404);
    expect(((await B.t.client.get('/production/board')).body.stages as any[]).every((s) => s.count === 0)).toBe(true);
    // and A's data is untouched
    expect((await A.t.client.get(`/orders/${o.id}/production`)).body.stageKey).toBe('received');
    await app.close();
  });
});
