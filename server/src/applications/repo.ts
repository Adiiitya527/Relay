import { z } from 'zod';
import { generateApiKey, hashApiKey } from '../auth/api-keys.js';
import type { Db } from '../db/pool.js';

/** Same bounds as the DB CHECK (1..200); trimmed so " demo " and "demo" are one name. */
export const applicationNameSchema = z.string().trim().min(1).max(200);

export interface CreatedApplication {
  id: string;
  name: string;
  createdAt: Date;
  /** The plain API key. Returned exactly once; only its hash is stored. */
  apiKey: string;
}

export async function createApplication(db: Db, name: string): Promise<CreatedApplication> {
  const apiKey = generateApiKey();
  const { rows } = await db.query<{ id: string; name: string; created_at: Date }>(
    `INSERT INTO applications (name, api_key_hash)
     VALUES ($1, $2)
     RETURNING id, name, created_at`,
    [applicationNameSchema.parse(name), hashApiKey(apiKey)],
  );
  const row = rows[0]!; // INSERT ... RETURNING always yields exactly one row
  return { id: row.id, name: row.name, createdAt: row.created_at, apiKey };
}
