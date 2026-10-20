import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: false, // Don't expose source in production
    rollupOptions: {
      output: {
        // Vendor split: framework and charting library cache independently of app code,
        // and lightweight-charts only loads with the pages that draw charts.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/lightweight-charts/') || id.includes('/fancy-canvas/')) return 'charts';
          if (
            id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/') ||
            id.includes('/react-router') || id.includes('/zustand/')
          ) return 'react-vendor';
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3100',
      '/ws': { target: 'ws://localhost:3100', ws: true },
    },
  },
})
