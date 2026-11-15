import { Inject, Injectable } from '@nestjs/common';
import type { Tx } from '@eazy/database';
import { uuidv7 } from '../common/ids.js';
import { APP_CONFIG } from '../common/tokens.js';
import type { AppConfig } from '../config.js';
import { render } from './templates.js';

export interface EnqueueInput {
  tenantId: string; template: string; to: string | null; vars: Record<string, string | number | undefined | null>;
  customerId?: string; orderId?: string; taskId?: string; dedupeKey?: string;
}

/** Writes notifications into the outbox INSIDE the business transaction, so a message exists if and only if the change committed. */
@Injectable()
export class NotificationsService {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  /** Business name + storefront base URL for links in messages. */
  async brand(tx: Tx): Promise<{ business: string; slug: string; base: string }> {
    const r = (await tx.query(`SELECT o.legal_name, t.slug FROM organizations o JOIN tenants t ON t.id = o.tenant_id LIMIT 1`)).rows[0];
    return { business: r.legal_name, slug: r.slug, base: `${this.cfg.publicWebUrl}/b/${r.slug}` };
  }

  /** Returns false when an identical notification (same dedupe key) was already queued. */
  async enqueue(tx: Tx, p: EnqueueInput): Promise<boolean> {
    const brand = await this.brand(tx);
    const r = render(p.template, { business: brand.business, ...p.vars });
    const suppressed = !p.to;
    const ins = await tx.query(
      `INSERT INTO notifications (id, tenant_id, customer_id, order_id, task_id, template, to_address, subject, body_text, body_html, sensitive, status, last_error, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING RETURNING id`,
      [uuidv7(), p.tenantId, p.customerId ?? null, p.orderId ?? null, p.taskId ?? null, p.template, p.to ?? '', r.subject, r.text, r.html, r.sensitive,
       suppressed ? 'suppressed' : 'queued', suppressed ? 'No email address on file' : null, p.dedupeKey ?? null]);
    return !!ins.rowCount;
  }
}
