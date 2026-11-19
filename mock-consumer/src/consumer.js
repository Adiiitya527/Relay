// @ts-check
// A demo webhook receiver with switchable failure modes (ARCHITECTURE §8). Zero runtime
// dependencies: node:http and node:crypto only.
//
//   POST /hooks/:name   receive a webhook (verify signature, detect duplicates, apply mode)
//   POST /control       change behaviour: { hook?, mode?, fail_rate?, delay_ms?, secret?, reset? }
//   GET  /stats         counters per hook + the most recent requests
//   GET  /health        200 "ok"
//
// Modes: ok (200) | fail (500) | flaky (500 with probability fail_rate) |
//        slow (200 after delay_ms) | timeout (never answers; Relay's deadline cuts it off).
import { createServer } from 'node:http';
import { verifyWebhook } from './verify.js';

export const MODES = /** @type {const} */ (['ok', 'fail', 'flaky', 'slow', 'timeout']);
const MAX_BODY_BYTES = 1024 * 1024;
const RECENT_LIMIT = 50;
const HOOK_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** @typedef {typeof MODES[number]} Mode */
/** @typedef {{ mode: Mode, fail_rate: number, delay_ms: number }} Behaviour */
/**
 * @typedef {{
 *   received: number, processed: number, failed: number, duplicates: number, retries: number,
 *   invalid_signatures: number, unverified: number, held: number,
 * }} Counters
 */
/**
 * @typedef {{
 *   at: string, hook: string, webhook_id: string | null, outcome: string,
 *   duplicate: boolean, verified: boolean,
 * }} RecentEntry
 */

const DEFAULT_BEHAVIOUR = /** @type {Behaviour} */ ({ mode: 'ok', fail_rate: 0.5, delay_ms: 2000 });

/** @returns {Counters} */
function zeroCounters() {
  return { received: 0, processed: 0, failed: 0, duplicates: 0, retries: 0, invalid_signatures: 0, unverified: 0, held: 0 };
}

/**
 * @typedef {object} MockConsumerOptions
 * @property {string} [secret]   default signing secret for every hook (MOCK_SECRET)
 * @property {() => number} [random]   injectable for deterministic flaky tests
 * @property {(line: string) => void} [log]
 * @property {() => number} [now]   epoch ms, for the signature timestamp tolerance
 */

