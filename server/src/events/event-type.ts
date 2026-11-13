import { z } from 'zod';

/**
 * An event type such as "invoice.paid" or "user:created".
 * Same rule as the messages.event_type CHECK in 001_init.sql: 1-100 chars, starts with a
 * letter or digit, then letters, digits, '.', '_', ':' or '-'. Used for published messages
 * (step 7) and for endpoint subscriptions, so a subscription can never name a type that
 * could not be published.
 */
export const eventTypeSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/,
    'must be 1-100 chars: letters, digits, ".", "_", ":" or "-", starting with a letter or digit',
  );
