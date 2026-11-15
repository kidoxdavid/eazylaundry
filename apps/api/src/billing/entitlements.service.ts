import { Injectable } from '@nestjs/common';
import type { Tx } from '@eazy/database';
import { AppError } from '../common/errors.js';

export const TRIAL_PLAN = 'business';
export const TRIAL_DAYS = 14;

/** Known entitlement keys and their value types. Plans and overrides are data; this is the vocabulary the code understands. */
export const ENTITLEMENT_KEYS = {
  'limit.branches': 'limit', 'limit.staff_seats': 'limit',
  'module.delivery': 'bool', 'module.storefront': 'bool', 'module.commercial': 'bool',
  'feature.reports': 'string',
} as const;
export type EntitlementKey = keyof typeof ENTITLEMENT_KEYS;

export function validEntitlementValue(key: string, v: unknown): boolean {
  const t = (ENTITLEMENT_KEYS as Record<string, string>)[key];
  if (t === 'limit') return v === null || (typeof v === 'number' && Number.isInteger(v) && v >= 0);
  if (t === 'bool') return typeof v === 'boolean';
  if (t === 'string') return typeof v === 'string' && v.length <= 40;
  return false;
}

export interface SubscriptionView {
  planId: string; planCode: string; planName: string; priceMinor: number | null; interval: string; currency: string;
  trialEndsAt: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; statusReason: string | null;
}

@Injectable()
export class EntitlementService {
  /** The tenant's subscription, created on first use as a trial (also covers businesses that existed before billing did). */
  async subscription(tx: Tx, tenantId: string): Promise<SubscriptionView> {
    const read = async () => (await tx.query(
      `SELECT s.trial_ends_at, s.current_period_end, s.cancel_at_period_end, s.status_reason, p.id AS plan_id, p.code, p.name, p.price_minor, p.billing_interval, p.currency
         FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id WHERE s.tenant_id = $1`, [tenantId])).rows[0];
    let r = await read();
    if (!r) {
      await tx.query(`INSERT INTO subscriptions (tenant_id, plan_id, trial_ends_at) SELECT $1, id, now() + make_interval(days => $3) FROM subscription_plans WHERE code = $2 ON CONFLICT DO NOTHING`, [tenantId, TRIAL_PLAN, TRIAL_DAYS]);
      r = await read();
    }
    return { planId: r.plan_id, planCode: r.code, planName: r.name, priceMinor: r.price_minor === null ? null : Number(r.price_minor), interval: r.billing_interval, currency: r.currency,
      trialEndsAt: r.trial_ends_at, currentPeriodEnd: r.current_period_end, cancelAtPeriodEnd: r.cancel_at_period_end, statusReason: r.status_reason };
  }

  /** Plan entitlements, overridden by any unexpired per-tenant override (an override always wins). */
  async effective(tx: Tx, tenantId: string): Promise<Record<string, any>> {
    const sub = await this.subscription(tx, tenantId);
    const out: Record<string, any> = {};
    for (const e of (await tx.query(`SELECT key, value FROM plan_entitlements WHERE plan_id = $1`, [sub.planId])).rows) out[e.key] = e.value;
    for (const o of (await tx.query(`SELECT key, value FROM tenant_entitlement_overrides WHERE expires_at IS NULL OR expires_at > now()`)).rows) out[o.key] = o.value;
    return out;
  }

  async usage(tx: Tx) {
    const one = async (sql: string) => Number((await tx.query(sql)).rows[0].n);
    return {
      branches: await one(`SELECT count(*) AS n FROM branches WHERE status = 'active'`),
      staffSeats: await one(`SELECT count(*) AS n FROM user_memberships WHERE status = 'active'`),
      ordersThisMonth: await one(`SELECT count(*) AS n FROM orders WHERE created_at >= date_trunc('month', now())`),
    };
  }

  /**
   * Blocks CREATING something beyond the limit. Existing records are never touched or hidden: a downgrade only stops new ones.
   * `current` is the count BEFORE the new item.
   */
  async assertLimit(tx: Tx, tenantId: string, key: 'limit.branches' | 'limit.staff_seats', current: number) {
    const limit = (await this.effective(tx, tenantId))[key];
    if (limit !== null && limit !== undefined && current >= limit) {
      throw new AppError(402, 'ENTITLEMENT_EXCEEDED', `Your plan allows ${limit} ${key === 'limit.branches' ? 'branch(es)' : 'staff member(s)'}. Upgrade your plan to add more.`);
    }
  }

  async hasModule(tx: Tx, tenantId: string, key: 'module.delivery' | 'module.storefront' | 'module.commercial') {
    return (await this.effective(tx, tenantId))[key] === true;
  }
  async assertModule(tx: Tx, tenantId: string, key: 'module.delivery' | 'module.storefront' | 'module.commercial') {
    if (!(await this.hasModule(tx, tenantId, key))) throw new AppError(402, 'ENTITLEMENT_REQUIRED', `${key.replace('module.', '').replace(/^./, (c) => c.toUpperCase())} is not included in your plan. Upgrade to use it.`);
  }
}
