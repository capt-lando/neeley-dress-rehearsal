import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPanelBridge, createPanelService, MCP_APPS_VERSION } from '../plugin/panel-bridge.mjs';
import { createBrowserService } from '../lib/browser-service.mjs';

const policyText = await readFile(new URL('../lib/coaching-prompt.md', import.meta.url), 'utf8');
const pluginVersion = JSON.parse(await readFile(new URL('../plugin/plugin.json', import.meta.url), 'utf8')).version;
const post = body => ({ method: 'POST', body: JSON.stringify(body) });
const input = { text: 'We should expand tutoring because students need help. Thank you.', targetTalkingPoints: 'Expand tutoring', durationSeconds: 8 };
const initial = { rehearsalId: 'rehearsal_123', revision: 0, status: 'empty', report: null };
const prepared = { ...initial, revision: 1, status: 'pending' };
const report = { transcript: input.text, analysis: { method: 'ai' }, meta: { analysisProvider: 'codex', analysisProviderLabel: 'Codex', revision: 1 } };
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
function serviceHarness(options = {}) {
  let providerCalls = 0;
  const local = createBrowserService({ policyText,
    transcribe: async (_blob, settings) => { settings.onProgress('Speech ready'); return { text: input.text, durationSeconds: 8 }; },
    fetchImpl: async () => { providerCalls++; throw new Error('Unexpected provider call'); },
  });
  const harnessResult = harness(options);
  const service = createPanelService({ browserService: local, bridge: harnessResult.bridge, pollIntervalMs: 1, coachingTimeoutMs: options.coachingTimeoutMs || 500 });
  return { ...harnessResult, service, providerCalls: () => providerCalls };
}
function successful(message, respond) {
  if (message.method === 'ui/message') respond(message, {});
  if (message.method === 'tools/call') respond(message, result(message.params.name === 'prepare_coaching' ? prepared : { ...prepared, status: 'complete', report }));
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

test('panel config and Apply use Codex without accepting provider keys or settings', async () => {
  const h = serviceHarness();
  try {
    const config = await h.service.request('/api/config');
    assert.equal(config.coachingViaHost, true);
    assert.equal(config.analysisConfigured, true);
    assert.equal(config.analysisProvider, 'codex');
    assert.equal(config.analysisProviderLabel, 'Codex');
    assert.deepEqual(config.providers.map(provider => provider.id), ['codex']);
    assert.equal(config.providers.some(provider => Object.hasOwn(provider, 'keyUrl')), false);
    const updated = await h.service.request('/api/settings', post({ transcriptionModel: 'onnx-community/whisper-small.en' }));
    assert.equal(updated.transcriptionModel, 'onnx-community/whisper-small.en');
    assert.equal(updated.analysisProvider, 'codex');
    for (const body of [{ analysisApiKey: 'example-key' }, { analysisProvider: 'openai' }, { analysisModel: 'example-model' }, { clearAnalysisKey: true }]) await assert.rejects(h.service.request('/api/settings', post(body)));
    assert.equal(h.messages.length, 0);
    assert.equal(h.providerCalls(), 0);
  } finally { h.service.dispose(); }
});

test('local speech and full prompt preview remain local; unknown endpoints fail closed', async () => {
  const h = serviceHarness();
  const progress = [];
  try {
    h.service.setProgressHandler(message => progress.push(message));
    const speech = await h.service.request('/api/transcribe', { method: 'POST', body: new Blob(['audio']) });
    assert.equal(speech.text, input.text);
    assert.deepEqual(progress, ['Speech ready']);
    const preview = await h.service.request('/api/prompt-preview', post(input));
    assert.ok(preview.prompt.includes(input.text));
    assert.ok(preview.prompt.length > policyText.length);
    await assert.rejects(h.service.request('/api/provider'), { status: 404 });
    assert.equal(h.messages.length, 0);
    assert.equal(h.providerCalls(), 0);
  } finally { h.service.dispose(); }
});

test('Analyze prepares text, requests coaching in the active conversation, then reads matching report', async () => {
  const h = serviceHarness({ onRequest: successful });
  try {
    const actual = await h.service.request('/api/analyze-text', post({ ...input, audio: 'must-not-leave', other: 'discard' }));
    assert.deepEqual(actual, report);
    const calls = h.messages.filter(item => item.method === 'tools/call');
    assert.deepEqual(calls.map(item => item.params.name), ['prepare_coaching', 'get_rehearsal']);
    assert.deepEqual(calls[0].params.arguments, { rehearsalId: initial.rehearsalId, input });
    const followup = h.messages.find(item => item.method === 'ui/message').params;
    assert.equal(followup.role, 'user');
    assert.deepEqual(followup._meta, { 'openai/message': { target: 'active', send: true } });
    assert.ok(Array.isArray(followup.content));
    assert.match(followup.content[0].text, /get_coaching_request/);
    assert.match(followup.content[0].text, /full coaching policy/);
    assert.match(followup.content[0].text, /submit_coaching/);
    assert.ok(!JSON.stringify(h.messages).includes('must-not-leave'));
    assert.ok(!followup.content[0].text.includes(input.text));
    assert.equal(h.providerCalls(), 0);
  } finally { h.service.dispose(); }
});

test('invalid transcript and excessive input fail before any host communication', async () => {
  const h = serviceHarness();
  try {
    await assert.rejects(h.service.request('/api/analyze-text', post({ text: '' })));
    await assert.rejects(h.service.request('/api/analyze-text', post({ ...input, targetScript: { audio: 'must-not-leave' } })));
    await assert.rejects(h.service.request('/api/analyze-text', post({ ...input, text: 'x'.repeat(60_001) })), { status: 413 });
    assert.equal(h.messages.length, 0);
    assert.equal(h.providerCalls(), 0);
  } finally { h.service.dispose(); }
});

test('local-only analysis never asks the conversation for coaching', async () => {
  const h = serviceHarness();
  try {
    const report = await h.service.request('/api/analyze-text', post({ ...input, useAI: false }));
    assert.equal(report.meta.analysisProviderLabel, 'Codex');
    assert.equal(report.meta.coachingStatus, 'disabled');
    assert.equal(h.messages.length, 0);
    assert.equal(h.providerCalls(), 0);
  } finally { h.service.dispose(); }
});

test('stale revisions and changed rehearsal identities never render another report', async () => {
  for (const current of [{ ...prepared, revision: 2, status: 'complete', report }, { ...prepared, rehearsalId: 'another_rehearsal', status: 'complete', report }]) {
    const h = serviceHarness({ onRequest(message, respond) {
      if (message.method === 'ui/message') respond(message, {});
      if (message.method === 'tools/call') respond(message, result(message.params.name === 'prepare_coaching' ? prepared : current));
    } });
    try { await assert.rejects(h.service.request('/api/analyze-text', post(input)), { status: 409 }); }
    finally { h.service.dispose(); }
  }
});

test('waiting for model feedback times out and releases service for retry', async () => {
  let complete = false;
  const h = serviceHarness({ coachingTimeoutMs: 20, onRequest(message, respond) {
    if (message.method === 'ui/message') respond(message, {});
    if (message.method === 'tools/call') respond(message, result(complete && message.params.name === 'get_rehearsal' ? { ...prepared, status: 'complete', report } : prepared));
  } });
  try {
    await assert.rejects(h.service.request('/api/analyze-text', post(input)), { status: 504 });
    complete = true;
    assert.deepEqual(await h.service.request('/api/analyze-text', post(input)), report);
    assert.equal(h.providerCalls(), 0);
  } finally { h.service.dispose(); }
});

test('cancellation while a host call is pending rejects promptly and ignores late replies', async () => {
  let pendingMessage;
  let markPending;
  const pending = new Promise(resolve => { markPending = resolve; });
  const h = serviceHarness({ onRequest(message, respond) {
    if (message.method === 'ui/message') respond(message, {});
    if (message.method === 'tools/call' && message.params.name === 'prepare_coaching') respond(message, result(prepared));
    if (message.method === 'tools/call' && message.params.name === 'get_rehearsal') { pendingMessage = message; markPending(); }
  } });
  const controller = new AbortController();
  try {
    const analysis = h.service.request('/api/analyze-text', { ...post(input), signal: controller.signal });
    await pending;
    controller.abort();
    await assert.rejects(analysis, { name: 'AbortError' });
    h.respond(pendingMessage, result({ ...prepared, status: 'complete', report }));
    assert.equal(h.providerCalls(), 0);
  } finally { h.service.dispose(); }
});

test('host request errors, tool errors, and rejected followup messages remain actionable', async () => {
  for (const mode of ['rpc', 'tool', 'message']) {
    const h = serviceHarness({ onRequest(message, respond, emit) {
      if (message.method === 'tools/call') {
        if (mode === 'rpc') emit({ id: message.id, error: { code: -32603, message: 'Host disconnected' } });
        else if (mode === 'tool') respond(message, { isError: true, content: [{ type: 'text', text: 'Rehearsal expired' }] });
        else respond(message, result(prepared));
      }
      if (message.method === 'ui/message') respond(message, { isError: true });
    } });
    try { await assert.rejects(h.service.request('/api/analyze-text', post(input)), /Host disconnected|Rehearsal expired|could not send/); }
    finally { h.service.dispose(); }
  }
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
