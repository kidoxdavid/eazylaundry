import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Database } from '@eazy/database';
import { uuidv7 } from '../common/ids.js';
import { APP_CONFIG, PLATFORM_DB } from '../common/tokens.js';
import type { AppConfig } from '../config.js';

export const GRACE_DAYS = 7;
const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';

/**
 * Moves businesses through their subscription lifecycle. Never deletes data: the worst outcome of non-payment is a read-only account
 * (suspended) and eventually cancellation, with the business's data kept for export.
 */
@Injectable()
export class LifecycleService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Lifecycle');
  private timer?: ReturnType<typeof setInterval>;
  constructor(@Inject(PLATFORM_DB) private readonly db: Database | null, @Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  onModuleInit() {
    if (this.db && this.cfg.workerIntervalMs > 0) {
      this.timer = setInterval(() => { this.run().catch((e) => this.log.error(`lifecycle run failed: ${e.message}`)); }, 3_600_000);
      this.timer.unref();
    }
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async run(actorUserId: string = SYSTEM_ACTOR): Promise<{ trialsEnded: string[]; graceExpired: string[]; cancelled: string[] }> {
    const db = this.db!;
    return db.withContext({}, async (tx) => {
      const audit = (action: string, tenantId: string, detail: Record<string, unknown>) =>
        tx.query(`INSERT INTO platform_audit_logs (id, actor_user_id, action, target_tenant_id, detail) VALUES ($1,$2,$3,$4,$5)`, [uuidv7(), actorUserId, action, tenantId, JSON.stringify(detail)]);
      const move = async (where: string, params: unknown[], status: string, reason: string, action: string) => {
        const rows = (await tx.query(`SELECT t.id FROM tenants t JOIN subscriptions s ON s.tenant_id = t.id WHERE ${where} FOR UPDATE OF t`, params)).rows;
        for (const r of rows) {
          await tx.query(`UPDATE tenants SET status = $2 WHERE id = $1`, [r.id, status]);
          await tx.query(`UPDATE subscriptions SET status_reason = $2, updated_at = now() WHERE tenant_id = $1`, [r.id, reason]);
          await audit(action, r.id, { to: status, reason });
        }
        return rows.map((r) => r.id as string);
      };
      return {
        // 1. a trial that ended without a plan becomes read-only (suspended), never deleted
        trialsEnded: await move(`t.status = 'trial' AND s.trial_ends_at < now()`, [], 'suspended', 'trial_ended', 'lifecycle.trial_ended'),
        // 2. a failed payment gets a grace period, then the account becomes read-only
        graceExpired: await move(`t.status = 'past_due' AND s.past_due_since < now() - make_interval(days => $1)`, [GRACE_DAYS], 'suspended', 'payment_overdue', 'lifecycle.grace_expired'),
        // 3. a cancellation requested for the end of the period takes effect
        cancelled: await move(`t.status IN ('active','past_due') AND s.cancel_at_period_end AND s.current_period_end < now()`, [], 'cancelled', 'cancelled_at_period_end', 'lifecycle.cancelled'),
      };
    });
  }
}
