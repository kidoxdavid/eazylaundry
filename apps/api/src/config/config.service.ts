import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { Tx } from '@eazy/database';

/** Registry of configurable keys: schema + default. Resolution: branch override > tenant override > default. */
export const CONFIG_REGISTRY = {
  'tax.price_mode': { schema: z.enum(['exclusive', 'inclusive']), default: 'exclusive' },
  'tax.rounding_level': { schema: z.enum(['line', 'order']), default: 'line' },
  /** When true, cash can only be taken into an open till (shift). Safer default for staffed counters. */
  'cash.require_shift': { schema: z.boolean(), default: true },
  'weight.display_unit': { schema: z.enum(['kg', 'lb']), default: 'kg' },
} as const;
export type ConfigKey = keyof typeof CONFIG_REGISTRY;
export const isConfigKey = (k: string): k is ConfigKey => k in CONFIG_REGISTRY;

@Injectable()
export class ConfigService {
  /** Resolves a key for a tenant (and optional branch) inside the caller's tenant-scoped transaction. */
  async resolve<K extends ConfigKey>(tx: Tx, tenantId: string, key: K, branchId?: string):
    Promise<{ value: z.infer<(typeof CONFIG_REGISTRY)[K]['schema']>; source: 'branch' | 'tenant' | 'default'; version: number }> {
    const latest = async (scope: string, scopeId: string) => (await tx.query(
      `SELECT value, version FROM config_entries WHERE scope = $1 AND scope_id = $2 AND key = $3 AND effective_from <= now()
        ORDER BY version DESC LIMIT 1`, [scope, scopeId, key])).rows[0];
    if (branchId) { const b = await latest('branch', branchId); if (b) return { value: b.value, source: 'branch', version: b.version }; }
    const t = await latest('tenant', tenantId);
    if (t) return { value: t.value, source: 'tenant', version: t.version };
    return { value: CONFIG_REGISTRY[key].default as any, source: 'default', version: 0 };
  }
}
