import { Controller, Get, Inject, Query } from '@nestjs/common';
import { z } from 'zod';
import { Database } from '@eazy/database';
import { RequirePermission } from '../common/access.js';
import { CurrentActor } from '../common/current-actor.js';
import type { Actor } from '../common/types.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { DATABASE } from '../db/db.module.js';
import { dbCtx } from '../common/db-context.js';

const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.string().datetime().optional() });

@Controller('audit-logs')
export class AuditController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get()
  @RequirePermission('audit.read')
  list(@CurrentActor() actor: Actor, @Query(new ZodPipe(q)) query: z.infer<typeof q>) {
    return this.db.withContext(dbCtx(actor), async (tx) => {
      const r = await tx.query(
        `SELECT id, actor_user_id, action, entity_type, entity_id, branch_id, detail, request_id, occurred_at
           FROM audit_logs WHERE ($1::timestamptz IS NULL OR occurred_at < $1)
          ORDER BY occurred_at DESC, id DESC LIMIT $2`, [query.before ?? null, query.limit]);
      return { items: r.rows };
    });
  }
}
