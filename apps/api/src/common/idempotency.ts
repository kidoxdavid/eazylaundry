import { createHash } from 'node:crypto';
import type { Tx } from '@eazy/database';
import { AppError, badRequest } from './errors.js';

export const KEY_RE = /^[A-Za-z0-9_.:-]{8,100}$/;

export function requireKey(header: string | undefined): string {
  if (!header || !KEY_RE.test(header)) throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (8–100 characters: letters, digits, _ . : -)');
  return header;
}
export const hashRequest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/**
 * Runs `fn` at most once per (tenant, scope, key). A replay with the same payload returns the stored response;
 * the same key with a different payload is rejected. Concurrent duplicates serialise on the unique key and replay.
 * Must run inside the caller's tenant transaction so the key and the effect commit (or roll back) together.
 */
export async function once<T>(tx: Tx, tenantId: string, scope: string, key: string, requestHash: string, fn: () => Promise<T>): Promise<{ replayed: boolean; response: T }> {
  const ins = await tx.query(
    `INSERT INTO idempotency_keys (tenant_id, scope, key, request_hash) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING key`, [tenantId, scope, key, requestHash]);
  if (!ins.rowCount) {
    const row = (await tx.query(`SELECT request_hash, response FROM idempotency_keys WHERE tenant_id = $1 AND scope = $2 AND key = $3`, [tenantId, scope, key])).rows[0];
    if (row.request_hash !== requestHash) throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request');
    if (!row.response) throw new AppError(409, 'REQUEST_IN_PROGRESS', 'The original request is still being processed');
    return { replayed: true, response: row.response as T };
  }
  const response = await fn();
  await tx.query(`UPDATE idempotency_keys SET response = $4 WHERE tenant_id = $1 AND scope = $2 AND key = $3`, [tenantId, scope, key, JSON.stringify(response)]);
  return { replayed: false, response };
}
