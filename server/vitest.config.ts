import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Vitest is not started via `node --env-file`, so load the repo-root .env with Node's
// built-in loader (no dotenv). Variables already set in the real environment win, which is
// how CI/Docker inject config. A missing file is fine (CI has none); any other error is not.
try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // CLAUDE.md: tests run sequentially against one real database. Files never run in
    // parallel; concurrency *inside* a test (race tests) is still allowed.
    fileParallelism: false,
  },
});
