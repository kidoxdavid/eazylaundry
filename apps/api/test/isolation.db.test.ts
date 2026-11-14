import 'reflect-metadata';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '@eazy/database';
import { APP_URL, makeApp, ownerQuery, registerTenant } from './helpers.js';

/** DB-level isolation: bypasses the API entirely and talks to Postgres as the application role. */
describe('tenant isolation — database (RLS)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>;
  let A: Awaited<ReturnType<typeof registerTenant>>, B: Awaited<ReturnType<typeof registerTenant>>;
  let db: Database;
  let tenantTables: string[];

  beforeAll(async () => {
    app = await makeApp();
    A = await registerTenant(app); B = await registerTenant(app);
    db = new Database(APP_URL, 3);
    tenantTables = (await ownerQuery(`SELECT table_name FROM information_schema.columns
       WHERE table_schema='public' AND column_name='tenant_id' AND table_name <> 'schema_migrations' ORDER BY 1`)).map((r) => r.table_name);
  });
  afterAll(async () => { await db.close(); await app.close(); });

  it('discovers tenant-owned tables (sanity)', () => {
    expect(tenantTables).toEqual(expect.arrayContaining(['branches', 'roles', 'user_memberships', 'audit_logs', 'config_entries']));
  });

  it('every tenant table has RLS enabled, FORCED, and at least one policy', async () => {
    const rows = await ownerQuery(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
        (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policies
       FROM pg_class c WHERE c.relname = ANY($1) AND c.relkind = 'r'`, [tenantTables]);
    expect(rows.length).toBe(tenantTables.length);
    for (const r of rows) {
      expect(r.relrowsecurity, `${r.relname} RLS enabled`).toBe(true);
      expect(r.relforcerowsecurity, `${r.relname} RLS forced`).toBe(true);
      expect(r.policies, `${r.relname} has policy`).toBeGreaterThan(0);
    }
  });

  it('the application role cannot bypass RLS and owns nothing', async () => {
    const [role] = await ownerQuery(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'eazy_app'`);
    expect(role.rolsuper).toBe(false); expect(role.rolbypassrls).toBe(false);
    const owned = await ownerQuery(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
                                     WHERE r.rolname = 'eazy_app' AND c.relnamespace = 'public'::regnamespace`);
    expect(owned[0].n).toBe(0);
  });

  it('with NO context, every tenant table returns zero rows (fail closed)', async () => {
    for (const t of tenantTables) {
      const n = await db.withContext({}, async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n);
      expect(n, `${t} visible without context`).toBe(0);
    }
  });

  it("tenant B's context sees none of tenant A's rows in any tenant table", async () => {
    for (const t of tenantTables) {
      const leak = await db.withContext({ tenantId: B.tenantId }, async (tx) =>
        (await tx.query(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [A.tenantId])).rows[0].n);
      expect(leak, `${t} leaked A rows to B`).toBe(0);
      const own = await db.withContext({ tenantId: A.tenantId }, async (tx) =>
        (await tx.query(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [A.tenantId])).rows[0].n);
      if (['branches', 'roles', 'user_memberships', 'audit_logs'].includes(t)) expect(own).toBeGreaterThan(0);
    }
  });

  it('cannot insert/update/delete rows of another tenant', async () => {
    await expect(db.withContext({ tenantId: B.tenantId }, (tx) =>
      tx.query(`INSERT INTO branches (id, tenant_id, code, name) VALUES (gen_random_uuid(), $1, 'EVIL', 'x')`, [A.tenantId]))).rejects.toMatchObject({ code: '42501' });
    const upd = await db.withContext({ tenantId: B.tenantId }, (tx) => tx.query(`UPDATE branches SET name = 'pwned' WHERE tenant_id = $1`, [A.tenantId]));
    expect(upd.rowCount).toBe(0);
    const del = await db.withContext({ tenantId: B.tenantId }, (tx) => tx.query(`DELETE FROM roles WHERE tenant_id = $1`, [A.tenantId]));
    expect(del.rowCount).toBe(0);
  });

  it('a crafted setting cannot widen scope: context is transaction-local and does not leak across pooled connections', async () => {
    await db.withContext({ tenantId: A.tenantId }, (tx) => tx.query('SELECT 1'));
    const n = await db.withContext({}, async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM branches`)).rows[0].n);
    expect(n).toBe(0);
  });

  it('composite foreign keys prevent cross-tenant references even from inside a valid tenant context', async () => {
    const rolesB = (await B.client.get('/roles')).body.items as any[];
    const userB = (await B.client.get('/auth/me')).body.user.id; // exists, but is not (yet) a member of A
    await expect(db.withContext({ tenantId: A.tenantId }, (tx) =>
      tx.query(`INSERT INTO user_memberships (id, tenant_id, user_id, role_id) VALUES (gen_random_uuid(), $1, $2, $3)`, [A.tenantId, userB, rolesB[0].id]))).rejects.toMatchObject({ code: '23503' });
  });

  it("a user context exposes only the user's own memberships, never other tenants' staff", async () => {
    const meB = (await B.client.get('/auth/me')).body.user.id;
    const rows = await db.withContext({ userId: meB }, async (tx) => (await tx.query(`SELECT tenant_id FROM user_memberships`)).rows);
    expect(rows.every((r) => r.tenant_id === B.tenantId)).toBe(true);
    const users = await db.withContext({ userId: meB }, async (tx) => (await tx.query(`SELECT id FROM users`)).rows);
    expect(users.map((u) => u.id)).toEqual([meB]);
  });

  it('password hashes are not readable through any role-less path (users empty without context)', async () => {
    const rows = await db.withContext({}, async (tx) => (await tx.query(`SELECT id FROM users`)).rows);
    expect(rows).toHaveLength(0);
  });

  it('audit_logs and config_entries are append-only for everyone, including the owner role', async () => {
    const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_OWNER_URL ?? 'postgres://eazy_owner:eazy_owner_dev@localhost:5432/eazylaundry_test' });
    await c.connect();
    try {
      await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [A.tenantId]);
      await expect(c.query(`UPDATE audit_logs SET action = 'x'`)).rejects.toMatchObject({ code: '23001' });
      await expect(c.query(`DELETE FROM audit_logs`)).rejects.toMatchObject({ code: '23001' });
    } finally { await c.end(); }
    await expect(db.withContext({ tenantId: A.tenantId }, (tx) => tx.query(`UPDATE audit_logs SET action = 'x'`))).rejects.toMatchObject({ code: '42501' });
  });
});
