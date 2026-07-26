import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      // apiClient prefixes every request with /hermes (the backend serves its
      // routes at both '/' and '/hermes'). Without these entries those calls
      // fall through to the SPA fallback and come back as index.html with a
      // 200, which looks like a successful API call returning nonsense.
      //
      // Scoped to /hermes/api and /hermes/auth, NOT bare /hermes — the SPA's own
      // pages live under /hermes/* too, and proxying those sends a page
      // navigation to the backend, which 404s.
      '/hermes/api': {
        target: 'http://localhost:8001',
        changeOrigin: true,
      },
      '/hermes/auth': {
        target: 'http://localhost:8001',
        changeOrigin: true,
      },
      '/api': {
        target: 'http://localhost:8001',
        changeOrigin: true,
      },
      '/auth': {
        target: 'http://localhost:8001',
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-query': ['@tanstack/react-query'],
          'vendor-keycloak': ['keycloak-js'],
          'vendor-icons': ['lucide-react'],
        },
      },
    },
  },
});
