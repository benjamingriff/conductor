import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  base: './',
  plugins: [react(), { name: 'desktop-csp', apply: 'build', transformIndexHtml(html) { return html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'">`); } }],
  build: { outDir: 'dist/web', emptyOutDir: true },
  server: { host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:4317' } },
});
