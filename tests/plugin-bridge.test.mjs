import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPanelBridge, MCP_APPS_VERSION } from '../plugin/panel-bridge.mjs';

const pluginVersion = JSON.parse(await readFile(new URL('../plugin/plugin.json', import.meta.url), 'utf8')).version;
const input = { text: 'We should expand tutoring because students need help. Thank you.', targetTalkingPoints: 'Expand tutoring', durationSeconds: 8 };
const initial = { rehearsalId: 'rehearsal_123', revision: 0, status: 'empty', report: null };
const prepared = { ...initial, revision: 1, status: 'pending' };
const result = structuredContent => ({ structuredContent, content: [] });

function harness({ onRequest, omitInitial = false, requestTimeoutMs = 100, initialResultTimeoutMs = 100, downloadFile = false } = {}) {
  const listeners = new Set();
  const messages = [];
  const parent = { postMessage(message, origin) {
    messages.push(message);
    assert.equal(origin, '*');
    queueMicrotask(() => {
      if (message.method === 'ui/initialize') respond(message, { protocolVersion: MCP_APPS_VERSION, hostInfo: { name: 'test', version: '1' }, hostCapabilities: { serverTools: {}, message: { text: {} }, ...(downloadFile ? { downloadFile: {} } : {}) }, hostContext: {} });
      else if (message.method === 'ui/notifications/initialized' && !omitInitial) emit({ method: 'ui/notifications/tool-result', params: result(initial) });
      else onRequest?.(message, respond, emit);
    });
  } };
  const windowImpl = { parent, addEventListener(name, listener) { assert.equal(name, 'message'); listeners.add(listener); }, removeEventListener(name, listener) { listeners.delete(listener); } };
  function emit(message, source = parent) { for (const listener of [...listeners]) listener({ source, data: { jsonrpc: '2.0', ...message } }); }
  function respond(message, value) { emit({ id: message.id, result: value }); }
  const bridge = createPanelBridge({ windowImpl, requestTimeoutMs, initialResultTimeoutMs });
  return { bridge, messages, listeners, parent, emit, respond };
}
test('MCP Apps handshake uses current protocol and receives initial open result', async () => {
  const h = harness();
  try {
    assert.deepEqual(await h.bridge.waitForRehearsal(), initial);
    assert.deepEqual(h.messages[0].params, { appInfo: { name: 'neeley-dress-rehearsal', version: pluginVersion }, appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] }, protocolVersion: '2026-01-26' });
    assert.equal(h.messages[1].method, 'ui/notifications/initialized');
    assert.equal(h.messages.filter(item => item.method === 'ui/initialize').length, 1);
  } finally { h.bridge.dispose(); }
  assert.equal(h.listeners.size, 0);
});

test('only parent JSON-RPC replies can resolve requests; tool allowlist is enforced', async () => {
  const h = harness({ onRequest(message, respond, emit) {
    if (message.method !== 'tools/call') return;
    emit({ id: message.id, result: result({ compromised: true }) }, {});
    respond(message, result(prepared));
  } });
  try {
    assert.deepEqual(await h.bridge.callTool('prepare_coaching', { rehearsalId: initial.rehearsalId, input }), prepared);
    await assert.rejects(h.bridge.callTool('submit_coaching', {}), { status: 403 });
    await assert.rejects(h.bridge.callTool('get_coaching_request', {}), { status: 403 });
    await assert.rejects(h.bridge.callTool('arbitrary_tool', {}), { status: 403 });
    assert.equal(h.messages.filter(item => item.method === 'tools/call').length, 1);
  } finally { h.bridge.dispose(); }
});

