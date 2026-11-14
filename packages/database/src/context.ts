import pg from 'pg';

export interface DbContext {
  tenantId?: string;
  userId?: string;
  allBranches?: boolean;
  branchIds?: string[];
}

export type Tx = pg.PoolClient;

/** Thin wrapper over a pg Pool (connected as the non-owner app role). All access goes through withContext. */
export class Database {
  readonly pool: pg.Pool;
  constructor(connectionString: string, max = 10) {
    this.pool = new pg.Pool({ connectionString, max, statement_timeout: 15_000 });
  }

  /** Runs fn in a transaction with RLS context set via transaction-local settings (cannot leak across pooled connections). */
  async withContext<T>(ctx: DbContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true),
                set_config('app.all_branches', $3, true), set_config('app.branch_ids', $4, true)`,
        [ctx.tenantId ?? '', ctx.userId ?? '', ctx.allBranches ? 'true' : 'false', (ctx.branchIds ?? []).join(',')]);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  close() { return this.pool.end(); }
}
