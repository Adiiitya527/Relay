// @ts-check
// Entry point: `npm run dev -w mock-consumer` (or `node src/index.js`).
//   MOCK_PORT    default 4000 (0 = any free port)
//   MOCK_HOST    default 127.0.0.1 (set 0.0.0.0 inside Docker)
//   MOCK_SECRET  optional default signing secret for every hook; per-hook secrets can be
//                set at runtime with POST /control { "hook": "...", "secret": "whsec_..." }
//   MOCK_QUIET   "true" disables per-request log lines
// On start it prints one JSON line {"listening":"http://host:port"} so scripts can find it.
import { createMockConsumer } from './consumer.js';

const port = Number(process.env.MOCK_PORT ?? 4000);
const host = process.env.MOCK_HOST ?? '127.0.0.1';
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`MOCK_PORT must be an integer 0-65535`);
  process.exit(1);
}

const consumer = createMockConsumer({
  ...(process.env.MOCK_SECRET && { secret: process.env.MOCK_SECRET }),
  log: process.env.MOCK_QUIET === 'true' ? () => {} : (/** @type {string} */ line) => console.log(`[mock] ${line}`),
});

consumer.server.listen(port, host, () => {
  const address = consumer.server.address();
  const actual = typeof address === 'object' && address ? address.port : port;
  console.log(JSON.stringify({ listening: `http://${host}:${actual}` }));
});

let stopping = false;
for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    consumer.close().then(() => process.exit(0));
  });
}
