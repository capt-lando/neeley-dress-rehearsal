import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

export default defineConfig({
  root: fileURLToPath(new URL('./public', import.meta.url)),
  envDir: fileURLToPath(new URL('./', import.meta.url)),
  base: './',
  publicDir: false,
  plugins: [{
    name: 'speech-attribution',
    async generateBundle() {
      for (const fileName of ['MODEL-NOTICE.txt', 'LICENSES/Apache-2.0.txt']) {
        this.emitFile({ type: 'asset', fileName, source: await readFile(new URL(fileName, import.meta.url), 'utf8') });
      }
    },
  }],
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022' },
  worker: { format: 'es' },
});
