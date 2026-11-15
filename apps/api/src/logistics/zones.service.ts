import { Injectable } from '@nestjs/common';
import type { Tx } from '@eazy/database';

export interface Zone { id: string; name: string; minOrderMinor: bigint; feeMinor: bigint; freeOverMinor: bigint | null; taxable: boolean }

/** Canadian postal code -> compact uppercase form used for prefix matching ("t5j 2r4" -> "T5J2R4"). */
export const compactPostal = (p: string) => p.replace(/\s+/g, '').toUpperCase();

@Injectable()
export class ZonesService {
  /** The active zone whose postal prefix matches best (longest prefix wins; ties go to the older zone). */
  async resolve(tx: Tx, postal: string): Promise<Zone | null> {
    const r = (await tx.query(
      `SELECT z.id, z.name, z.min_order_minor, z.fee_minor, z.free_over_minor, z.taxable,
              (SELECT max(length(p)) FROM unnest(z.postal_prefixes) p WHERE $1 LIKE p || '%') AS match_len
         FROM delivery_zones z WHERE z.active AND EXISTS (SELECT 1 FROM unnest(z.postal_prefixes) p WHERE $1 LIKE p || '%')
        ORDER BY match_len DESC, z.created_at, z.id LIMIT 1`, [compactPostal(postal)])).rows[0];
    return r ? { id: r.id, name: r.name, minOrderMinor: BigInt(r.min_order_minor), feeMinor: BigInt(r.fee_minor), freeOverMinor: r.free_over_minor === null ? null : BigInt(r.free_over_minor), taxable: r.taxable } : null;
  }

  /** Fee for an order whose services subtotal (before discount and tax) is `subtotalMinor`. */
  feeFor(zone: Zone, subtotalMinor: bigint) {
    const free = zone.freeOverMinor !== null && subtotalMinor >= zone.freeOverMinor;
    return { amountMinor: free ? 0n : zone.feeMinor, free, belowMinimum: subtotalMinor < zone.minOrderMinor };
  }
}
