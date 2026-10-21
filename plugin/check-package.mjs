import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = new URL('../build/codex-plugin/plugins/neeley-dress-rehearsal/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('plugin.json', root), 'utf8'));
const mcp = JSON.parse(await readFile(new URL('mcp.json', root), 'utf8'));
assert.equal(manifest.name, 'neeley-dress-rehearsal');
assert.equal(mcp.mcpServers.rehearsal.type, 'stdio');
const client = new Client({ name: 'rehearsal-package-check', version: '0.1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('server.mjs', root))], cwd: fileURLToPath(root), stderr: 'pipe' });
let stderr = '';
transport.stderr?.on('data', chunk => { stderr += chunk; });
try {
  await client.connect(transport);
  const serverInfo = client.getServerVersion();
  assert.equal(serverInfo.version, manifest.version);
  assert.equal(serverInfo.icons[0].src, `data:image/svg+xml;base64,${(await readFile(new URL('assets/icon.svg', root))).toString('base64')}`);
  const { tools } = await client.listTools();
  const opener = tools.find(tool => tool.name === 'open_rehearsal');
  assert.equal(opener._meta['openai/ui'].entrypoints[0].type, 'thread');
  const resource = await client.readResource({ uri: opener._meta.ui.resourceUri });
  const panel = resource.contents[0];
  assert.equal(panel.mimeType, 'text/html;profile=mcp-app');
  assert.ok(panel.text.includes('ui/initialize'));
  assert.ok(panel.text.includes('https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/pdf.worker.min.mjs'));
  assert.ok(panel.text.includes('ui/download-file'));
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, result.content?.[0]?.text);
    return result.structuredContent;
  };
  const opened = await call('open_rehearsal', {});
  const text = 'Our campus should offer more rehearsal rooms. Students need a quiet place to practice. Please support this proposal.';
  const prepared = await call('prepare_coaching', { rehearsalId: opened.rehearsalId, input: { text, targetScript: text, targetTalkingPoints: 'More rehearsal rooms', durationSeconds: 30 } });
  const request = await call('get_coaching_request', { rehearsalId: opened.rehearsalId, revision: prepared.revision });
  assert.ok(request.prompt.includes(text));
  assert.equal(request.input.targetTalkingPoints, 'More rehearsal rooms');
  // Controlled fixture tests transport and score calculation, not model quality.
  const quote = 'Our campus should offer more rehearsal rooms.';
  const feedback = {
    thesis: { summary: 'More campus rehearsal rooms.', clarity: 'A direct proposal.', evidence: [quote] },
    strengths: [{ text: 'A clear proposal.', evidence: [quote] }],
    improvements: ['Add a concrete estimate of student demand.'], rhetoric: [], targetCoverage: [],
    rubric: ['claim', 'evidence', 'structure', 'audience', 'conclusion'].map(criterion => ({ criterion, score: 3, reason: 'Protocol fixture assessment.', evidence: [quote] })),
    annotations: [{ quote, category: 'thesis', comment: 'A direct proposal.', occurrence: 1 }],
  };
  const done = await call('submit_coaching', { rehearsalId: opened.rehearsalId, revision: prepared.revision, feedback });
  assert.equal(done.report.analysis.overallRating, 60);
  assert.equal(done.report.analysis.annotations[0].quote, quote);
  const current = await call('get_rehearsal', { rehearsalId: opened.rehearsalId });
  assert.equal(current.status, 'complete');
  await call('clear_rehearsal', { rehearsalId: opened.rehearsalId });
  assert.equal(stderr, '');
  console.log('Packaged plugin passed: stdio handshake, panel resource, complete prompt, coaching validation, report retrieval, and clearing.');
} finally { await client.close(); }
