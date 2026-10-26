import { build } from 'vite';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const buildRoot = path.join(root, 'build/codex-plugin');
const packageRoot = path.join(buildRoot, 'plugins/neeley-dress-rehearsal');
const panelRoot = path.join(root, 'build/panel');

// Only the plugin bundle changes asset loading. The standalone site's build is unchanged.
function panelAssets() {
  return {
    name: 'rehearsal-panel-assets',
    enforce: 'pre',
    resolveId(source) {
      if (source === 'pdfjs-dist/build/pdf.worker.min.mjs?url') return '\0rehearsal-pdf-worker';
    },
    load(id) {
      if (id === '\0rehearsal-pdf-worker') return 'export default "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/pdf.worker.min.mjs";';
    },
  };
}

await build({
  configFile: false, root, base: './', publicDir: false,
  plugins: [panelAssets(), {
    name: 'reuse-rehearsal-page',
    transformIndexHtml: {
      order: 'pre',
      async handler() {
        return (await readFile(path.join(root, 'public/index.html'), 'utf8'))
          .replace('href="./styles.css"', 'href="../public/styles.css"')
          .replace('src="./bootstrap.js"', 'src="./panel-bootstrap.js"')
          .replace('href="./" aria-label=', 'href="#main" aria-label=');
      },
    },
  }],
  build: {
    outDir: panelRoot, emptyOutDir: true, target: 'es2022', cssCodeSplit: false,
    rolldownOptions: { input: path.join(root, 'plugin/panel.html'), output: { codeSplitting: false } },
  },
  worker: { format: 'es', plugins: () => [panelAssets()], rolldownOptions: { output: { codeSplitting: false } } },
});

let html = await readFile(path.join(panelRoot, 'plugin/panel.html'), 'utf8');
for (const match of [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g)]) {
  const code = await readFile(path.resolve(panelRoot, 'plugin', match[1]), 'utf8');
  html = html.replace(match[0], () => `<script type="module">${code.replaceAll('</script', '<\\/script')}</script>`);
}
for (const match of [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/g)]) {
  const css = await readFile(path.resolve(panelRoot, 'plugin', match[1]), 'utf8');
  html = html.replace(match[0], () => `<style>${css}</style>`);
}
const head = html.slice(0, html.indexOf('<script'));
if (/<link\b[^>]*href="\.\.?\//.test(head)) throw new Error('The panel still contains unresolved asset paths.');

await mkdir(packageRoot, { recursive: true });
await build({
  configFile: false, root, publicDir: false, ssr: { noExternal: true },
  build: { ssr: path.join(root, 'plugin/server.mjs'), outDir: packageRoot, emptyOutDir: true, minify: false,
    rolldownOptions: { output: { entryFileNames: 'server.mjs', codeSplitting: false } } },
});
await writeFile(path.join(packageRoot, 'panel.html'), html);
for (const name of ['LICENSES', 'MODEL-NOTICE.txt']) await cp(path.join(root, name), path.join(packageRoot, name), { recursive: true });
for (const name of ['plugin.json', 'mcp.json', 'skills']) await cp(path.join(root, 'plugin', name), path.join(packageRoot, name), { recursive: true });
await cp(path.join(root, 'lib/coaching-prompt.md'), path.join(packageRoot, 'coaching-prompt.md'));
await mkdir(path.join(packageRoot, 'assets'), { recursive: true });
await cp(path.join(root, 'public/favicon.svg'), path.join(packageRoot, 'assets/icon.svg'));
await mkdir(path.join(buildRoot, '.agents/plugins'), { recursive: true });
await cp(path.join(root, 'plugin/INSTALL.txt'), path.join(buildRoot, 'INSTALL.txt'));
await writeFile(path.join(buildRoot, '.agents/plugins/marketplace.json'), JSON.stringify({
  name: 'neeley-local', interface: { displayName: 'Neeley Dress Rehearsal' },
  plugins: [{ name: 'neeley-dress-rehearsal', source: { source: 'local', path: './plugins/neeley-dress-rehearsal' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }],
}, null, 2) + '\n');
console.log(`Plugin ready: ${packageRoot}\nPanel: ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB`);
