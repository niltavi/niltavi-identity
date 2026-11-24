import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [{ find: /^@gravity-ui\/icons$/, replacement: fileURLToPath(new URL('./src/header-icons.ts', import.meta.url)) }],
  },
  build: { assetsDir: 'identity-assets' },
});
