import pg from 'pg';
import { migrate } from '@eazy/database';

export const OWNER_URL = process.env.TEST_DATABASE_OWNER_URL ?? 'postgres://eazy_owner:eazy_owner_dev@localhost:5432/eazylaundry_test';
export const APP_URL = process.env.TEST_DATABASE_URL ?? 'postgres://eazy_app:eazy_app_dev@localhost:5432/eazylaundry_test';

/** Rebuilds the test schema from scratch every run, proving migrations apply cleanly on an empty database. */
export default async function setup() {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  await c.query('DROP OWNED BY eazy_owner CASCADE');
  await c.end();
  await migrate(OWNER_URL);
}
