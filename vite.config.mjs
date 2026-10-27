import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import { webSecurityPlugin } from './lib/web-security.mjs';

export default defineConfig(({ mode }) => ({
  root: fileURLToPath(new URL('./public', import.meta.url)),
  envDir: fileURLToPath(new URL('./', import.meta.url)),
  base: './',
  publicDir: false,
  plugins: [webSecurityPlugin(loadEnv(mode, fileURLToPath(new URL('./', import.meta.url)), 'VITE_'))],
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022' },
  worker: { format: 'es' },
}));
