import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, addStaff, makeApp, registerTenant } from './helpers.js';

describe('authorization & permission-escalation guards', () => {
  let app: Awaited<ReturnType<typeof makeApp>>;
  beforeAll(async () => { app = await makeApp(); });
  afterAll(async () => { await app.close(); });

  it('denies routes the role lacks, and role edits apply on the very next request', async () => {
    const T = await registerTenant(app);
    const cashier = await addStaff(T.client, 'cashier');
    expect((await cashier.client.get('/members')).status).toBe(403);
    expect((await cashier.client.get('/audit-logs')).status).toBe(403);
    expect((await cashier.client.get('/branches')).status).toBe(200);
    const roles = (await T.client.get('/roles')).body.items as any[];
    const cr = roles.find((r) => r.key === 'cashier');
    const without = cr.permissions.filter((p: any) => p.code !== 'branch.read');
    expect((await T.client.put(`/roles/${cr.id}/permissions`, { permissions: without })).status).toBe(200);
    const denied = await cashier.client.get('/branches');
    expect(denied.status).toBe(403); expect(denied.body.code).toBe('PERMISSION_DENIED');
  });

  it('nobody can grant authority they do not hold (roles)', async () => {
    const T = await registerTenant(app);
    const mgr = await addStaff(T.client, 'owner'); // sanity: owner clone can do everything
    void mgr;
    const lead = (await T.client.post('/roles', { key: 'lead', name: 'Lead', permissions: [
      { code: 'role.manage', maxAmountMinor: null }, { code: 'role.read', maxAmountMinor: null }, { code: 'member.manage', maxAmountMinor: null },
      { code: 'member.read', maxAmountMinor: null }, { code: 'discount.apply', maxAmountMinor: 5000 }] })).body.id;
    const staff = await addStaff(T.client, 'lead');
    void lead;
    const esc = await staff.client.post('/roles', { key: 'sneaky', name: 'Sneaky', permissions: [{ code: 'finance.manage', maxAmountMinor: null }] });
    expect(esc.status).toBe(403); expect(esc.body.code).toBe('ESCALATION');
    expect((await staff.client.post('/roles', { key: 'big', name: 'Big', permissions: [{ code: 'discount.apply', maxAmountMinor: 10000 }] })).status).toBe(403);
    expect((await staff.client.post('/roles', { key: 'unlimited', name: 'Unl', permissions: [{ code: 'discount.apply', maxAmountMinor: null }] })).status).toBe(403);
    expect((await staff.client.post('/roles', { key: 'ok', name: 'Fine', permissions: [{ code: 'discount.apply', maxAmountMinor: 5000 }] })).status).toBe(201);
    expect((await staff.client.post('/roles', { key: 'bogus', name: 'Bogus', permissions: [{ code: 'made.up', maxAmountMinor: null }] })).status).toBe(403);
  });

  it('nobody can hand out roles above their own or manage someone who outranks them', async () => {
    const T = await registerTenant(app);
    const roles = (await T.client.get('/roles')).body.items as any[];
    const ownerRole = roles.find((r) => r.key === 'owner').id;
    const mgr = await addStaff(T.client, 'branch_manager');
    const add = await mgr.client.post('/members', { email: `${Date.now()}@example.test`, fullName: 'Some One', roleId: ownerRole, temporaryPassword: PASSWORD });
    expect(add.status).toBe(403); expect(add.body.code).toBe('ESCALATION');
    const me = (await T.client.get('/auth/me')).body;
    const ownerMembership = ((await T.client.get('/members')).body.items as any[]).find((m) => m.email === me.user.email).id;
    const hit = await mgr.client.patch(`/members/${ownerMembership}`, { status: 'suspended' });
    expect(hit.status).toBe(403); expect(hit.body.code).toBe('OUTRANKED');
  });

  it('users cannot modify their own membership or own role', async () => {
    const T = await registerTenant(app);
    const ownerMembership = ((await T.client.get('/members')).body.items as any[])[0].id;
    const self = await T.client.patch(`/members/${ownerMembership}`, { status: 'suspended' });
    expect(self.status).toBe(403); expect(self.body.code).toBe('SELF_MODIFICATION');
    const ownerRole = ((await T.client.get('/roles')).body.items as any[]).find((r) => r.key === 'owner').id;
    expect((await T.client.put(`/roles/${ownerRole}/permissions`, { permissions: [] })).body.code).toBe('SELF_MODIFICATION');
    // a manager with role.manage cannot edit the role they themselves hold
    const roles = (await T.client.get('/roles')).body.items as any[];
    const adminRole = (await T.client.post('/roles', { key: 'admin2', name: 'Admin2', permissions: roles.find((r) => r.key === 'owner').permissions })).body.id;
    const admin = await addStaff(T.client, 'admin2');
    const res = await admin.client.put(`/roles/${adminRole}/permissions`, { permissions: roles.find((r) => r.key === 'owner').permissions });
    expect(res.status).toBe(403); expect(res.body.code).toBe('SELF_MODIFICATION');
  });

  it('a business can never be left without an active owner', async () => {
    const T = await registerTenant(app);
    const owner = roleOf(await T.client.get('/roles'), 'owner');
    const adminRole = (await T.client.post('/roles', { key: 'superadmin', name: 'Super', permissions: owner.permissions })).body.id;
    void adminRole;
    const admin = await addStaff(T.client, 'superadmin');
    const me = (await T.client.get('/auth/me')).body;
    const ownerMembership = ((await T.client.get('/members')).body.items as any[]).find((m) => m.email === me.user.email).id;
    const r = await admin.client.patch(`/members/${ownerMembership}`, { status: 'suspended' });
    expect(r.status).toBe(409); expect(r.body.code).toBe('LAST_OWNER');
    const r2 = await admin.client.patch(`/members/${ownerMembership}`, { roleId: roleOf(await T.client.get('/roles'), 'cashier').id });
    expect(r2.status).toBe(409);
  });

  it('branch-scoped staff only see and act on their branches and cannot widen scope', async () => {
    const T = await registerTenant(app);
    const b2 = (await T.client.post('/branches', { code: 'NORTH', name: 'North' })).body.id;
    const roles = (await T.client.get('/roles')).body.items as any[];
    const scoped = await addStaff(T.client, 'owner', { allBranches: false, branchIds: [b2] }); // owner-grade perms, one branch
    expect(((await scoped.client.get('/branches')).body.items as any[]).map((b) => b.id)).toEqual([b2]);
    expect((await scoped.client.patch(`/branches/${T.branchId}`, { name: 'Hijack' })).status).toBe(404);
    expect((await scoped.client.patch(`/branches/${b2}`, { name: 'North Renamed' })).status).toBe(200);
    const widen = await scoped.client.post('/members', { email: `${Date.now()}@example.test`, fullName: 'Wide Open', roleId: roles.find((r) => r.key === 'cashier').id,
      allBranches: true, temporaryPassword: PASSWORD });
    expect(widen.status).toBe(403); expect(widen.body.code).toBe('BRANCH_SCOPE');
    const other = await scoped.client.post('/members', { email: `${Date.now()}b@example.test`, fullName: 'Other Br', roleId: roles.find((r) => r.key === 'cashier').id,
      branchIds: [T.branchId], temporaryPassword: PASSWORD });
    expect(other.status).toBe(403);
  });

  it('every sensitive change is audited with actor and request id', async () => {
    const T = await registerTenant(app);
    await T.client.post('/branches', { code: 'AUD1', name: 'Audited' });
    const items = (await T.client.get('/audit-logs')).body.items as any[];
    const e = items.find((i) => i.action === 'branch.created');
    expect(e).toBeTruthy(); expect(e.request_id).toBeTruthy(); expect(e.actor_user_id).toBeTruthy();
    expect(items.map((i) => i.action)).toContain('tenant.registered');
  });
});

function roleOf(res: any, key: string) { return (res.body.items as any[]).find((r) => r.key === key); }
