import { Controller, Get, Inject } from '@nestjs/common';
import { Database } from '@eazy/database';
import { RequirePermission } from '../common/access.js';
import { CurrentActor } from '../common/current-actor.js';
import { dbCtx } from '../common/db-context.js';
import type { Actor } from '../common/types.js';
import { DATABASE } from '../db/db.module.js';
import { EntitlementService } from './entitlements.service.js';

@Controller('billing')
export class BillingController {
  constructor(@Inject(DATABASE) private readonly db: Database, @Inject(EntitlementService) private readonly ent: EntitlementService) {}

  /** The business's plan, lifecycle status, entitlements and how much of each limit it is using. */
  @Get()
  @RequirePermission('billing.read')
  get(@CurrentActor() a: Actor) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const sub = await this.ent.subscription(tx, a.tenantId!);
      const status = (await tx.query(`SELECT status FROM tenants WHERE id = $1`, [a.tenantId])).rows[0].status as string;
      const entitlements = await this.ent.effective(tx, a.tenantId!);
      const usage = await this.ent.usage(tx);
      const daysLeft = status === 'trial' && sub.trialEndsAt ? Math.max(0, Math.ceil((new Date(sub.trialEndsAt).getTime() - Date.now()) / 86_400_000)) : null;
      return { status, plan: { code: sub.planCode, name: sub.planName, priceMinor: sub.priceMinor, interval: sub.interval, currency: sub.currency }, trialEndsAt: sub.trialEndsAt, trialDaysLeft: daysLeft,
        currentPeriodEnd: sub.currentPeriodEnd, cancelAtPeriodEnd: sub.cancelAtPeriodEnd, statusReason: sub.statusReason, entitlements, usage,
        limits: { branches: entitlements['limit.branches'] ?? null, staffSeats: entitlements['limit.staff_seats'] ?? null } };
    });
  }
}
