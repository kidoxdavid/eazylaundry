import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Tx } from '@eazy/database';
import { uuidv7 } from '../common/ids.js';

export interface StageRow {
  id: string; key: string; name: string; sequence: number; requiredPermission: string; expectedMinutes: number;
  optional: boolean; isQc: boolean; isTerminal: boolean; orderStatus: 'open' | 'ready' | 'completed';
}

/**
 * Default stage set, seeded per business as editable DATA (never consulted at runtime — the database rows are).
 * required_permission = permission needed to COMPLETE the stage (move the order on from it).
 */
export const DEFAULT_STAGES = [
  { key: 'received', name: 'Order received', perm: 'order.create', minutes: 15 },
  { key: 'intake', name: 'Intake inspection', perm: 'order.create', minutes: 15 },
  { key: 'sorting', name: 'Sorting', perm: 'production.advance', minutes: 30 },
  { key: 'washing', name: 'Washing', perm: 'production.advance', minutes: 60 },
  { key: 'drying', name: 'Drying', perm: 'production.advance', minutes: 60 },
  { key: 'ironing', name: 'Ironing / steaming', perm: 'production.advance', minutes: 45, optional: true },
  { key: 'folding', name: 'Folding', perm: 'production.advance', minutes: 30 },
  { key: 'quality_control', name: 'Quality control', perm: 'production.qc', minutes: 20, qc: true },
  { key: 'packaging', name: 'Packaging', perm: 'production.advance', minutes: 15 },
  { key: 'ready', name: 'Ready for collection', perm: 'order.create', minutes: 0, status: 'ready' as const },
  { key: 'handed_over', name: 'Handed over', perm: 'order.create', minutes: 0, terminal: true, status: 'completed' as const },
];

/** Suggested rework targets per failure reason (a starting point; inspectors can choose any earlier stage). */
export const REASON_CODES: { code: string; label: string; defaultStageKey: string | null }[] = [
  { code: 'stain_remains', label: 'Stain remains', defaultStageKey: 'washing' },
  { code: 'odour', label: 'Odour', defaultStageKey: 'washing' },
  { code: 'wrinkles', label: 'Wrinkles / pressing', defaultStageKey: 'ironing' },
  { code: 'fold_issue', label: 'Folding issue', defaultStageKey: 'folding' },
  { code: 'damage', label: 'Damage found', defaultStageKey: null },
  { code: 'missing_item', label: 'Missing item', defaultStageKey: null },
  { code: 'other', label: 'Other', defaultStageKey: null },
];

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U (unambiguous when printed)
export const SCAN_TOKEN_RE = /^[0-9A-HJKMNP-TV-Z]{10}$/;
export function newScanToken(): string {
  const b = randomBytes(10);
  return Array.from(b, (x) => ALPHABET[x % 32]).join('');
}

const mapStage = (r: any): StageRow => ({
  id: r.id, key: r.key, name: r.name, sequence: r.sequence, requiredPermission: r.required_permission, expectedMinutes: r.expected_minutes,
  optional: r.optional, isQc: r.is_qc, isTerminal: r.is_terminal, orderStatus: r.order_status,
});

@Injectable()
export class WorkflowService {
  /** Returns the tenant's default workflow, creating it on first use (also covers businesses created before workflows existed). */
  async ensureDefault(tx: Tx, tenantId: string): Promise<{ definitionId: string; stages: StageRow[] }> {
    let def = (await tx.query(`SELECT id FROM workflow_definitions WHERE is_default`)).rows[0];
    if (!def) {
      const id = uuidv7();
      const ins = await tx.query(`INSERT INTO workflow_definitions (id, tenant_id, name, is_default) VALUES ($1,$2,'Standard laundry workflow',true)
                                  ON CONFLICT DO NOTHING RETURNING id`, [id, tenantId]);
      if (ins.rowCount) {
        let seq = 0;
        for (const s of DEFAULT_STAGES) {
          await tx.query(
            `INSERT INTO workflow_stages (id, tenant_id, definition_id, key, name, sequence, required_permission, expected_minutes, optional, is_qc, is_terminal, order_status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [uuidv7(), tenantId, id, s.key, s.name, ++seq, s.perm, s.minutes, !!(s as any).optional, !!(s as any).qc, !!(s as any).terminal, (s as any).status ?? 'open']);
        }
      }
      def = (await tx.query(`SELECT id FROM workflow_definitions WHERE is_default`)).rows[0];
    }
    return { definitionId: def.id, stages: await this.stages(tx, def.id) };
  }

  async stages(tx: Tx, definitionId: string): Promise<StageRow[]> {
    const r = await tx.query(`SELECT * FROM workflow_stages WHERE definition_id = $1 ORDER BY sequence`, [definitionId]);
    return r.rows.map(mapStage);
  }
}
