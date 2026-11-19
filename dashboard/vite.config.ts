import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { apiProxyTarget, PROXIED_PATHS } from './dev-proxy.js';

// Reads only DASHBOARD_* from the repo-root .env (the prefix filter keeps DATABASE_URL and
// friends out). Nothing from it is exposed to browser code: Vite only exposes VITE_* vars,
// and envDir stays this folder.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, repoRoot, 'DASHBOARD_'), ...process.env };
  const target = apiProxyTarget(env.DASHBOARD_API_URL);
  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: Number(env.DASHBOARD_PORT ?? 5173),
      strictPort: true,
      proxy: Object.fromEntries(PROXIED_PATHS.map((path) => [path, { target, changeOrigin: false }])),
    },
    test: {
      include: ['test/**/*.test.ts'],
      environment: 'node',
    },
  };
});
