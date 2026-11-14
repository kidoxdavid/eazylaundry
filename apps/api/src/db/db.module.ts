import { Global, Module } from '@nestjs/common';
import { Database } from '@eazy/database';
import { APP_CONFIG } from '../common/tokens.js';
import type { AppConfig } from '../config.js';

export const DATABASE = 'DATABASE';

@Global()
@Module({
  providers: [{ provide: DATABASE, inject: [APP_CONFIG], useFactory: (c: AppConfig) => new Database(c.databaseUrl) }],
  exports: [DATABASE],
})
export class DbModule {}
