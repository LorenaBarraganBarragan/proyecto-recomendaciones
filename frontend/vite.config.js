import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// En Docker el backend se resuelve como `backend`; en local como `localhost:4000`.
const proxyTarget = process.env.API_PROXY_TARGET || 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': { target: proxyTarget, changeOrigin: true },
    },
  },
});
