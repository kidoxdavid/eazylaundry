import { Inject, Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import type { Tx } from '@eazy/database';
import { z } from 'zod';
import { AppError } from '../common/errors.js';
import { FieldCipher } from '../common/crypto.js';
import { uuidv7 } from '../common/ids.js';
import { FIELD_CIPHER } from '../common/tokens.js';
import type { Actor } from '../common/types.js';

/** Time window for a pickup/delivery: ISO timestamps, at most 12 hours long, not already long past. */
export const windowSchema = z.object({ start: z.string().datetime(), end: z.string().datetime() }).superRefine((w, ctx) => {
  const s = Date.parse(w.start), e = Date.parse(w.end);
  if (!(e > s)) ctx.addIssue({ code: 'custom', path: ['end'], message: 'The window must end after it starts' });
  else if (e - s > 12 * 3600_000) ctx.addIssue({ code: 'custom', path: ['end'], message: 'A window can be at most 12 hours' });
  else if (e < Date.now() - 3600_000) ctx.addIssue({ code: 'custom', path: ['start'], message: 'The window is in the past' });
});

export interface NewTask {
  branchId: string; kind: 'pickup' | 'delivery'; orderId: string | null; customerId: string; zoneId: string | null;
  window: { start: string; end: string }; address: Record<string, unknown>; postalCode: string; contactName: string; contactPhone: string | null;
  notes: string | null; feeMinor: bigint;
}

@Injectable()
export class TasksService {
  constructor(@Inject(FIELD_CIPHER) private readonly cipher: FieldCipher) {}

  async event(tx: Tx, a: Actor, t: { id: string; branch_id: string }, type: string, payload: Record<string, unknown> = {}, note?: string) {
    await tx.query(`INSERT INTO delivery_events (id, tenant_id, branch_id, task_id, type, actor_user_id, note, payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [uuidv7(), a.tenantId, t.branch_id, t.id, type, a.userId, note ?? null, JSON.stringify(payload)]);
  }

  newOtp() { return String(randomInt(0, 1_000_000)).padStart(6, '0'); }
  seal(otp: string) { return this.cipher.encrypt(otp); }
  reveal(enc: string | null) { return enc ? this.cipher.decrypt(enc) : null; }

  async create(tx: Tx, a: Actor, p: NewTask): Promise<{ id: string; otp: string | null }> {
    const id = uuidv7();
    const otp = p.kind === 'delivery' ? this.newOtp() : null;
    try {
      await tx.query('SAVEPOINT task');
      await tx.query(
        `INSERT INTO delivery_tasks (id, tenant_id, branch_id, kind, order_id, customer_id, zone_id, window_start, window_end, address, postal_code, contact_name, contact_phone, notes, fee_minor, otp_enc, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [id, a.tenantId, p.branchId, p.kind, p.orderId, p.customerId, p.zoneId, p.window.start, p.window.end, JSON.stringify(p.address), p.postalCode, p.contactName, p.contactPhone, p.notes,
         p.feeMinor, otp ? this.seal(otp) : null, a.userId]);
    } catch (e: any) {
      await tx.query('ROLLBACK TO SAVEPOINT task');
      if (e.code === '23505' && /one_live_delivery/.test(e.constraint ?? '')) throw new AppError(409, 'DELIVERY_EXISTS', 'This order already has a delivery scheduled');
      throw e;
    }
    await this.event(tx, a, { id, branch_id: p.branchId }, 'task.created', { kind: p.kind, windowStart: p.window.start, windowEnd: p.window.end, feeMinor: Number(p.feeMinor) });
    return { id, otp };
  }
}