/** @param {MockConsumerOptions} [options] */
export function createMockConsumer(options = {}) {
  const random = options.random ?? Math.random;
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;

  /** Per-hook behaviour; "*" is the default for hooks without their own. */
  /** @type {Map<string, Behaviour>} */
  const behaviours = new Map([['*', { ...DEFAULT_BEHAVIOUR }]]);
  /** @type {Map<string, string>} */
  const secrets = new Map(options.secret ? [['*', options.secret]] : []);
  /** @type {Map<string, Counters>} */
  const counters = new Map();
  // Duplicate detection, per hook (= per Relay endpoint):
  //   processed: webhook-ids we already answered 2xx for. Seeing one again is a true
  //              duplicate: at-least-once delivery re-sent something we had handled
  //              (e.g. our 200 was lost, or arrived after Relay's timeout). A real consumer
  //              must dedupe on this; we count it and answer 200 without re-processing.
  //   seen:      every webhook-id. Seen but not processed = an ordinary retry after we
  //              failed it, which is expected and not a duplicate.
  /** @type {Map<string, Set<string>>} */
  const processed = new Map();
  /** @type {Map<string, Set<string>>} */
  const seen = new Map();
  /** @type {RecentEntry[]} */
  const recent = [];

  /** @param {string} hook */
  const behaviourOf = (hook) => behaviours.get(hook) ?? /** @type {Behaviour} */ (behaviours.get('*'));
  /** @param {string} hook */
  const secretOf = (hook) => secrets.get(hook) ?? secrets.get('*');
  /** @param {string} hook */
  const countersOf = (hook) => {
    let c = counters.get(hook);
    if (!c) counters.set(hook, (c = zeroCounters()));
    return c;
  };
  /**
   * @param {Map<string, Set<string>>} map
   * @param {string} hook
   */
  const setOf = (map, hook) => {
    let s = map.get(hook);
    if (!s) map.set(hook, (s = new Set()));
    return s;
  };
  /** @param {RecentEntry} entry */
  const remember = (entry) => {
    recent.unshift(entry);
    recent.length = Math.min(recent.length, RECENT_LIMIT);
    log(`${entry.hook} ${entry.webhook_id ?? '-'} → ${entry.outcome}${entry.duplicate ? ' (duplicate)' : ''}`);
  };

  function stats() {
    const total = zeroCounters();
    for (const c of counters.values()) {
      for (const key of /** @type {(keyof Counters)[]} */ (Object.keys(total))) total[key] += c[key];
    }
    return {
      total,
      hooks: Object.fromEntries(counters),
      behaviour: Object.fromEntries(behaviours),
      secrets_configured: [...secrets.keys()],
      recent,
    };
  }

  /**
   * @param {string} hook
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {Buffer} body
   */
  function receive(hook, req, res, body) {
    const c = countersOf(hook);
    c.received += 1;
    const header = req.headers['webhook-id'];
    const webhookId = (Array.isArray(header) ? header[0] : header) ?? null;
    const at = new Date(now()).toISOString();

    const secret = secretOf(hook);
    let verified = false;
    if (secret) {
      const result = verifyWebhook({ secret, headers: req.headers, body, nowSec: Math.floor(now() / 1000) });
      if (!result.ok) {
        c.invalid_signatures += 1;
        remember({ at, hook, webhook_id: webhookId, outcome: `401 ${result.reason}`, duplicate: false, verified });
        return send(res, 401, { error: result.reason });
      }
      verified = true;
    } else {
      c.unverified += 1; // no secret configured for this hook: accepted, but flagged
    }

    if (webhookId && setOf(processed, hook).has(webhookId)) {
      c.duplicates += 1;
      remember({ at, hook, webhook_id: webhookId, outcome: '200 already processed', duplicate: true, verified });
      return send(res, 200, { duplicate: true });
    }
    if (webhookId) {
      const seenSet = setOf(seen, hook);
      if (seenSet.has(webhookId)) c.retries += 1;
      seenSet.add(webhookId);
    }

    const markProcessed = () => {
      c.processed += 1;
      if (webhookId) setOf(processed, hook).add(webhookId);
    };
    const { mode, fail_rate, delay_ms } = behaviourOf(hook);
    const entry = { at, hook, webhook_id: webhookId, duplicate: false, verified };
    switch (mode) {
      case 'ok':
        markProcessed();
        remember({ ...entry, outcome: '200' });
        return send(res, 200, { ok: true });
      case 'slow':
        // Processed now; the 200 goes out later. If Relay's deadline fires first, Relay
        // retries and the retry is (correctly) reported as a duplicate.
        markProcessed();
        remember({ ...entry, outcome: `200 after ${delay_ms} ms` });
        setTimeout(() => send(res, 200, { ok: true }), delay_ms).unref();
        return;
      case 'timeout':
        c.held += 1;
        remember({ ...entry, outcome: 'no response (timeout mode)' });
        return; // never answer; close() destroys held sockets
      case 'flaky':
        if (random() >= fail_rate) {
          markProcessed();
          remember({ ...entry, outcome: '200 (flaky: passed)' });
          return send(res, 200, { ok: true });
        }
        c.failed += 1;
        remember({ ...entry, outcome: '500 (flaky: failed)' });
        return send(res, 500, { error: 'flaky failure' });
      case 'fail':
        c.failed += 1;
        remember({ ...entry, outcome: '500' });
        return send(res, 500, { error: 'mock failure' });
    }
  }

  /**
   * POST /control. Returns an error message, or undefined when applied.
   * @param {unknown} input
   * @returns {string | undefined}
   */
  function control(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return 'body must be a JSON object';
    const body = /** @type {Record<string, unknown>} */ (input);
    const allowed = ['hook', 'mode', 'fail_rate', 'delay_ms', 'secret', 'reset'];
    const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
    if (unknown.length) return `unknown field(s): ${unknown.join(', ')}`;

    const hook = body.hook ?? '*';
    if (typeof hook !== 'string' || (hook !== '*' && !HOOK_NAME.test(hook))) return 'hook must be a hook name or "*"';
    if (body.mode !== undefined && !MODES.includes(/** @type {Mode} */ (body.mode))) return `mode must be one of ${MODES.join(', ')}`;
    if (body.fail_rate !== undefined && !(typeof body.fail_rate === 'number' && body.fail_rate >= 0 && body.fail_rate <= 1)) {
      return 'fail_rate must be a number between 0 and 1';
    }
    if (body.delay_ms !== undefined && !(Number.isInteger(body.delay_ms) && Number(body.delay_ms) >= 0 && Number(body.delay_ms) <= 600_000)) {
      return 'delay_ms must be an integer between 0 and 600000';
    }
    if (body.secret !== undefined && !(typeof body.secret === 'string' && body.secret.length > 0)) return 'secret must be a non-empty string';
    if (body.reset !== undefined && typeof body.reset !== 'boolean') return 'reset must be a boolean';

    if (body.reset) {
      counters.clear();
      processed.clear();
      seen.clear();
      recent.length = 0;
    }
    if (body.mode !== undefined || body.fail_rate !== undefined || body.delay_ms !== undefined) {
      const next = { ...behaviourOf(hook) };
      if (body.mode !== undefined) next.mode = /** @type {Mode} */ (body.mode);
      if (body.fail_rate !== undefined) next.fail_rate = /** @type {number} */ (body.fail_rate);
      if (body.delay_ms !== undefined) next.delay_ms = /** @type {number} */ (body.delay_ms);
      behaviours.set(hook, next);
    }
    if (typeof body.secret === 'string') secrets.set(hook, body.secret);
    log(`control ${hook}: ${JSON.stringify({ ...body, ...(body.secret !== undefined && { secret: '[set]' }) })}`);
    return undefined;
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function route(req, res) {
    const url = new URL(req.url ?? '/', 'http://mock');
    const hookMatch = /^\/hooks\/([^/]+)$/.exec(url.pathname);

    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/stats') return send(res, 200, stats());
    if (req.method !== 'POST' || !(url.pathname === '/control' || hookMatch)) return send(res, 404, { error: 'not found' });

    const body = await readBody(req);
    if (body === undefined) return send(res, 413, { error: 'body too large' });
    if (hookMatch) {
      const hook = /** @type {string} */ (hookMatch[1]);
      if (!HOOK_NAME.test(hook)) return send(res, 404, { error: 'not found' });
      return receive(hook, req, res, body);
    }
    let parsed;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return send(res, 400, { error: 'invalid JSON' });
    }
    const problem = control(parsed);
    if (problem) return send(res, 400, { error: problem });
    return send(res, 200, { behaviour: Object.fromEntries(behaviours), secrets_configured: [...secrets.keys()] });
  }

  const server = createServer((req, res) => {
    route(req, res).catch(() => {
      // The client went away mid-body (e.g. Relay's deadline): nothing left to answer.
      res.destroy();
    });
  });

  return {
    server,
    stats,
    /** Stop accepting and destroy open sockets, including requests held by timeout mode. */
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve(undefined));
        server.closeAllConnections();
      });
    },
  };
}

/**
 * The whole body, or undefined if it exceeds MAX_BODY_BYTES (we stop reading at the limit).
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Buffer | undefined>}
 */
async function readBody(req) {
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function send(res, status, body) {
  if (res.headersSent || res.destroyed) return; // e.g. Relay timed out before a slow reply
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
