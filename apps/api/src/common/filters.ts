import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import type { AppRequest } from './types.js';

/** RFC 7807-style errors. Never leaks SQL or stack details to clients. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('Errors');
  catch(ex: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<AppRequest>();
    let status = 500, code = 'INTERNAL_ERROR', title = 'Internal server error', issues: unknown;

    if (ex instanceof HttpException) {
      status = ex.getStatus();
      const body = ex.getResponse() as any;
      code = body?.code ?? (status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR');
      title = typeof body === 'string' ? body : body?.message ?? ex.message;
      issues = (ex as any).issues;
    } else if (typeof (ex as any)?.code === 'string' && /^[0-9A-Z]{5}$/.test((ex as any).code)) {
      const pg = (ex as any).code as string;
      if (pg === '23505') { status = 409; code = 'CONFLICT'; title = 'Resource already exists'; }
      else if (pg === '23503') { status = 422; code = 'INVALID_REFERENCE'; title = 'Referenced resource is invalid'; }
      else if (pg === '23514' || pg === '22P02') { status = 400; code = 'INVALID_VALUE'; title = 'Invalid value'; }
      else if (pg === '42501') { status = 403; code = 'FORBIDDEN'; title = 'Not permitted'; }
      else if (pg === '40001' || pg === '40P01') { status = 409; code = 'RETRY'; title = 'Concurrent update, please retry'; }
      else { this.log.error(`db error ${pg}: ${(ex as Error).message}`); }
    } else {
      this.log.error((ex as Error)?.stack ?? String(ex));
    }
    res.status(status).type('application/problem+json').json({
      type: `urn:eazylaundry:error:${code.toLowerCase()}`, title, status, code, issues, requestId: req.requestId,
    });
  }
}
