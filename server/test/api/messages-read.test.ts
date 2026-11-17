import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApplication } from '../../src/applications/repo.js';
import { buildTestApp } from '../helpers/app.js';
import { insertEndpoint, useTestDb } from '../helpers/db.js';

const db = useTestDb();
let app: FastifyInstance;
let keyA: string;
let appA: string;
let keyB: string;
let appB: string;

beforeAll(async () => {
  app = buildTestApp(db());
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  const a = await createApplication(db(), 'tenant-a');
  const b = await createApplication(db(), 'tenant-b');
  [keyA, appA, keyB, appB] = [a.apiKey, a.id, b.apiKey, b.id];
});

const get = (url: string, key = keyA) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key}` } });

/** Insert n messages in ONE statement: they all get the same created_at (one transaction). */
async function insertSameInstant(appId: string, n: number): Promise<void> {
  await db().query(
    `INSERT INTO messages (app_id, event_type, payload)
     SELECT $1, 'bulk', jsonb_build_object('n', i) FROM generate_series(1, $2) AS i`,
    [appId, n],
  );
}

/** Insert messages with explicit created_at values (ISO strings with microseconds). */
async function insertAt(appId: string, timestamps: string[]): Promise<void> {
  await db().query(
    `INSERT INTO messages (app_id, event_type, payload, created_at)
     SELECT $1, 'timed', '{}'::jsonb, t FROM unnest($2::timestamptz[]) AS t`,
    [appId, timestamps],
  );
}

/** The expected order, straight from SQL. */
async function expectedIds(appId: string): Promise<string[]> {
  const { rows } = await db().query<{ id: string }>(
    'SELECT id FROM messages WHERE app_id = $1 ORDER BY created_at DESC, id DESC',
    [appId],
  );
  return rows.map((r) => r.id);
}

/** Follow next_cursor to the end; returns ids in received order and the page sizes. */
async function pageThrough(limit: number, key = keyA) {
  const ids: string[] = [];
  const sizes: number[] = [];
  let cursor: string | null = null;
  do {
    const res = await get(`/v1/messages?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`, key);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    ids.push(...body.data.map((m: { id: string }) => m.id));
    sizes.push(body.data.length);
    cursor = body.next_cursor;
  } while (cursor !== null && sizes.length < 50);
  return { ids, sizes };
}

describe('GET /v1/messages (keyset pagination)', () => {
  it('25 messages with IDENTICAL created_at, paged by 10: 10/10/5, no gaps, no duplicates', async () => {
    await insertSameInstant(appA, 25);
    const { ids, sizes } = await pageThrough(10);
    expect(sizes).toEqual([10, 10, 5]);
    expect(ids).toEqual(await expectedIds(appA)); // complete, ordered, unique
  });

  it('25 messages at distinct times are returned newest first across pages', async () => {
    const times = Array.from({ length: 25 }, (_, i) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString());
    await insertAt(appA, times);
    const { ids } = await pageThrough(10);
    expect(ids).toEqual(await expectedIds(appA));
  });

  it('keeps MICROsecond precision: rows within one millisecond are not skipped', async () => {
    // All three fall in the same millisecond (.123). A cursor built from a JS Date
    // (ms precision) would say "< .123000" on page 2 and skip the other two rows.
    await insertAt(appA, [
      '2026-01-01T00:00:00.123456Z',
      '2026-01-01T00:00:00.123455Z',
      '2026-01-01T00:00:00.123001Z',
    ]);
    const { ids, sizes } = await pageThrough(1);
    expect(sizes).toEqual([1, 1, 1]);
    expect(ids).toEqual(await expectedIds(appA));
  });

  it('messages published while paging do not cause duplicates on later pages', async () => {
    await insertSameInstant(appA, 15);
    const first = (await get('/v1/messages?limit=10')).json();
    await insertSameInstant(appA, 5); // newer than everything already seen
    const second = (await get(`/v1/messages?limit=10&cursor=${first.next_cursor}`)).json();

    const seen = [...first.data, ...second.data].map((m: { id: string }) => m.id);
    expect(new Set(seen).size).toBe(15);
    expect(second.next_cursor).toBeNull();
  });

  it('exactly `limit` rows → next_cursor is null (no empty last page)', async () => {
    await insertSameInstant(appA, 10);
    const body = (await get('/v1/messages?limit=10')).json();
    expect(body.data).toHaveLength(10);
    expect(body.next_cursor).toBeNull();
  });

  it('empty → { data: [], next_cursor: null }; default limit is 20', async () => {
    expect((await get('/v1/messages')).json()).toEqual({ data: [], next_cursor: null });
    await insertSameInstant(appA, 25);
    expect((await get('/v1/messages')).json().data).toHaveLength(20);
  });

  it('list items carry no payload', async () => {
    await insertSameInstant(appA, 1);
    const [item] = (await get('/v1/messages')).json().data;
    expect(Object.keys(item).sort()).toEqual(['created_at', 'event_type', 'id', 'idempotency_key']);
  });

  it.each([
    ['limit=0', 'query.limit:'],
    ['limit=101', 'query.limit:'],
    ['limit=abc', 'query.limit:'],
    ['limit=1.5', 'query.limit:'],
    ['cursor=garbage', 'query.cursor: invalid cursor'],
    [`cursor=${Buffer.from('1|not-a-uuid').toString('base64url')}`, 'query.cursor: invalid cursor'],
    ['limt=5', 'limt'],
  ])('400 validation_failed for ?%s', async (qs, messagePart) => {
    const res = await get(`/v1/messages?${qs}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_failed');
    expect(res.json().error.message).toContain(messagePart);
  });

  it('tenant isolation: B never sees A\'s messages, even with a cursor taken from A\'s list', async () => {
    await insertSameInstant(appA, 5);
    await insertSameInstant(appB, 2);
    const aCursor = (await get('/v1/messages?limit=1')).json().next_cursor;

    const { ids } = await pageThrough(10, keyB);
    expect(ids).toEqual(await expectedIds(appB));
    const withACursor = (await get(`/v1/messages?cursor=${aCursor}`, keyB)).json();
    for (const m of withACursor.data) expect((await expectedIds(appB)).includes(m.id)).toBe(true);
  });
});

