import 'reflect-metadata';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, OWNER_URL, addStaff, makeApp, postKey, registerTenant } from './helpers.js';

const addr = { line1: '10 Jasper Ave', city: 'Edmonton', province: 'AB', postalCode: 'T5J 2R4' };
const win = (startH = 1, lenH = 2) => ({ start: new Date(Date.now() + startH * 3600_000).toISOString(), end: new Date(Date.now() + (startH + lenH) * 3600_000).toISOString() });

async function shop(app: any) {
  const t = await registerTenant(app);
  await t.client.put('/config/cash.require_shift', { scope: 'tenant', value: false });
  const shirt = (await t.client.post('/services', { code: 'SH', name: 'Shirt', pricingModel: 'per_item', turnaroundHours: 24, price: { unitPriceMinor: 1000 } })).body.id;
  const customer = (await t.client.post('/customers', { fullName: 'Ada Lovelace', phone: '7805550101', address: addr })).body.id;
  const addressId = (await t.client.get(`/customers/${customer}`)).body.addresses[0].id as string;
  await t.client.post('/delivery-zones', { name: 'Central', postalPrefixes: ['T5J', 't5k'], feeMinor: 500, minOrderMinor: 1500, freeOverMinor: 5000 });
  const order = (c: Client = t.client, over: any = {}) => postKey(c, '/orders', { branchId: t.branchId, customerId: customer, lines: [{ serviceId: shirt, quantity: 2 }],
    deliveryAddressId: addressId, deliveryWindow: win(), ...over });
  return { t, shirt, customer, addressId, order };
}
const act = (c: Client, id: string, action: string, body: any = {}) => c.post(`/delivery-tasks/${id}/${action}`, body);

/** Take an order all the way to "ready" with the all-powerful owner. */
async function makeReady(c: Client, orderId: string) {
  const step = async (from: string, to?: string) => { const r = await c.post(`/orders/${orderId}/advance`, { fromStageKey: from, ...(to ? { toStageKey: to } : {}) }); expect(r.status, from).toBe(200); };
  for (const f of ['received', 'intake', 'sorting', 'washing']) await step(f);
  await step('drying', 'folding'); await step('folding');
  expect((await c.post(`/orders/${orderId}/qc`, { result: 'pass' })).status).toBe(200);
  await step('packaging');
}

