import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import pg from 'pg';
import { APP_CONFIG } from '../common/tokens.js';
import type { AppConfig } from '../config.js';
import { PermanentSendError, SmtpProvider, type EmailProvider } from './providers.js';

export const MAX_ATTEMPTS = 5;
/** Minutes to wait before attempt n+1 (attempt 1 failed -> 1 min, then 2, 4, 8). */
export const backoffMinutes = (attempts: number) => 2 ** Math.max(0, attempts - 1);

/**
 * Background delivery of queued notifications. Connects as the least-privilege `eazy_worker` role, which can only read and
 * progress rows in `notifications` (no tenant data). Safe to run in several processes: rows are claimed with SKIP LOCKED.
 */
@Injectable()
export class NotificationsWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Notifications');
  private pool?: pg.Pool;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  readonly provider: EmailProvider | null;

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {
    this.provider = cfg.smtpUrl ? new SmtpProvider(cfg.smtpUrl) : null;
    if (cfg.workerDatabaseUrl) this.pool = new pg.Pool({ connectionString: cfg.workerDatabaseUrl, max: 2 });
  }

  onModuleInit() {
    if (this.pool && this.cfg.workerIntervalMs > 0) {
      this.timer = setInterval(() => { this.runOnce().catch((e) => this.log.error(`worker run failed: ${e.message}`)); }, this.cfg.workerIntervalMs);
      this.timer.unref();
      if (!this.provider) this.log.warn('No SMTP_URL configured: emails are recorded as "logged" and are NOT delivered');
    }
  }
  async onModuleDestroy() { if (this.timer) clearInterval(this.timer); await this.pool?.end(); }

  /** Processes up to `limit` due notifications. Returns how many were handled. */
  async runOnce(limit = 20): Promise<number> {
    if (!this.pool || this.running) return 0;
    this.running = true;
    try {
      // Recover rows stuck in 'sending' (worker crashed mid-send).
      await this.pool.query(`UPDATE notifications SET status = 'queued' WHERE status = 'sending' AND next_attempt_at < now() - interval '5 minutes'`);
      const claimed = (await this.pool.query(
        `UPDATE notifications SET status = 'sending', attempts = attempts + 1, next_attempt_at = now()
          WHERE id IN (SELECT id FROM notifications WHERE status = 'queued' AND next_attempt_at <= now() ORDER BY next_attempt_at, created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
          RETURNING *`, [limit])).rows;
      for (const n of claimed) await this.deliver(n);
      return claimed.length;
    } finally { this.running = false; }
  }

  private async deliver(n: any) {
    if (!this.provider) {
      // Honest status: nothing was sent. Staff can see this in the notification list.
      await this.pool!.query(`UPDATE notifications SET status = 'logged', provider = 'log', last_error = 'No email provider configured; message was not delivered' WHERE id = $1`, [n.id]); // content kept: nothing left the system
      return;
    }
    try {
      const { ref } = await this.provider.send({ from: this.cfg.mailFrom, to: n.to_address, subject: n.subject, text: n.body_text, html: n.body_html ?? undefined });
      await this.pool!.query(`UPDATE notifications SET status = 'sent', provider = $2, provider_ref = $3, sent_at = now(), last_error = NULL, ${this.redact(n)} WHERE id = $1`, [n.id, this.provider.name, ref]);
    } catch (e: any) {
      const permanent = e instanceof PermanentSendError || n.attempts >= MAX_ATTEMPTS;
      await this.pool!.query(
        `UPDATE notifications SET status = $2, last_error = $3, provider = $4, next_attempt_at = now() + make_interval(mins => $5) WHERE id = $1`,
        [n.id, permanent ? 'failed' : 'queued', String(e.message ?? e).slice(0, 300), this.provider.name, backoffMinutes(n.attempts)]);
    }
  }

  /** Messages carrying secrets (delivery codes, login links) are scrubbed once handled. */
  private redact(n: any) {
    return n.sensitive ? `body_text = '[content removed after sending]', body_html = NULL` : 'body_text = body_text';
  }
}