describe('GET /v1/messages/:id', () => {
  async function publish(key: string, body: object) {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    return res.json();
  }

  it('returns the message with its payload and deliveries (no lease internals)', async () => {
    const e1 = await insertEndpoint(db(), appA);
    const e2 = await insertEndpoint(db(), appA);
    const published = await publish(keyA, { event_type: 'invoice.paid', payload: { amount: 5, tags: ['a'] } });

    const res = await get(`/v1/messages/${published.message.id}`);
    expect(res.statusCode).toBe(200);
    const detail = res.json();
    expect(detail).toMatchObject({
      id: published.message.id,
      event_type: 'invoice.paid',
      idempotency_key: null,
      payload: { amount: 5, tags: ['a'] },
    });
    expect(detail.deliveries.map((d: { endpoint_id: string }) => d.endpoint_id).sort()).toEqual([e1, e2].sort());
    for (const d of detail.deliveries) {
      expect(d).toMatchObject({ status: 'pending', attempt_count: 0, last_error: null, completed_at: null });
      expect(d).not.toHaveProperty('lease_token');
      expect(d).not.toHaveProperty('locked_by');
      expect(d).not.toHaveProperty('locked_until');
    }
  });

  it('message with no deliveries → deliveries: []', async () => {
    const published = await publish(keyA, { event_type: 'x', payload: {} });
    expect((await get(`/v1/messages/${published.message.id}`)).json().deliveries).toEqual([]);
  });

  it('another tenant\'s message → 404 (same body as a missing id); bad id → 400', async () => {
    const published = await publish(keyA, { event_type: 'x', payload: { secret: 'tenant-a-data' } });

    const other = await get(`/v1/messages/${published.message.id}`, keyB);
    const missing = await get('/v1/messages/00000000-0000-4000-8000-000000000000', keyB);
    expect(other.statusCode).toBe(404);
    expect(other.json()).toEqual(missing.json());
    expect(other.body).not.toContain('tenant-a-data');

    expect((await get('/v1/messages/123')).statusCode).toBe(400);
  });
});
