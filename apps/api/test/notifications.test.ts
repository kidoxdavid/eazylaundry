import 'reflect-metadata';
import { simpleParser, type ParsedMail } from 'mailparser';
import pg from 'pg';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotificationsWorker } from '../src/notifications/worker.js';
import { Client, WORKER_URL, makeApp, postKey, registerTenant } from './helpers.js';

const addr = { line1: '10 Jasper Ave', city: 'Edmonton', province: 'AB', postalCode: 'T5J 2R4' };
const win = () => ({ start: new Date(Date.now() + 3600_000).toISOString(), end: new Date(Date.now() + 3 * 3600_000).toISOString() });

/** A real SMTP server on localhost that records every message it accepts. */
async function smtp(rejectPrefix = 'bounce@') {
  const inbox: ParsedMail[] = [];
  const server = new SMTPServer({
    authOptional: true, disabledCommands: ['STARTTLS'],
    onRcptTo(a, _s, cb) { if (a.address.startsWith(rejectPrefix)) return cb(Object.assign(new Error('550 mailbox unavailable'), { responseCode: 550 })); cb(); },
    onData(stream, _s, cb) { const chunks: Buffer[] = []; stream.on('data', (c) => chunks.push(c)); stream.on('end', async () => { inbox.push(await simpleParser(Buffer.concat(chunks))); cb(); }); },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.server.address() as any).port as number;
  return { inbox, port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function shop(app: any, over: { email?: string | null; name?: string } = {}) {
  const t = await registerTenant(app);
  await t.client.put('/config/cash.require_shift', { scope: 'tenant', value: false });
  const shirt = (await t.client.post('/services', { code: 'SH', name: 'Shirt', pricingModel: 'per_item', turnaroundHours: 24, price: { unitPriceMinor: 1000 } })).body.id;
  const email = over.email === undefined ? `ada${Math.random().toString(36).slice(2, 8)}@example.test` : over.email;
  const customer = (await t.client.post('/customers', { fullName: over.name ?? 'Ada Lovelace', phone: `780555${Math.floor(1000 + Math.random() * 8999)}`, ...(email ? { email } : {}), address: addr })).body.id;
  const addressId = (await t.client.get(`/customers/${customer}`)).body.addresses[0].id as string;
  await t.client.post('/delivery-zones', { name: 'Central', postalPrefixes: ['T5J'], feeMinor: 500 });
  const order = (c: Client = t.client, over2: any = {}) => postKey(c, '/orders', { branchId: t.branchId, customerId: customer, lines: [{ serviceId: shirt, quantity: 2 }], ...over2 });
  const notes = async (orderId?: string) => (await t.client.get(`/notifications${orderId ? `?orderId=${orderId}` : ''}`)).body.items as any[];
  return { t, shirt, customer, addressId, email, order, notes };
}
const worker = (app: any) => app.get(NotificationsWorker) as NotificationsWorker;
async function asWorker<T>(fn: (c: pg.Client) => Promise<T>) { const c = new pg.Client({ connectionString: WORKER_URL }); await c.connect(); try { return await fn(c); } finally { await c.end(); } }

describe('notifications — delivery through a real SMTP server', () => {
  let mail: Awaited<ReturnType<typeof smtp>>; let app: Awaited<ReturnType<typeof makeApp>>;
  beforeAll(async () => { mail = await smtp(); app = await makeApp({ SMTP_URL: `smtp://127.0.0.1:${mail.port}`, MAIL_FROM: 'Test Laundry <no-reply@test.example>' }); });
  afterAll(async () => { await app.close(); await mail.close(); });

  it('queues messages inside the order transaction, then the worker delivers them and records the result', async () => {
    const s = await shop(app);
    const o = await s.order(s.t.client, { deliveryAddressId: s.addressId, deliveryWindow: win() });
    expect(o.status).toBe(201);
    const queued = await s.notes(o.body.id);
    expect(queued.map((n) => n.template).sort()).toEqual(['delivery.scheduled', 'order.received']);
    expect(queued.every((n) => n.status === 'queued' && n.to === s.email)).toBe(true);
    const before = mail.inbox.length;
    expect(await worker(app).runOnce()).toBeGreaterThanOrEqual(2);
    const sent = await s.notes(o.body.id);
    expect(sent.every((n) => n.status === 'sent' && n.provider === 'smtp' && n.sentAt)).toBe(true);
    const received = mail.inbox.slice(before).filter((m) => (m.to as any).text === s.email);
    expect(received).toHaveLength(2);
    const rec = received.find((m) => /received/.test(m.subject ?? ''))!;
    expect(rec.from?.text).toContain('no-reply@test.example');
    expect(rec.text).toContain(o.body.orderNo); expect(rec.text).toContain('$26.25'); // 2 x $10 + $5 delivery, plus GST
    expect(rec.html).toContain('/b/'); // link into the storefront
  });

  it('the delivery email carries the same code dispatch sees, and the stored copy is scrubbed after sending', async () => {
    const s = await shop(app);
    const o = await s.order(s.t.client, { deliveryAddressId: s.addressId, deliveryWindow: win() });
    const before = mail.inbox.length; await worker(app).runOnce();
    const dm = mail.inbox.slice(before).find((m) => /Delivery scheduled/.test(m.subject ?? '') && (m.to as any).text === s.email)!;
    const dispatcherView = (await s.t.client.get(`/delivery-tasks/${o.body.deliveryTaskId}`)).body;
    expect(dm.text).toContain(`delivery code is ${dispatcherView.otp}`);
    expect(dm.text).toContain('10 Jasper Ave'); expect(dm.text).toMatch(/Nov|Dec|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct/);
    // the secret is not kept in the notification log
    const row = await asWorker((c) => c.query(`SELECT body_text, body_html FROM notifications WHERE task_id = $1`, [o.body.deliveryTaskId]));
    expect(row.rows[0].body_text).toBe('[content removed after sending]'); expect(row.rows[0].body_html).toBeNull();
    expect(JSON.stringify(row.rows)).not.toContain(dispatcherView.otp);
  });

  it('sends "order ready" when production reaches the ready stage, mentioning a scheduled delivery', async () => {
    const s = await shop(app);
    const o = await s.order(s.t.client, { deliveryAddressId: s.addressId, deliveryWindow: win() });
    await worker(app).runOnce();
    const step = async (from: string, to?: string) => expect((await s.t.client.post(`/orders/${o.body.id}/advance`, { fromStageKey: from, ...(to ? { toStageKey: to } : {}) })).status).toBe(200);
    for (const f of ['received', 'intake', 'sorting', 'washing']) await step(f);
    await step('drying', 'folding'); await step('folding');
    await s.t.client.post(`/orders/${o.body.id}/qc`, { result: 'pass' }); await step('packaging');
    const before = mail.inbox.length; await worker(app).runOnce();
    const m = mail.inbox.slice(before).find((x) => /is ready/.test(x.subject ?? '') && (x.to as any).text === s.email)!;
    expect(m.text).toContain('Your delivery is scheduled for');
    expect((await s.notes(o.body.id)).filter((n) => n.template === 'order.ready')).toHaveLength(1);
  });

  it('sends a pickup confirmation', async () => {
    const s = await shop(app);
    const r = await s.t.client.post('/delivery-tasks', { branchId: s.t.branchId, customerId: s.customer, addressId: s.addressId, window: win(), notes: 'Bags by the door' });
    expect(r.status).toBe(201);
    const before = mail.inbox.length; await worker(app).runOnce();
    const m = mail.inbox.slice(before).find((x) => x.subject === 'Pickup booked' && (x.to as any).text === s.email)!;
    expect(m.text).toContain('Bags by the door');
  });

  it('never queues the same message twice (replayed requests, duplicate triggers)', async () => {
    const s = await shop(app);
    const key = `k-${crypto.randomUUID()}`;
    const body = { branchId: s.t.branchId, customerId: s.customer, lines: [{ serviceId: s.shirt, quantity: 1 }] };
    await postKey(s.t.client, '/orders', body, key); await postKey(s.t.client, '/orders', body, key);
    const all = (await s.notes()).filter((n) => n.template === 'order.received');
    expect(all).toHaveLength(1);
  });

  it('customers without an email address are recorded as suppressed, not silently skipped', async () => {
    const s = await shop(app, { email: null });
    const o = await s.order();
    const n = (await s.notes(o.body.id))[0];
    expect(n).toMatchObject({ template: 'order.received', status: 'suppressed', error: 'No email address on file' });
  });

  it('escapes customer-supplied text in the HTML body', async () => {
    const s = await shop(app, { name: '<b>Evil</b> & Co' });
    await s.order(); const before = mail.inbox.length; await worker(app).runOnce();
    const m = mail.inbox.slice(before).find((x) => (x.to as any).text === s.email)!;
    expect(m.html).toContain('&lt;b&gt;Evil&lt;/b&gt; &amp; Co'); expect(m.html).not.toContain('<b>Evil</b>');
  });

  it('permanent SMTP rejections fail immediately instead of retrying forever', async () => {
    const s = await shop(app, { email: 'bounce@example.test' });
    const o = await s.order(); await worker(app).runOnce();
    const n = (await s.notes(o.body.id))[0];
    expect(n.status).toBe('failed'); expect(n.attempts).toBe(1); expect(n.error).toMatch(/550|rejected/i);
  });

  it('notification lists are tenant-isolated', async () => {
    const A = await shop(app), B = await shop(app);
    const o = await A.order();
    expect((await A.notes(o.body.id)).length).toBeGreaterThan(0);
    expect(await B.notes(o.body.id)).toHaveLength(0);
    expect((await B.notes()).every((n) => n.to === B.email)).toBe(true);
  });
});

describe('notifications — failure handling and honesty', () => {
  it('transient failures back off and are retried a bounded number of times, then marked failed', async () => {
    const app = await makeApp({ SMTP_URL: 'smtp://127.0.0.1:1' }); // nothing listens on port 1
    const s = await shop(app); const o = await s.order();
    await worker(app).runOnce();
    let n = (await s.notes(o.body.id))[0];
    expect(n).toMatchObject({ status: 'queued', attempts: 1 }); expect(n.error).toBeTruthy();
    expect(await worker(app).runOnce()).toBe(0); // not due yet: backoff is honoured
    for (let i = 2; i <= 5; i++) {
      await asWorker((c) => c.query(`UPDATE notifications SET next_attempt_at = now() - interval '1 second' WHERE order_id = $1`, [o.body.id]));
      await worker(app).runOnce();
      n = (await s.notes(o.body.id))[0];
      expect(n.attempts).toBe(i);
    }
    expect(n.status).toBe('failed'); // gave up after 5 attempts
    await app.close();
  });

  it('without an email provider, messages are marked "logged" (not delivered) and keep their content for development', async () => {
    const app = await makeApp(); // no SMTP_URL
    const s = await shop(app); const o = await s.order(s.t.client, { deliveryAddressId: s.addressId, deliveryWindow: win() });
    await worker(app).runOnce();
    const ns = await s.notes(o.body.id);
    expect(ns.every((n) => n.status === 'logged' && n.error?.includes('not delivered'))).toBe(true);
    expect(ns.some((n) => n.status === 'sent')).toBe(false);
    await app.close();
  });

  it('the worker role can progress notifications and nothing else', async () => {
    const app = await makeApp(); const s = await shop(app); await s.order();
    await asWorker(async (c) => {
      expect((await c.query(`SELECT count(*)::int AS n FROM notifications`)).rows[0].n).toBeGreaterThan(0);
      for (const sql of [`SELECT * FROM orders`, `SELECT * FROM customers`, `SELECT * FROM users`, `UPDATE customers SET full_name = 'x'`, `DELETE FROM notifications`,
        `INSERT INTO notifications (id, tenant_id, template, to_address, subject, body_text) VALUES (gen_random_uuid(), gen_random_uuid(), 't', 'a@b.c', 's', 'b')`]) {
        await expect(c.query(sql), sql).rejects.toMatchObject({ code: '42501' });
      }
    });
    await app.close();
  });
});
