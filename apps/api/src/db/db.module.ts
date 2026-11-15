import { Global, Module } from '@nestjs/common';
import { Database } from '@eazy/database';
import { APP_CONFIG, PLATFORM_DB } from '../common/tokens.js';
import type { AppConfig } from '../config.js';

export const DATABASE = 'DATABASE';

@Global()
@Module({
  providers: [
    { provide: DATABASE, inject: [APP_CONFIG], useFactory: (c: AppConfig) => new Database(c.databaseUrl) },
    { provide: PLATFORM_DB, inject: [APP_CONFIG], useFactory: (c: AppConfig) => (c.platformDatabaseUrl ? new Database(c.platformDatabaseUrl, 4) : null) },
  ],
  exports: [DATABASE, PLATFORM_DB],
})
export class DbModule {}
