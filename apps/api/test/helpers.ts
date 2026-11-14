import 'reflect-metadata';
import request from 'supertest';
import pg from 'pg';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApp } from '../src/app.factory.js';
import { loadConfig } from '../src/config.js';
import { APP_URL, OWNER_URL } from './global-setup.js';

export const PASSWORD = 'correct-horse-battery';

export async function makeApp(over: Record<string, string> = {}) {
  const cfg = loadConfig({
    DATABASE_URL: APP_URL, NODE_ENV: 'test', APP_ENCRYPTION_SECRET: 'test-secret', THROTTLE_LIMIT: '100000',
    AUTH_THROTTLE_LIMIT: '100000', ...over,
  } as any);
  const app = await createApp(cfg);
  await app.init();
  return app;
}

/** Cookie-jar aware client that also sends the CSRF header automatically. */
export class Client {
  cookies: Record<string, string> = {};
  constructor(readonly app: NestExpressApplication) {}
  private header() {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  private absorb(res: request.Response) {
    for (const c of res.headers['set-cookie'] ?? []) {
      const [pair] = c.split(';'); const i = pair.indexOf('=');
      const k = pair.slice(0, i), v = pair.slice(i + 1);
      if (/Expires=Thu, 01 Jan 1970/i.test(c)) delete this.cookies[k]; else this.cookies[k] = v;
    }
    return res;
  }
  req(method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: unknown, opts: { csrf?: boolean } = {}) {
    let r = (request(this.app.getHttpServer()) as any)[method](url).set('Cookie', this.header());
    if (opts.csrf !== false && this.cookies.eazy_csrf) r = r.set('x-csrf-token', this.cookies.eazy_csrf);
    if (body !== undefined) r = r.send(body);
    return r.then((res: request.Response) => this.absorb(res));
  }
  get = (u: string) => this.req('get', u);
  post = (u: string, b?: unknown) => this.req('post', u, b ?? {});
  put = (u: string, b?: unknown) => this.req('put', u, b ?? {});
  patch = (u: string, b?: unknown) => this.req('patch', u, b ?? {});
}

let n = 0;
export const uniq = (p: string) => `${p}${Date.now().toString(36)}${(n++).toString(36)}`;

export async function registerTenant(app: NestExpressApplication, name = uniq('Biz')) {
  const c = new Client(app);
  const email = `${uniq('owner')}@example.test`;
  const res = await c.post('/auth/register', { businessName: name, ownerName: 'Olivia Owner', email, password: PASSWORD, branchCode: 'MAIN' });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { client: c, email, tenantId: res.body.tenantId as string, branchId: res.body.branchId as string, slug: res.body.slug as string };
}

/** Owner adds a staff member with a role key, returns a logged-in client. */
export async function addStaff(owner: Client, roleKey: string, opts: { allBranches?: boolean; branchIds?: string[]; keepTemporaryPassword?: boolean } = {}) {
  const roles = (await owner.get('/roles')).body.items as any[];
  const role = roles.find((r) => r.key === roleKey);
  const email = `${uniq(roleKey)}@example.test`;
  const res = await owner.post('/members', { email, fullName: `${roleKey} person`, roleId: role.id, allBranches: opts.allBranches ?? true,
    branchIds: opts.branchIds ?? [], temporaryPassword: PASSWORD });
  if (res.status !== 201) throw new Error(`addStaff failed: ${res.status} ${JSON.stringify(res.body)}`);
  const c = new Client(owner.app);
  const l = await c.post('/auth/login', { email, password: PASSWORD });
  if (l.status !== 200) throw new Error(`login failed ${l.status}`);
  if (!opts.keepTemporaryPassword) {
    const ch = await c.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: `${PASSWORD}-changed` });
    if (ch.status !== 204) throw new Error(`change-password failed ${ch.status}`);
  }
  return { client: c, email, membershipId: res.body.id as string, roleId: role.id as string };
}

export async function ownerQuery<T = any>(sql: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  try { return (await c.query(sql, params)).rows as T[]; } finally { await c.end(); }
}
export { APP_URL, OWNER_URL };
