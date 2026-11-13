import type { z } from 'zod';
import { AppError, formatZodIssues } from './errors.js';

export type InputLocation = 'body' | 'query' | 'params' | 'headers';

/**
 * Validate request input with a Zod schema (plan Q8: plain safeParse, no type provider).
 * Returns the parsed (typed, transformed) value or throws a 400 `validation_failed`
 * whose message names the failing fields, e.g. "body.event_type: Invalid input: expected string".
 */
export function parse<S extends z.ZodType>(schema: S, data: unknown, where: InputLocation): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new AppError(400, 'validation_failed', formatZodIssues(result.error, where));
  }
  return result.data;
}
