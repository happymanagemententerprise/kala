import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: [{ find: /^three$/, replacement: 'three/src/Three.js' }],
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8787', changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'three-engine', test: /[\\/]node_modules[\\/]three[\\/]src[\\/]/, priority: 10, maxSize: 350 * 1024 },
            { name: 'qr-tools', test: /[\\/]node_modules[\\/]qrcode[\\/]/, priority: 5 },
          ],
        },
      },
    },
  },
});
