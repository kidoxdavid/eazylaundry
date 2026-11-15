import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Response } from 'express';
import { AUTH_THROTTLE_KEY } from './common/access.js';
import { AuditController } from './audit/audit.controller.js';
import { AuditService } from './audit/audit.service.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthService } from './auth/auth.service.js';
import { PasswordService } from './auth/password.service.js';
import { SessionService } from './auth/session.service.js';
import { AllExceptionsFilter } from './common/filters.js';
import { FieldCipher } from './common/crypto.js';
import { APP_CONFIG, FIELD_CIPHER } from './common/tokens.js';
import type { AppRequest } from './common/types.js';
import { ConfigController } from './config/config.controller.js';
import { ConfigService } from './config/config.service.js';
import type { AppConfig } from './config.js';
import { DbModule } from './db/db.module.js';
import { HealthController } from './health.controller.js';
import { AuthorizationService } from './iam/authorization.service.js';
import { MembersController } from './iam/members.controller.js';
import { RolesController } from './iam/roles.controller.js';
import { CatalogueController } from './catalogue/catalogue.controller.js';
import { OrdersController } from './orders/orders.controller.js';
import { ProductionController } from './production/production.controller.js';
import { WorkflowService } from './production/workflow.service.js';
import { CashController } from './cash/cash.controller.js';
import { RefundsController } from './cash/refunds.controller.js';
import { LogisticsController } from './logistics/logistics.controller.js';
import { TasksService } from './logistics/tasks.service.js';
import { ZonesService } from './logistics/zones.service.js';
import { PricingController } from './pricing/pricing.controller.js';
import { PricingService } from './pricing/pricing.service.js';
import { CustomersController } from './customers/customers.controller.js';
import { BranchesController } from './tenancy/branches.controller.js';
import { TenantsService } from './tenancy/tenants.service.js';

export function buildAppModule(cfg: AppConfig) {
  @Global()
  @Module({
    imports: [DbModule, ThrottlerModule.forRoot([
      { name: 'default', ttl: 60_000, limit: cfg.throttleLimit },
      { name: 'auth', ttl: 60_000, limit: cfg.authThrottleLimit, skipIf: (ctx) => !Reflect.getMetadata(AUTH_THROTTLE_KEY, ctx.getHandler()) },
    ])],
    controllers: [HealthController, AuthController, BranchesController, RolesController, MembersController, ConfigController, AuditController, CustomersController, CatalogueController, PricingController, OrdersController, ProductionController, CashController, RefundsController, LogisticsController],
    providers: [
      { provide: APP_CONFIG, useValue: cfg },
      { provide: FIELD_CIPHER, useValue: new FieldCipher(cfg.encryptionSecret) },
      AuditService, ConfigService, PricingService, WorkflowService, ZonesService, TasksService, AuthService, PasswordService, SessionService, TenantsService, AuthorizationService,
      { provide: APP_GUARD, useClass: ThrottlerGuard },
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
    exports: [APP_CONFIG],
  })
  class AppModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
      consumer.apply((req: AppRequest, res: Response, next: NextFunction) => {
        req.requestId = (req.headers['x-request-id'] as string)?.slice(0, 64) || randomUUID();
        res.setHeader('x-request-id', req.requestId);
        next();
      }).forRoutes('*');
    }
  }
  return AppModule;
}
