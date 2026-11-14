import { Inject, Injectable } from '@nestjs/common';
import type { Tx } from '@eazy/database';
import { uuidv7 } from '../common/ids.js';
import type { Actor } from '../common/types.js';

export interface AuditEvent {
  action: string;
  entityType: string;
  entityId?: string;
  branchId?: string;
  detail?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  /** Writes inside the caller's transaction so the audit row commits atomically with the change. */
  async record(tx: Tx, actor: Pick<Actor, 'tenantId' | 'userId' | 'membershipId' | 'ip' | 'requestId'>, e: AuditEvent) {
    await tx.query(
      `INSERT INTO audit_logs (id, tenant_id, actor_user_id, actor_membership_id, action, entity_type, entity_id,
                              branch_id, detail, ip, request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [uuidv7(), actor.tenantId, actor.userId, actor.membershipId ?? null, e.action, e.entityType, e.entityId ?? null,
       e.branchId ?? null, JSON.stringify(e.detail ?? {}), actor.ip ?? null, actor.requestId ?? null]);
  }
}