test('coaching messages bind the exact revision and carry no transcript or audio', async () => {
  const h=harness({onRequest(message,respond){if(message.method==='ui/message')respond(message,{});}});
  try {
    await h.bridge.requestCoaching(initial.rehearsalId,1);
    const message=h.messages.find(value=>value.method==='ui/message');
    assert.equal(message.params.role,'user');
    assert.deepEqual(message.params._meta,{'openai/message':{target:'active',send:true}});
    assert.ok(message.params.content[0].text.includes(JSON.stringify({rehearsalId:initial.rehearsalId,revision:1})));
    assert.equal(JSON.stringify(message).includes(input.text),false);
    assert.equal(h.messages.some(value=>value.method==='tools/call'),false);
  }finally{h.bridge.dispose();}
});

test('cancellation rejects a pending host call and ignores its late response',async()=>{
  let pending;
  const h=harness({onRequest(message){if(message.method==='tools/call')pending=message;}});
  try{
    await h.bridge.initialize();const controller=new AbortController();
    const request=h.bridge.callTool('get_rehearsal',{rehearsalId:initial.rehearsalId},{signal:controller.signal});
    await new Promise(resolve=>setImmediate(resolve));assert.ok(pending);controller.abort();
    await assert.rejects(request,{name:'AbortError'});
    h.respond(pending,result(prepared));
    assert.equal(h.listeners.size,1);
  }finally{h.bridge.dispose();}
});

test('rejected coaching messages remain actionable without any provider fallback',async()=>{
  const h=harness({onRequest(message,respond){if(message.method==='ui/message')respond(message,{isError:true});}});
  try{await assert.rejects(h.bridge.requestCoaching(initial.rehearsalId,1),/could not send the coaching request/);}
  finally{h.bridge.dispose();}
});

test('missing initial result and unanswered requests are bounded', async () => {
  const h = harness({ omitInitial: true, initialResultTimeoutMs: 10, requestTimeoutMs: 10 });
  try {
    await assert.rejects(h.bridge.waitForRehearsal(), { status: 504 });
    await assert.rejects(h.bridge.callTool('get_rehearsal', { rehearsalId: initial.rehearsalId }), { status: 504 });
  } finally { h.bridge.dispose(); }
});

test('dispose removes listener, rejects pending calls, and prevents later work', async () => {
  const h = harness();
  await h.bridge.initialize();
  const pending = h.bridge.callTool('get_rehearsal', { rehearsalId: initial.rehearsalId });
  await Promise.resolve();
  h.bridge.dispose();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(h.listeners.size, 0);
  await assert.rejects(h.bridge.callTool('get_rehearsal', {}), { status: 410 });
});

test('user-requested audio export uses only host download resources, never chat or coaching tools', async () => {
  const h = harness({ downloadFile: true, onRequest(message, respond) { if (message.method === 'ui/download-file') respond(message, {}); } });
  try {
    await h.bridge.download(new Blob(['local-audio-bytes'], { type: 'audio/wav' }), 'my rehearsal.wav');
    const request = h.messages.find(message => message.method === 'ui/download-file');
    assert.deepEqual(request.params, { contents: [{ type: 'resource', resource: { uri: 'file:///my%20rehearsal.wav', mimeType: 'audio/wav', blob: btoa('local-audio-bytes') } }] });
    assert.equal(h.messages.some(message => ['ui/message', 'tools/call'].includes(message.method)), false);
  } finally { h.bridge.dispose(); }
});

test('unsupported or denied host downloads fail clearly without sending data to another route', async () => {
  const unsupported = harness();
  try {
    await assert.rejects(unsupported.bridge.download(new Blob(['private']), 'take.wav'), /does not support file downloads/);
    assert.equal(unsupported.messages.some(message => message.method === 'ui/download-file'), false);
  } finally { unsupported.bridge.dispose(); }
  const denied = harness({ downloadFile: true, onRequest(message, respond) { if (message.method === 'ui/download-file') respond(message, { isError: true }); } });
  try { await assert.rejects(denied.bridge.download(new Blob(['private']), 'take.wav'), /canceled or blocked/); }
  finally { denied.bridge.dispose(); }
});
