import { PipeTransform } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';
import { AppError } from './errors.js';

export class ZodPipe<T extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: T) {}
  transform(value: unknown): z.infer<T> {
    const r = this.schema.safeParse(value);
    if (!r.success) {
      const issues = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      const e = new AppError(400, 'VALIDATION_ERROR', 'Invalid request');
      (e as any).issues = issues;
      throw e;
    }
    return r.data;
  }
}
