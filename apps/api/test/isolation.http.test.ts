import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ModulesContainer } from '@nestjs/core';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { ACCESS_KEY } from '../src/common/access.js';
import { Client, addStaff, makeApp, registerTenant } from './helpers.js';

describe('access policy coverage', () => {
  it('every route declares an access policy (public / authenticated / permission)', async () => {
    const app = await makeApp();
    const missing: string[] = []; let routes = 0;
    for (const mod of app.get(ModulesContainer).values()) {
      for (const ctrl of mod.controllers.values()) {
        const proto = ctrl.metatype!.prototype;
        for (const name of Object.getOwnPropertyNames(proto)) {
          const fn = proto[name];
          if (name === 'constructor' || typeof fn !== 'function' || Reflect.getMetadata(PATH_METADATA, fn) === undefined || Reflect.getMetadata(METHOD_METADATA, fn) === undefined) continue;
          routes++;
          const policy = Reflect.getMetadata(ACCESS_KEY, fn) ?? Reflect.getMetadata(ACCESS_KEY, ctrl.metatype!);
          if (!policy) missing.push(`${ctrl.metatype!.name}.${name}`);
        }
      }
    }
    await app.close();
    expect(routes).toBeGreaterThan(15);
    expect(missing).toEqual([]);
  });
});

describe('tenant isolation — HTTP', () => {
  let app: Awaited<ReturnType<typeof makeApp>>;
  let A: Awaited<ReturnType<typeof registerTenant>>, B: Awaited<ReturnType<typeof registerTenant>>;
  let aBranch: string, aRole: string, aMember: string;

  beforeAll(async () => {
    app = await makeApp();
    A = await registerTenant(app); B = await registerTenant(app);
    aBranch = (await A.client.post('/branches', { code: 'SECRET', name: 'A secret branch' })).body.id;
    aRole = (await A.client.post('/roles', { key: 'a_private', name: 'A private', permissions: [{ code: 'order.read', maxAmountMinor: null }] })).body.id;
    aMember = (await addStaff(A.client, 'cashier')).membershipId;
  });
  afterAll(async () => { await app.close(); });

  const denied = (r: any) => { expect([403, 404, 422], `got ${r.status}`).toContain(r.status); };

  it("B (a fully privileged owner) cannot read A's data via lists", async () => {
    const branches = (await B.client.get('/branches')).body.items as any[];
    expect(branches.map((b) => b.id)).not.toContain(aBranch);
    expect(JSON.stringify((await B.client.get('/roles')).body)).not.toContain(aRole);
    expect(JSON.stringify((await B.client.get('/members')).body)).not.toContain(aMember);
    const audit = JSON.stringify((await B.client.get('/audit-logs')).body);
    expect(audit).not.toContain(A.tenantId); expect(audit).not.toContain(aBranch);
  });

  it("B cannot modify A's branch, role or member by id", async () => {
    expect((await B.client.patch(`/branches/${aBranch}`, { name: 'pwned' })).status).toBe(404);
    expect((await B.client.put(`/roles/${aRole}/permissions`, { permissions: [] })).status).toBe(404);
    expect((await B.client.patch(`/members/${aMember}`, { status: 'suspended' })).status).toBe(404);
    expect((await A.client.get('/branches')).body.items.find((b: any) => b.id === aBranch).name).toBe('A secret branch');
  });

  it("B cannot attach A's objects to its own resources", async () => {
    denied(await B.client.post('/members', { email: 'x@example.test', fullName: 'X Y', roleId: aRole, temporaryPassword: 'correct-horse-battery' }));
    const bCashier = (await B.client.get('/roles')).body.items.find((r: any) => r.key === 'cashier').id;
    denied(await B.client.post('/members', { email: 'y@example.test', fullName: 'Y Z', roleId: bCashier, branchIds: [aBranch], temporaryPassword: 'correct-horse-battery' }));
    denied(await B.client.put('/config/weight.display_unit', { scope: 'branch', branchId: aBranch, value: 'lb' }));
    denied(await B.client.get(`/config/weight.display_unit?branchId=${aBranch}`));
  });

  it('cannot switch into a tenant without a membership', async () => {
    expect((await B.client.post('/auth/switch-tenant', { tenantId: A.tenantId })).status).toBe(404);
  });

  it('client-supplied tenant identifiers are ignored', async () => {
    const r = await (B.client as any).req('get', '/branches');
    const ids = (r.body.items as any[]).map((b) => b.id);
    expect(ids).not.toContain(aBranch);
    // spoof via header/query/body: still B's data
    const supertest = (await import('supertest')).default;
    const res = await supertest(app.getHttpServer()).get(`/branches?tenantId=${A.tenantId}`)
      .set('Cookie', Object.entries(B.client.cookies).map(([k, v]) => `${k}=${v}`).join('; ')).set('x-tenant-id', A.tenantId);
    expect((res.body.items as any[]).map((b) => b.id)).not.toContain(aBranch);
  });

  it('forged or foreign session cookies do not authenticate', async () => {
    const forged = new Client(app); forged.cookies = { eazy_sid: 'x'.repeat(43), eazy_csrf: 'y' };
    expect((await forged.get('/branches')).status).toBe(401);
  });

  it("an A-tenant staff member's session cannot reach B's data either", async () => {
    const staff = await addStaff(A.client, 'owner'); // holds branch.manage in A
    const bBranch = (await B.client.get('/branches')).body.items[0].id;
    expect((await staff.client.patch(`/branches/${bBranch}`, { name: 'pwned' })).status).toBe(404);
  });
});