describe('delivery zones and fees', () => {
  let app: Awaited<ReturnType<typeof makeApp>>; let s: Awaited<ReturnType<typeof shop>>;
  beforeAll(async () => { app = await makeApp(); s = await shop(app); });
  afterAll(async () => { await app.close(); });
  const quote = (over: any = {}) => s.t.client.post('/pricing/quote', { branchId: s.t.branchId, lines: [{ serviceId: s.shirt, quantity: 2 }], deliveryAddressId: s.addressId, ...over });

  it('manages zones (owner only), validates prefixes, and resolves the longest matching prefix among active zones', async () => {
    const cashier = await addStaff(s.t.client, 'cashier');
    expect((await cashier.client.post('/delivery-zones', { name: 'Nope', postalPrefixes: ['T6'] })).status).toBe(403);
    expect((await s.t.client.post('/delivery-zones', { name: 'Bad', postalPrefixes: ['12345'] })).status).toBe(400);
    expect((await s.t.client.post('/delivery-zones', { name: 'central', postalPrefixes: ['V6'] })).status).toBe(409); // case-insensitive name
    expect((await cashier.client.get('/delivery-zones')).status).toBe(200);
    expect((await s.t.client.get('/delivery-zones/check?postalCode=t5j 2r4')).body).toMatchObject({ covered: true, zone: 'Central', feeMinor: 500, freeOverMinor: 5000, minOrderMinor: 1500 });
    expect((await s.t.client.get('/delivery-zones/check?postalCode=V6B 1A1')).body.covered).toBe(false);
    const broad = (await s.t.client.post('/delivery-zones', { name: 'Edmonton wide', postalPrefixes: ['T5'], feeMinor: 900 })).body.id;
    expect((await s.t.client.get('/delivery-zones/check?postalCode=T5J2R4')).body.zone).toBe('Central'); // T5J beats T5
    expect((await s.t.client.get('/delivery-zones/check?postalCode=T5Z1A1')).body.zone).toBe('Edmonton wide');
    await s.t.client.patch(`/delivery-zones/${broad}`, { active: false });
    expect((await s.t.client.get('/delivery-zones/check?postalCode=T5Z1A1')).body.covered).toBe(false); // inactive ignored
    expect((await s.t.client.get('/delivery-zones/check?postalCode=nonsense')).status).toBe(400);
  });

  it('adds the zone fee to the quote, taxed but never discounted', async () => {
    const q = (await quote()).body; // 2 shirts = 2000, fee 500, GST 5% on 2500
    expect(q).toMatchObject({ subtotalMinor: 2000, taxMinor: 125, totalMinor: 2625, delivery: { zone: 'Central', feeMinor: 500, freeDelivery: false } });
    expect(q.fee).toMatchObject({ amountMinor: 500, taxMinor: 25, totalMinor: 525 });
    const d = (await quote({ discount: { type: 'percent', percent: '10' } })).body; // discount on services only: 200
    expect(d).toMatchObject({ discountMinor: 200, totalMinor: 1800 + 500 + 115 });
    expect((await s.t.client.post('/pricing/quote', { branchId: s.t.branchId, lines: [{ serviceId: s.shirt, quantity: 2 }] })).body).toMatchObject({ delivery: null, totalMinor: 2100, fee: null });
  });

  it('enforces minimum order, free-delivery threshold, taxable flag and tax-inclusive pricing', async () => {
    const small = await quote({ lines: [{ serviceId: s.shirt, quantity: 1 }] });
    expect(small.status).toBe(422); expect(small.body.code).toBe('BELOW_DELIVERY_MINIMUM');
    const free = (await quote({ lines: [{ serviceId: s.shirt, quantity: 5 }] })).body; // 5000 >= free-over
    expect(free).toMatchObject({ delivery: { freeDelivery: true, feeMinor: 0 }, totalMinor: 5250 });
    const zid = ((await s.t.client.get('/delivery-zones')).body.items as any[]).find((z) => z.name === 'Central').id;
    await s.t.client.patch(`/delivery-zones/${zid}`, { taxable: false });
    expect((await quote()).body).toMatchObject({ totalMinor: 2000 + 500 + 100, fee: { taxMinor: 0 } });
    await s.t.client.patch(`/delivery-zones/${zid}`, { taxable: true });
    await s.t.client.put('/config/tax.price_mode', { scope: 'tenant', value: 'inclusive' });
    expect((await quote()).body).toMatchObject({ totalMinor: 2000 + 500, fee: { netMinor: 476, taxMinor: 24 } }); // 500 includes 5% tax: 476.19 -> 476
    await s.t.client.put('/config/tax.price_mode', { scope: 'tenant', value: 'exclusive' });
  });

  it('rejects addresses outside every zone, unknown addresses and other businesses\' addresses', async () => {
    const c2 = (await s.t.client.post('/customers', { fullName: 'Far Away', phone: '7805550202', address: { ...addr, city: 'Vancouver', province: 'BC', postalCode: 'V6B 1A1' } })).body.id;
    const far = (await s.t.client.get(`/customers/${c2}`)).body.addresses[0].id;
    const r = await quote({ deliveryAddressId: far });
    expect(r.status).toBe(422); expect(r.body.code).toBe('OUT_OF_ZONE');
    expect((await quote({ deliveryAddressId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    const B = await shop(app);
    expect((await quote({ deliveryAddressId: B.addressId })).status).toBe(404);
  });
});

describe('pickup, delivery and the driver', () => {
  let app: Awaited<ReturnType<typeof makeApp>>; let s: Awaited<ReturnType<typeof shop>>;
  let dispatcher: Awaited<ReturnType<typeof addStaff>>, driver: Awaited<ReturnType<typeof addStaff>>, driver2: Awaited<ReturnType<typeof addStaff>>, cashier: Awaited<ReturnType<typeof addStaff>>;
  const myId = async (c: Client) => (await c.get('/auth/me')).body.user.id as string;
  beforeAll(async () => {
    app = await makeApp(); s = await shop(app);
    dispatcher = await addStaff(s.t.client, 'dispatcher'); driver = await addStaff(s.t.client, 'driver'); driver2 = await addStaff(s.t.client, 'driver'); cashier = await addStaff(s.t.client, 'cashier');
  });
  afterAll(async () => { await app.close(); });

  const newDelivery = async (over: any = {}) => { const r = await s.order(s.t.client, over); expect(r.status).toBe(201); return { orderId: r.body.id as string, taskId: r.body.deliveryTaskId as string, orderNo: r.body.orderNo as string }; };
  const assign = async (taskId: string, d = driver) => (await dispatcher.client.post(`/delivery-tasks/${taskId}/assign`, { driverUserId: await myId(d.client) }));

  it('an order with delivery creates the task, charges the fee, and the receipt shows it with its tax', async () => {
    const d = await newDelivery();
    const o = (await s.t.client.get(`/orders/${d.orderId}`)).body;
    expect(o).toMatchObject({ totalMinor: 2625, deliveryFeeMinor: 500, taxMinor: 125 });
    const rc = (await s.t.client.get(`/orders/${d.orderId}/receipt`)).body;
    expect(rc).toMatchObject({ deliveryFeeMinor: 500, subtotalMinor: 2000, totalMinor: 2625 }); expect(rc.taxByComponent.GST).toBe(125);
    const t = (await dispatcher.client.get(`/delivery-tasks/${d.taskId}`)).body;
    expect(t).toMatchObject({ kind: 'delivery', status: 'requested', orderNo: d.orderNo, feeMinor: 500, contactName: 'Ada Lovelace', blockedReason: null });
    expect(t.address).toMatchObject({ postalCode: 'T5J 2R4', city: 'Edmonton' });
    expect(t.otp).toMatch(/^\d{6}$/);
    expect(t.events[0].type).toBe('task.created');
    // address and window must come together; the address must be the customer's own
    expect((await s.order(s.t.client, { deliveryWindow: undefined })).status).toBe(400);
    const other = (await s.t.client.post('/customers', { fullName: 'Someone Else', phone: '7805550303' })).body.id;
    expect((await s.order(s.t.client, { customerId: other })).body.code).toBe('ADDRESS_NOT_CUSTOMERS');
    expect((await s.order(s.t.client, { deliveryWindow: { start: new Date(Date.now() + 3 * 3600_000).toISOString(), end: new Date(Date.now() + 1 * 3600_000).toISOString() } })).status).toBe(400);
  });

  it('books pickups for staff with order.create or dispatch rights, in covered areas only', async () => {
    const body = { branchId: s.t.branchId, customerId: s.customer, addressId: s.addressId, window: win(), notes: 'Two laundry bags by the door' };
    expect((await cashier.client.post('/delivery-tasks', body)).status).toBe(201);
    expect((await dispatcher.client.post('/delivery-tasks', body)).status).toBe(201);
    expect((await driver.client.post('/delivery-tasks', body)).status).toBe(403);
    const far = (await s.t.client.post('/customers', { fullName: 'Far Away', phone: '7805550404', address: { ...addr, province: 'BC', city: 'Vancouver', postalCode: 'V6B 1A1' } })).body.id;
    const farAddr = (await s.t.client.get(`/customers/${far}`)).body.addresses[0].id;
    expect((await cashier.client.post('/delivery-tasks', { ...body, customerId: far, addressId: farAddr })).body.code).toBe('OUT_OF_ZONE');
    expect((await cashier.client.post('/delivery-tasks', { ...body, addressId: farAddr })).status).toBe(404); // address belongs to someone else
    expect((await cashier.client.post('/delivery-tasks', { ...body, window: { start: new Date(Date.now() - 48 * 3600_000).toISOString(), end: new Date(Date.now() - 47 * 3600_000).toISOString() } })).status).toBe(400);
  });

  it('dispatch: only dispatchers assign; only real, active drivers at that branch can be assigned', async () => {
    const d = await newDelivery();
    expect((await cashier.client.post(`/delivery-tasks/${d.taskId}/assign`, { driverUserId: await myId(driver.client) })).status).toBe(403);
    expect((await driver.client.get('/delivery-tasks')).status).toBe(403);
    expect((await dispatcher.client.post(`/delivery-tasks/${d.taskId}/assign`, { driverUserId: await myId(cashier.client) })).body.code).toBe('NOT_A_DRIVER');
    const north = (await s.t.client.post('/branches', { code: 'NORTH', name: 'North' })).body.id;
    const northDriver = await addStaff(s.t.client, 'driver', { allBranches: false, branchIds: [north] });
    expect((await dispatcher.client.post(`/delivery-tasks/${d.taskId}/assign`, { driverUserId: await myId(northDriver.client) })).body.code).toBe('DRIVER_BRANCH');
    expect((await assign(d.taskId)).body.status).toBe('assigned');
    const drivers = (await dispatcher.client.get('/drivers')).body.items as any[];
    expect(drivers.map((x) => x.userId)).toContain(await myId(driver.client)); expect(drivers.map((x) => x.userId)).not.toContain(await myId(cashier.client));
    expect(((await dispatcher.client.get('/delivery-tasks?status=assigned')).body.items as any[]).find((x) => x.id === d.taskId).driverName).toMatch(/driver/);
  });

  it('drivers see only their own tasks; others look non-existent; dispatchers see the delivery code, drivers never do', async () => {
    const d = await newDelivery(); await assign(d.taskId, driver);
    const mine = (await driver.client.get('/driver/tasks')).body.items as any[];
    expect(mine.map((x) => x.id)).toContain(d.taskId);
    expect(((await driver2.client.get('/driver/tasks')).body.items as any[]).map((x) => x.id)).not.toContain(d.taskId);
    expect((await driver2.client.get(`/delivery-tasks/${d.taskId}`)).status).toBe(404);
    for (const a of ['start', 'complete', 'fail']) expect((await act(driver2.client, d.taskId, a, a === 'fail' ? { reason: 'other' } : { proof: { type: 'recipient', recipientName: 'Ada' } })).status, a).toBe(404);
    const dv = (await driver.client.get(`/delivery-tasks/${d.taskId}`)).body;
    expect(dv.otp).toBeUndefined(); expect(dv.feeMinor).toBeUndefined(); expect(dv.mapsUrl).toContain('google.com/maps/dir');
    expect(dv.blockedReason).toBe('The order is not ready for delivery yet');
    expect((await dispatcher.client.get(`/delivery-tasks/${d.taskId}`)).body.otp).toMatch(/^\d{6}$/);
  });

  it('pickup: driver collects with a bag count, staff link the order afterwards', async () => {
    const pk = (await cashier.client.post('/delivery-tasks', { branchId: s.t.branchId, customerId: s.customer, addressId: s.addressId, window: win() })).body.id;
    await assign(pk);
    expect((await act(driver.client, pk, 'start')).body.status).toBe('en_route');
    expect((await act(driver.client, pk, 'start')).body.status).toBe('en_route'); // idempotent
    expect((await act(driver.client, pk, 'complete', {})).status).toBe(400); // bag count required
    expect((await act(driver.client, pk, 'complete', { bagCount: 3, note: 'Left key with neighbour' })).body).toMatchObject({ status: 'completed', bagCount: 3 });
    expect((await act(driver.client, pk, 'complete', { bagCount: 3 })).body.code).toBe('NOT_ACTIVE');
    const order = (await postKey(cashier.client, '/orders', { branchId: s.t.branchId, customerId: s.customer, lines: [{ serviceId: s.shirt, quantity: 2 }] })).body.id;
    const stranger = (await s.t.client.post('/customers', { fullName: 'Stranger', phone: '7805550505' })).body.id;
    const strangerOrder = (await postKey(cashier.client, '/orders', { branchId: s.t.branchId, customerId: stranger, lines: [{ serviceId: s.shirt, quantity: 1 }] })).body.id;
    expect((await act(cashier.client, pk, 'link-order', { orderId: strangerOrder })).body.code).toBe('CUSTOMER_MISMATCH');
    expect((await act(cashier.client, pk, 'link-order', { orderId: order })).body.orderId).toBe(order);
    expect((await act(cashier.client, pk, 'link-order', { orderId: order })).body.code).toBe('ALREADY_LINKED');
    expect((await dispatcher.client.get(`/delivery-tasks/${pk}`)).body).toMatchObject({ orderId: order, bagCount: 3 });
  });

  it('delivery needs a ready, fully paid order and valid proof; completing it hands the order over', async () => {
    const d = await newDelivery(); await assign(d.taskId);
    const done = (body: any) => act(driver.client, d.taskId, 'complete', body);
    const otp = (await dispatcher.client.get(`/delivery-tasks/${d.taskId}`)).body.otp as string;
    expect((await done({})).status).toBe(400); // proof required
    expect((await done({ proof: { type: 'otp', code: otp } })).body.code).toBe('ORDER_NOT_READY');
    await makeReady(s.t.client, d.orderId);
    expect((await done({ proof: { type: 'otp', code: otp } })).body.code).toBe('BALANCE_DUE');
    expect((await driver.client.get(`/delivery-tasks/${d.taskId}`)).body.blockedReason).toBe('Payment is still due on this order');
    expect((await postKey(s.t.client, `/orders/${d.orderId}/payments`, { method: 'card_external', amountMinor: 2625 })).status).toBe(201);
    expect((await driver.client.get(`/delivery-tasks/${d.taskId}`)).body.blockedReason).toBeNull();
    const wrong = otp === '000000' ? '111111' : '000000';
    const w = await done({ proof: { type: 'otp', code: wrong } });
    expect(w.status).toBe(422); expect(w.body.code).toBe('OTP_INVALID'); expect(w.body.title).toContain('4 tries left');
    expect((await dispatcher.client.get(`/delivery-tasks/${d.taskId}`)).body.otpAttempts).toBe(1); // the failed attempt was kept
    for (let i = 0; i < 4; i++) await done({ proof: { type: 'otp', code: wrong } });
    const locked = await done({ proof: { type: 'otp', code: otp } }); // even the right code is refused once locked
    expect(locked.status).toBe(409); expect(locked.body.code).toBe('OTP_LOCKED');
    const reset = (await act(dispatcher.client, d.taskId, 'otp/reset')).body.otp as string;
    expect(reset).toMatch(/^\d{6}$/);
    expect((await done({ proof: { type: 'otp', code: reset } })).body).toMatchObject({ status: 'completed', orderStatus: 'completed' });
    const o = (await s.t.client.get(`/orders/${d.orderId}`)).body;
    expect(o.status).toBe('completed'); expect(o.stageKey).toBe('handed_over');
    const handed = o.events.find((e: any) => e.type === 'order.handed_over');
    expect(handed.payload).toMatchObject({ via: 'delivery', proof: 'otp' });
    const t = (await dispatcher.client.get(`/delivery-tasks/${d.taskId}`)).body;
    expect(t).toMatchObject({ status: 'completed', otp: null, proof: { type: 'otp' } });
    expect(t.events.map((e: any) => e.type)).toEqual(expect.arrayContaining(['task.created', 'task.assigned', 'task.otp_failed', 'task.otp_reset', 'task.completed']));
    expect(((await s.t.client.get('/audit-logs?limit=200')).body.items as any[]).some((i) => i.action === 'order.handed_over' && i.detail.via === 'delivery')).toBe(true);
  });

  it('accepts recipient-name and left-at-door proof, and two simultaneous completions hand over exactly once', async () => {
    const d = await newDelivery(); await assign(d.taskId); await makeReady(s.t.client, d.orderId);
    await postKey(s.t.client, `/orders/${d.orderId}/payments`, { method: 'card_external', amountMinor: 2625 });
    const rs = await Promise.all([1, 2, 3].map(() => act(driver.client, d.taskId, 'complete', { proof: { type: 'recipient', recipientName: 'Ada Lovelace' } })));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    const o = (await s.t.client.get(`/orders/${d.orderId}`)).body;
    expect(o.events.filter((e: any) => e.type === 'order.handed_over')).toHaveLength(1);
    const d2 = await newDelivery(); await assign(d2.taskId); await makeReady(s.t.client, d2.orderId);
    await postKey(s.t.client, `/orders/${d2.orderId}/payments`, { method: 'card_external', amountMinor: 2625 });
    expect((await act(driver.client, d2.taskId, 'complete', { proof: { type: 'left_at_door', note: 'x' } })).status).toBe(400); // note too short
    expect((await act(driver.client, d2.taskId, 'complete', { proof: { type: 'left_at_door', note: 'Left with concierge' } })).body.status).toBe('completed');
    expect((await dispatcher.client.get(`/delivery-tasks/${d2.taskId}`)).body.proof).toMatchObject({ type: 'left_at_door', note: 'Left with concierge' });
  });

  it('failed attempts keep the order intact; dispatch can reschedule, reassign or cancel', async () => {
    const d = await newDelivery(); await assign(d.taskId);
    expect((await act(driver.client, d.taskId, 'fail', { reason: 'bad' })).status).toBe(400);
    expect((await act(driver.client, d.taskId, 'fail', { reason: 'no_answer', note: 'Rang twice' })).body.status).toBe('failed');
    expect((await act(driver.client, d.taskId, 'complete', { proof: { type: 'recipient', recipientName: 'Ada' } })).body.code).toBe('NOT_ACTIVE');
    expect((await s.t.client.get(`/orders/${d.orderId}`)).body.status).toBe('open');
    const failed = (await dispatcher.client.get('/delivery-tasks')).body.items as any[];
    expect(failed.find((x) => x.id === d.taskId)).toMatchObject({ status: 'failed', failureReason: 'no_answer', attempts: 1 });
    const re = await act(dispatcher.client, d.taskId, 'reschedule', { window: win(24, 2) });
    expect(re.body.status).toBe('requested');
    expect((await act(dispatcher.client, d.taskId, 'reschedule', { window: win(24, 2), driverUserId: await myId(driver2.client) })).body.status).toBe('assigned');
    expect(((await driver2.client.get('/driver/tasks')).body.items as any[]).map((x) => x.id)).toContain(d.taskId);
    expect(((await driver.client.get('/driver/tasks')).body.items as any[]).map((x) => x.id)).not.toContain(d.taskId); // moved off the first driver
    expect((await act(dispatcher.client, d.taskId, 'cancel', { reason: 'ab' })).status).toBe(400);
    expect((await act(dispatcher.client, d.taskId, 'cancel', { reason: 'Customer will collect' })).body.status).toBe('cancelled');
    expect((await act(dispatcher.client, d.taskId, 'cancel', { reason: 'Customer will collect' })).body.code).toBe('NOT_CANCELLABLE');
    expect((await act(dispatcher.client, d.taskId, 'assign', { driverUserId: await myId(driver.client) })).body.code).toBe('NOT_ASSIGNABLE');
  });

  it('task events are append-only in the database', async () => {
    const c = new pg.Client({ connectionString: OWNER_URL }); await c.connect();
    try {
      await c.query(`SELECT set_config('app.tenant_id', $1, false), set_config('app.all_branches', 'true', false)`, [s.t.tenantId]);
      await expect(c.query(`UPDATE delivery_events SET type = 'x'`)).rejects.toMatchObject({ code: '23001' });
      await expect(c.query(`DELETE FROM delivery_events`)).rejects.toMatchObject({ code: '23001' });
    } finally { await c.end(); }
  });
});

describe('logistics — branch and tenant isolation', () => {
  it('another business cannot see or act on delivery tasks, zones or drivers; branch-limited dispatchers see only their branch', async () => {
    const app = await makeApp();
    const A = await shop(app), B = await shop(app);
    const north = (await A.t.client.post('/branches', { code: 'NORTH', name: 'North' })).body.id;
    const mainTask = (await A.order()).body.deliveryTaskId as string;
    const northTask = (await A.order(A.t.client, { branchId: north })).body.deliveryTaskId as string;
    const driverA = await addStaff(A.t.client, 'driver');
    // tenant isolation
    expect((await B.t.client.get(`/delivery-tasks/${mainTask}`)).status).toBe(404);
    expect((await B.t.client.post(`/delivery-tasks/${mainTask}/assign`, { driverUserId: (await driverA.client.get('/auth/me')).body.user.id })).status).toBe(404);
    expect((await B.t.client.post(`/delivery-tasks/${mainTask}/cancel`, { reason: 'hostile cancel' })).status).toBe(404);
    expect((await B.t.client.get('/delivery-tasks')).body.items).toHaveLength(0);
    expect(((await B.t.client.get('/delivery-zones')).body.items as any[]).every((z) => z.name === 'Central')).toBe(true);
    const aDriverId = (await driverA.client.get('/auth/me')).body.user.id;
    expect(((await B.t.client.get('/drivers')).body.items as any[]).map((x) => x.userId)).not.toContain(aDriverId);
    // branch isolation
    const nd = await addStaff(A.t.client, 'dispatcher', { allBranches: false, branchIds: [north] });
    expect(((await nd.client.get('/delivery-tasks')).body.items as any[]).map((t) => t.id)).toEqual([northTask]);
    expect((await nd.client.get(`/delivery-tasks/${mainTask}`)).status).toBe(404);
    expect((await nd.client.post(`/delivery-tasks/${mainTask}/cancel`, { reason: 'wrong branch' })).status).toBe(404);
    await app.close();
  });
});
