import { describe, expect, it } from 'vitest';
import { ALL_PERMISSION_CODES, PERMISSIONS, ROLE_TEMPLATES } from '../src/permissions.js';

describe('permission catalogue', () => {
  it('has unique, well-formed codes', () => {
    expect(new Set(ALL_PERMISSION_CODES).size).toBe(ALL_PERMISSION_CODES.length);
    for (const p of PERMISSIONS) expect(p.code).toMatch(/^[a-z]+(\.[a-z]+)+$/);
  });
  it('role templates only reference known permissions', () => {
    for (const t of ROLE_TEMPLATES) for (const c of t.permissions) expect(ALL_PERMISSION_CODES, `${t.key}: ${c}`).toContain(c);
  });
  it('owner holds every permission and no other template holds role/tenant administration', () => {
    expect(ROLE_TEMPLATES.find((t) => t.key === 'owner')!.permissions.sort()).toEqual([...ALL_PERMISSION_CODES].sort());
    for (const t of ROLE_TEMPLATES.filter((t) => t.key !== 'owner')) {
      expect(t.permissions).not.toContain('role.manage');
      expect(t.permissions).not.toContain('tenant.settings.manage');
    }
  });
});
