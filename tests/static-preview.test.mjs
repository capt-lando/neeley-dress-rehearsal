import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStaticPreview } from '../preview.mjs';

test('static preview serves nested assets but exposes no backend or private files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rehearsal-static-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<h1>Rehearsal</h1>');
  await writeFile(join(root, 'assets', 'worker.js'), 'self.onmessage = () => {};');
  await writeFile(join(root, 'assets', 'pdf.worker.mjs'), 'export const WorkerMessageHandler = {};');
  const server = createStaticPreview(root);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await (await fetch(url)).text(), '<h1>Rehearsal</h1>');
    assert.match((await fetch(url + '/assets/worker.js')).headers.get('content-type'), /javascript/);
    assert.match((await fetch(url + '/assets/pdf.worker.mjs')).headers.get('content-type'), /javascript/);
    for (const path of ['/api/config', '/.env', '/package.json', '/%2e%2e%5cpackage.json']) {
      assert.equal((await fetch(url + path)).status, 404);
    }
    assert.equal((await fetch(url + '/api/settings', { method: 'POST', body: 'private-key' })).status, 405);
    assert.equal((await fetch(url, { method: 'HEAD' })).status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
