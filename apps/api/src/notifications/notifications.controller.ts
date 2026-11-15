import { Controller, Get, Inject, Query } from '@nestjs/common';
import { z } from 'zod';
import { Database } from '@eazy/database';
import { RequirePermission } from '../common/access.js';
import { CurrentActor } from '../common/current-actor.js';
import { dbCtx } from '../common/db-context.js';
import type { Actor } from '../common/types.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { DATABASE } from '../db/db.module.js';

const listQuery = z.object({
  orderId: z.string().uuid().optional(), customerId: z.string().uuid().optional(), status: z.enum(['queued', 'sending', 'sent', 'failed', 'logged', 'suppressed']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

@Controller('notifications')
export class NotificationsController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** What was (or was not) sent to customers. "logged" means no provider is configured and nothing left the system. */
  @Get()
  @RequirePermission('customer.read')
  list(@CurrentActor() a: Actor, @Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.db.withContext(dbCtx(a), async (tx) => {
      const where: string[] = []; const p: unknown[] = [];
      const add = (sql: string, v: unknown) => { p.push(v); where.push(sql.replace('?', `$${p.length}`)); };
      if (q.orderId) add('order_id = ?', q.orderId);
      if (q.customerId) add('customer_id = ?', q.customerId);
      if (q.status) add('status = ?', q.status);
      p.push(q.limit);
      const r = await tx.query(`SELECT id, template, to_address, subject, status, attempts, last_error, provider, created_at, sent_at FROM notifications
                                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT $${p.length}`, p);
      return { items: r.rows.map((n) => ({ id: n.id, template: n.template, to: n.to_address || null, subject: n.subject, status: n.status, attempts: n.attempts,
        error: n.last_error, provider: n.provider, createdAt: n.created_at, sentAt: n.sent_at })) };
    });
  }
}
