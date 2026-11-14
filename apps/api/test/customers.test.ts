import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addStaff, makeApp, registerTenant } from './helpers.js';

const addr = { line1: '10 Jasper Ave', city: 'Edmonton', province: 'AB', postalCode: 't5j 2r4' };

describe('customers', () => {
  let app: Awaited<ReturnType<typeof makeApp>>;
  let T: Awaited<ReturnType<typeof registerTenant>>;
  beforeAll(async () => { app = await makeApp(); T = await registerTenant(app); });
  afterAll(async () => { await app.close(); });

  it('creates a customer with normalised phone, address and consent, and reads it back', async () => {
    const c = await T.client.post('/customers', { fullName: 'Ada Lovelace', phone: '(780) 555-0101', email: 'Ada@Example.test', address: addr,
      consents: [{ purpose: 'marketing_email', granted: true }] });
    expect(c.status).toBe(201);
    const got = (await T.client.get(`/customers/${c.body.id}`)).body;
    expect(got).toMatchObject({ fullName: 'Ada Lovelace', phone: '+17805550101', email: 'ada@example.test', version: 1, archived: false });
    expect(got.addresses).toHaveLength(1);
    expect(got.addresses[0]).toMatchObject({ postalCode: 'T5J 2R4', isDefault: true, province: 'AB' });
    expect(got.consents).toEqual([expect.objectContaining({ purpose: 'marketing_email', granted: true, source: 'pos' })]);
  });

  it('requires contact details unless the customer is a guest', async () => {
    const bad = await T.client.post('/customers', { fullName: 'No Contact' });
    expect(bad.status).toBe(400);
    expect((await T.client.post('/customers', { kind: 'guest', fullName: 'Walk-in' })).status).toBe(201);
    expect((await T.client.post('/customers', { kind: 'guest', fullName: 'Walk-in' })).status).toBe(201); // many guests allowed
  });

  it('validates phone numbers, emails and Canadian addresses', async () => {
    expect((await T.client.post('/customers', { fullName: 'X', phone: '12345' })).status).toBe(400);
    expect((await T.client.post('/customers', { fullName: 'X', email: 'nope' })).status).toBe(400);
    expect((await T.client.post('/customers', { fullName: 'Bad Addr', phone: '7805550111', address: { ...addr, postalCode: 'D1D 1D1' } })).status).toBe(400);
    expect((await T.client.post('/customers', { fullName: 'Bad Prov', phone: '7805550112', address: { ...addr, province: 'ZZ' } })).status).toBe(400);
  });

  it('prevents duplicates by phone or email (any formatting) but frees them when archived', async () => {
    const first = await T.client.post('/customers', { fullName: 'Dup One', phone: '+1 780 555 0202', email: 'dup@example.test' });
    expect(first.status).toBe(201);
    const byPhone = await T.client.post('/customers', { fullName: 'Dup Two', phone: '780-555-0202' });
    expect(byPhone.status).toBe(409); expect(byPhone.body.code).toBe('DUPLICATE_CUSTOMER');
    expect((await T.client.post('/customers', { fullName: 'Dup Three', email: 'DUP@example.test' })).status).toBe(409);
    const cur = (await T.client.get(`/customers/${first.body.id}`)).body;
    expect((await T.client.patch(`/customers/${first.body.id}`, { version: cur.version, archived: true })).status).toBe(200);
    expect((await T.client.post('/customers', { fullName: 'Dup Reborn', phone: '780-555-0202' })).status).toBe(201);
  });

  it('searches by name fragment, phone digits and email, and escapes LIKE wildcards', async () => {
    await T.client.post('/customers', { fullName: 'Grace Hopper', phone: '4035550303', email: 'grace@navy.test' });
    await T.client.post('/customers', { fullName: '100% Pure Linen', phone: '4035550304' });
    const names = async (q: string) => ((await T.client.get(`/customers?q=${encodeURIComponent(q)}`)).body.items as any[]).map((i) => i.fullName);
    expect(await names('hopp')).toEqual(['Grace Hopper']);
    expect(await names('(403) 555-0303')).toEqual(['Grace Hopper']);
    expect(await names('0303')).toEqual(['Grace Hopper']);
    expect(await names('navy.test')).toEqual(['Grace Hopper']);
    expect(await names('100%')).toEqual(['100% Pure Linen']);
    expect(await names('%')).toEqual(['100% Pure Linen']); // literal percent, not a wildcard
    expect(await names('zzzz-none')).toEqual([]);
  });

  it('uses optimistic concurrency on updates', async () => {
    const id = (await T.client.post('/customers', { fullName: 'Version Test', phone: '5875550404' })).body.id;
    expect((await T.client.patch(`/customers/${id}`, { version: 1, notes: 'prefers fragrance-free' })).body.version).toBe(2);
    const stale = await T.client.patch(`/customers/${id}`, { version: 1, notes: 'stale write' });
    expect(stale.status).toBe(409); expect(stale.body.code).toBe('VERSION_CONFLICT');
    expect((await T.client.get(`/customers/${id}`)).body.notes).toBe('prefers fragrance-free');
    const noContact = await T.client.patch(`/customers/${id}`, { version: 2, phone: null });
    expect(noContact.status).toBe(400);
  });

  it('keeps exactly one default address and re-assigns it when it is removed', async () => {
    const id = (await T.client.post('/customers', { fullName: 'Addr Test', phone: '5875550505', address: addr })).body.id;
    const second = (await T.client.post(`/customers/${id}/addresses`, { ...addr, label: 'Work', line1: '99 Whyte Ave', isDefault: true })).body.id;
    let a = (await T.client.get(`/customers/${id}`)).body.addresses as any[];
    expect(a.filter((x) => x.isDefault).map((x) => x.id)).toEqual([second]);
    expect((await T.client.req('delete', `/customers/${id}/addresses/${second}`)).status).toBe(204);
    a = (await T.client.get(`/customers/${id}`)).body.addresses;
    expect(a).toHaveLength(1); expect(a[0].isDefault).toBe(true);
  });

  it('records consent as an append-only history; the latest entry wins', async () => {
    const id = (await T.client.post('/customers', { fullName: 'Consent Test', phone: '5875550606' })).body.id;
    await T.client.post(`/customers/${id}/consents`, { purpose: 'marketing_sms', granted: true, source: 'portal' });
    const r = await T.client.post(`/customers/${id}/consents`, { purpose: 'marketing_sms', granted: false, source: 'unsubscribe_link' });
    expect(r.body.consents).toEqual([expect.objectContaining({ purpose: 'marketing_sms', granted: false, source: 'unsubscribe_link' })]);
    const audit = ((await T.client.get('/audit-logs?limit=200')).body.items as any[]).filter((i) => i.action === 'customer.consent_recorded');
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it('enforces permissions: no access without customer.read, no writes without customer.manage', async () => {
    const tech = await addStaff(T.client, 'production_tech');
    expect((await tech.client.get('/customers')).status).toBe(403);
    const dispatcher = await addStaff(T.client, 'dispatcher'); // customer.read only
    expect((await dispatcher.client.get('/customers')).status).toBe(200);
    expect((await dispatcher.client.post('/customers', { fullName: 'Nope', phone: '5875550707' })).status).toBe(403);
    const cashier = await addStaff(T.client, 'cashier');
    expect((await cashier.client.post('/customers', { fullName: 'Cashier Made', phone: '5875550708' })).status).toBe(201);
  });

  it('writes an audit trail for customer changes', async () => {
    const actions = ((await T.client.get('/audit-logs?limit=200')).body.items as any[]).map((i) => i.action);
    expect(actions).toEqual(expect.arrayContaining(['customer.created', 'customer.updated', 'customer.archived', 'customer.address_added']));
  });
});

describe('customers — tenant isolation', () => {
  it("another business cannot see, search, modify or attach to a tenant's customers", async () => {
    const app = await makeApp();
    const A = await registerTenant(app), B = await registerTenant(app);
    const id = (await A.client.post('/customers', { fullName: 'Secret Person', phone: '7805559999', email: 'secret@example.test', address: addr })).body.id;
    expect((await B.client.get(`/customers/${id}`)).status).toBe(404);
    expect(((await B.client.get('/customers?q=secret')).body.items as any[])).toHaveLength(0);
    expect((await B.client.patch(`/customers/${id}`, { version: 1, notes: 'pwned' })).status).toBe(404);
    expect((await B.client.post(`/customers/${id}/addresses`, addr)).status).toBe(404);
    expect((await B.client.post(`/customers/${id}/consents`, { purpose: 'marketing_email', granted: true })).status).toBe(404);
    expect((await B.client.req('delete', `/customers/${id}/addresses/${id}`)).status).toBe(404);
    // the same phone/email is NOT a duplicate across tenants and reveals nothing about A
    expect((await B.client.post('/customers', { fullName: 'Different Business Customer', phone: '7805559999', email: 'secret@example.test' })).status).toBe(201);
    expect((await A.client.get(`/customers/${id}`)).body.notes).toBeNull();
    await app.close();
  });
});
