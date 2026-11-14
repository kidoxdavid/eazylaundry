import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AppRequest } from './types.js';

export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<AppRequest>().actor;
});
