import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AppRequest } from './types.js';

export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<AppRequest>().actor;
});

export const CurrentCustomer = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<AppRequest>().customer;
});

export const CurrentPlatform = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<AppRequest>().platform;
});
