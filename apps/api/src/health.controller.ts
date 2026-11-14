import { Controller, Get, Inject } from '@nestjs/common';
import { Database } from '@eazy/database';
import { Public } from './common/access.js';
import { DATABASE } from './db/db.module.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  @Get()
  @Public()
  async health() {
    await this.db.pool.query('SELECT 1');
    return { status: 'ok' };
  }
}
