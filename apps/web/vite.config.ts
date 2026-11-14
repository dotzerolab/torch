import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// The dev server proxies /api to the Node server: API_TARGET, else http://localhost:PORT, both read from the
// shell or from the repo's .env (the same file the server loads), else port 3000.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('../..', import.meta.url)), '');
  const apiTarget = env.API_TARGET || `http://localhost:${env.PORT || 3000}`;
  return {
    plugins: [react()],
    server: { proxy: { '/api': apiTarget } },
  };
});
