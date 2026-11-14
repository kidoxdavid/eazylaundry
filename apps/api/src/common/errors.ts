import { HttpException } from '@nestjs/common';

/** Application error with a stable machine-readable code. */
export class AppError extends HttpException {
  constructor(status: number, public readonly code: string, message: string) {
    super({ code, message }, status);
  }
}
export const forbidden = (code: string, msg: string) => new AppError(403, code, msg);
export const notFound = (what: string) => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code: string, msg: string) => new AppError(409, code, msg);
export const unauthorized = (code = 'UNAUTHENTICATED', msg = 'Authentication required') => new AppError(401, code, msg);
export const badRequest = (code: string, msg: string) => new AppError(400, code, msg);
