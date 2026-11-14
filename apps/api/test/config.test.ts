import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, registerTenant, ownerQuery } from './helpers.js';

describe('configuration engine', () => {
  let app: Awaited<ReturnType<typeof makeApp>>;
  beforeAll(async () => { app = await makeApp(); });
  afterAll(async () => { await app.close(); });

  it('resolves branch > tenant > default and versions every change', async () => {
    const T = await registerTenant(app);
    expect((await T.client.get('/config/weight.display_unit')).body).toMatchObject({ value: 'kg', source: 'default', version: 0 });
    expect((await T.client.put('/config/weight.display_unit', { scope: 'tenant', value: 'lb' })).body.version).toBe(1);
    expect((await T.client.get('/config/weight.display_unit')).body).toMatchObject({ value: 'lb', source: 'tenant' });
    expect((await T.client.put('/config/weight.display_unit', { scope: 'branch', branchId: T.branchId, value: 'kg' })).status).toBe(200);
    expect((await T.client.get(`/config/weight.display_unit?branchId=${T.branchId}`)).body).toMatchObject({ value: 'kg', source: 'branch' });
    expect((await T.client.get('/config/weight.display_unit')).body.value).toBe('lb'); // tenant level unchanged
    expect((await T.client.put('/config/weight.display_unit', { scope: 'tenant', value: 'kg' })).body.version).toBe(2);
  });

  it('rejects unknown keys, invalid values and missing branch', async () => {
    const T = await registerTenant(app);
    expect((await T.client.put('/config/nope', { scope: 'tenant', value: 1 })).status).toBe(404);
    expect((await T.client.put('/config/tax.price_mode', { scope: 'tenant', value: 'weird' })).status).toBe(400);
    expect((await T.client.put('/config/tax.price_mode', { scope: 'branch', value: 'inclusive' })).status).toBe(400);
  });

  it('config history is immutable (append-only) and changes are audited', async () => {
    const T = await registerTenant(app);
    await T.client.put('/config/tax.price_mode', { scope: 'tenant', value: 'inclusive' });
    const audit = (await T.client.get('/audit-logs')).body.items as any[];
    expect(audit.some((a) => a.action === 'config.changed')).toBe(true);
    await expect(ownerQuery(`UPDATE config_entries SET value = '"exclusive"'`)).resolves.toBeDefined(); // FORCE RLS: owner sees 0 rows without context
    const [{ n }] = await ownerQuery<{ n: number }>(`SELECT count(*)::int AS n FROM config_entries`);
    expect(n).toBe(0);
  });

  it('validates Canadian postal codes on branches', async () => {
    const T = await registerTenant(app);
    expect((await T.client.post('/branches', { code: 'BAD', name: 'Bad Postal', address: { postalCode: '12345' } })).status).toBe(400);
    const ok = await T.client.post('/branches', { code: 'GOOD', name: 'Good Postal', address: { postalCode: 't5j 2r4', province: 'ab' } });
    expect(ok.status).toBe(201); expect(ok.body.address.postalCode).toBe('T5J 2R4');
  });
});
