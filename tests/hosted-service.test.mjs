import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createHostedService, readHostedConfig } from '../lib/hosted-service.mjs';
import { createRealtimeSocketFixture } from './fixtures/realtime-socket.mjs';

const policyText = await readFile(new URL('../lib/coaching-prompt.md', import.meta.url), 'utf8');
const url = 'https://pilot.supabase.co', publishableKey = 'sb_publishable_test';
const userId = '12345678-1234-4123-8123-123456789012';
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function ndjson(events) {
  return new Response(events.map(event => JSON.stringify(event)).join('\n') + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
}
const coachStages = ['accepted', 'coach_requested', 'feedback_received', 'feedback_validated', 'saved'];
const progressFrames = stages => stages.map(stage => ({ type: 'progress', stage }));
const firstSession = { access_token: 'private-session-token', user: { id: userId } };
const secondSession = { access_token: 'second-token', user: { id: 'abcdefab-1234-4123-8123-123456789012' } };
function wav(seconds = 1, extraSamples = 0) {
  const bytes = Buffer.alloc(44 + Math.round(seconds * 16000) * 2 + extraSamples * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  return new Blob([bytes], { type: 'audio/wav' });
}
function fixture({ signedIn = true, handle, recoveryStorage, draftStoreFactory } = {}) {
  const calls = [], uploads = [], oauth = [];
  if (!recoveryStorage) { const saved = new Map(); recoveryStorage = { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) }; }
  let session = signedIn ? { access_token: 'private-session-token', user: { id: userId } } : null;
  let authHandler;
  const client = {
    auth: {
      getSession: async () => ({ data: { session } }),
      signInWithOAuth: async options => { oauth.push(options); return {}; },
      signOut: async () => { session = null; authHandler?.('SIGNED_OUT', null); return {}; },
      onAuthStateChange: callback => { authHandler = callback; return { data: { subscription: { unsubscribe() {} } } }; },
    },
    storage: { from() { throw new Error('The browser must never upload directly to Storage.'); } },
  };
  const fetchImpl = async (destination, options) => {
    const call = { path: destination.replace(`${url}/functions/v1/rehearsal-api`, ''), ...options, body: options?.body instanceof Blob ? options.body : options?.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    if (/^\/recordings\/[0-9a-f-]+\/audio$/.test(call.path)) uploads.push(call);
    if (handle) { const handled = await handle(call); if (handled) return handled; }
    if (call.path === '/recordings' && options.method === 'POST') return response({ id: call.body.id, storagePath: `${userId}/${call.body.id}/audio.wav`, bucket: 'recordings' });
    if (/^\/recordings\/[0-9a-f-]+\/audio$/.test(call.path)) return response({ id: call.path.split('/')[2], stored: true, durationSeconds: (call.body.size - 44) / 32000, sizeBytes: call.body.size });
    if (call.path === '/transcribe') return response({ text: 'Um, practice helps.', durationSeconds: 1, chunks: [], model: 'gpt-transcribe', localSpeech: false, recordingId: call.body.recordingId });
    if (call.path === '/analyze-text') return response({ analysis: { method: 'ai' } });
    if (call.path === '/config') return response({ auth: { signedIn: true }, analysisConfigured: true });
    if (call.path.startsWith('/requests/') && call.path.endsWith('/cancel')) return response({ recordingId: call.body.recordingId, requestId: call.path.split('/')[2], cancelled: true, state: 'cancelled' });
    if (call.path.endsWith('/cancel')) return response({ recordingId: call.path.split('/')[2], cancelled: true, status: 'cancelled', audioSaved: false });
    if (call.method === 'DELETE') return response({ deleted: true });
    throw new Error('Unexpected request');
  };
  const service = createHostedService({ client, url, publishableKey, policyText, fetchImpl, uuid: randomUUID, recoveryStorage, draftStoreFactory });
  return { service, client, calls, uploads, oauth, recoveryStorage, authChange(value) { session = value; authHandler?.('SIGNED_IN', session); } };
}

const draftKey = Buffer.alloc(32, 19).toString('base64url');
function draftHarness({ beginning, loading, removing, audio = wav(), durationSeconds = 1 } = {}) {
  const stores = [], removed = [], entered = deferred(); let row = null, loads = 0;
  const same = (a, b) => a?.ownerId === b.ownerId && a.recordingId === b.recordingId && a.requestId === b.requestId;
  const factory = options => {
    const store = {
      options, closed: false, key: null,
      async begin(id, key) { store.key = key; entered.resolve(); await beginning; row = { ...id }; },
      append() { if (store.closed) throw new Error('Closed writer'); }, async flush() {},
      async load(id, key) { loads++; assert.equal(key, draftKey); store.key = key; await loading; return { blob: audio, durationSeconds, ...id }; },
      async remove(id) { removed.push(id); await removing?.(removed.length, id); if (same(row, id)) row = null; },
      async clearOwner(ownerId) { if (row?.ownerId === ownerId) row = null; },
      close() { store.closed = true; store.key = null; },
    };
    stores.push(store); return store;
  };
  return { factory, stores, removed, entered: entered.promise, get row() { return row; }, get loads() { return loads; } };
}
function interruptedDraft({ drafts = draftHarness(), failStage } = {}) {
  const marker = { userId, recordingId: randomUUID(), requestId: randomUUID(), kind: 'live', createdAt: Date.now(), phase: 'active' };
  const audioUrl = `${url}/storage/v1/object/sign/recordings/${userId}/${marker.recordingId}/audio.wav`;
  const f = fixture({ draftStoreFactory: drafts.factory, handle: call => {
    if (call.path.includes('/draft-key/')) return failStage === 'key' ? response({ error: 'Not found.' }, 404)
      : response({ recordingId: marker.recordingId, requestId: marker.requestId, draftKey });
    if (call.path.endsWith('/finish')) return failStage === 'finish' ? response({ error: 'Not found.' }, 404)
      : response({ recordingId: marker.recordingId, complete: false, text: '' });
    if (call.path === `/recordings/${marker.recordingId}`) return failStage === 'recording' ? response({ error: 'Not found.' }, 404)
      : response({ audioUrl, recording: { id: marker.recordingId, transcript: '', report: null } });
    if (call.path === audioUrl) return new Response(wav());
  } });
  f.recoveryStorage.setItem(`neeley-pending:${url}:${userId}`, JSON.stringify(marker));
  return { ...f, marker, drafts };
}

test('hosted configuration is off only when absent and rejects partial or secret configuration', () => {
  assert.equal(readHostedConfig({}), null);
  assert.deepEqual(readHostedConfig({ VITE_SUPABASE_URL: `${url}/`, VITE_SUPABASE_PUBLISHABLE_KEY: publishableKey }), { url, publishableKey });
  for (const env of [
    { VITE_SUPABASE_URL: url }, { VITE_SUPABASE_PUBLISHABLE_KEY: publishableKey },
    { VITE_SUPABASE_URL: url, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_do-not-ship' },
    { VITE_SUPABASE_URL: 'http://pilot.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: publishableKey },
    { VITE_SUPABASE_URL: `${url}/evil`, VITE_SUPABASE_PUBLISHABLE_KEY: publishableKey },
    { VITE_SUPABASE_URL: 'https://secret@pilot.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: publishableKey },
  ]) assert.throws(() => readHostedConfig(env));
});

test('authentication refresh does not start paid speech compute', async () => {
  const f = fixture();
  f.service.onAuthChange(() => {});
  f.authChange(firstSession);
  f.authChange(secondSession);
  await new Promise(setImmediate);
  assert.equal(f.service.prepareSpeech, undefined);
  assert.equal(f.calls.length, 0);
});

test('current work survives a same-tab service restart without any paid or cloud request', async () => {
  const original = fixture(); await original.service.getIdentity();
  const snapshot = { ownerId: userId, recordingId: randomUUID(), transcript: 'An edited transcript.', transcriptBasis: 'Original transcript.', targetScript: 'A draft plan.' };
  assert.equal(original.service.saveCurrentRehearsal(snapshot), true);
  const refreshed = fixture({ recoveryStorage: original.recoveryStorage }); await refreshed.service.getIdentity();
  assert.equal(refreshed.service.readCurrentRehearsal().recordingId, snapshot.recordingId);
  assert.equal(refreshed.service.readCurrentRehearsal().transcript, snapshot.transcript);
  assert.equal(refreshed.service.readCurrentRehearsal().transcriptBasis, snapshot.transcriptBasis);
  assert.equal(original.calls.length + refreshed.calls.length, 0);
  assert.equal(refreshed.service.saveCurrentRehearsal({ ...snapshot, ownerId: secondSession.user.id }), false);
});

test('current rehearsal clears on confirmed sign-out, account switch, explicit reset and matching deletion', async () => {
  for (const mode of ['signout', 'account', 'reset', 'delete']) {
    const f = fixture(); f.service.onAuthChange(() => {}); await f.service.getIdentity();
    const recordingId = randomUUID();
    f.service.saveCurrentRehearsal({ ownerId: userId, recordingId, transcript: 'Private current work.' });
    if (mode === 'signout') await f.service.signOut();
    if (mode === 'account') f.authChange(secondSession);
    if (mode === 'reset') f.service.clearCurrentRehearsal();
    if (mode === 'delete') {
      await f.service.request(`/api/recordings/${randomUUID()}`, { method: 'DELETE' });
      assert.equal(f.service.readCurrentRehearsal().recordingId, recordingId);
      await f.service.request(`/api/recordings/${recordingId}`, { method: 'DELETE' });
    }
    assert.equal(f.service.readCurrentRehearsal(), null);
    assert.equal(f.recoveryStorage.getItem(`neeley-current:${url}:${userId}`), null);
  }
});

test('failed sign-out leaves the current work available to its still-signed-in owner', async () => {
  const f = fixture(); await f.service.getIdentity();
  f.service.saveCurrentRehearsal({ ownerId: userId, recordingId: randomUUID(), transcript: 'Keep my work.' });
  f.client.auth.signOut = async () => ({ error: new Error('Network unavailable') });
  await assert.rejects(f.service.signOut(), /Sign-out could not finish/);
  assert.equal(f.service.readCurrentRehearsal().transcript, 'Keep my work.');
});

test('opt-in progress delivers ordered server milestones and the unchanged final result', async () => {
  const final = { analysis: { method: 'ai', overallRating: 80 }, transcript: 'Café practice.' };
  for (const cached of [false, true]) {
    const stages = cached ? ['cached_result'] : coachStages;
    const bytes = new TextEncoder().encode(progressFrames(stages).concat({ type: 'result', data: final }).map(event => JSON.stringify(event)).join('\n') + '\n');
    const f = fixture({ handle: call => call.path === '/analyze-text' ? new Response(new ReadableStream({
      start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); },
    }), { headers: { 'Content-Type': 'application/x-ndjson' } }) : undefined });
    const events = [];
    const report = await f.service.request('/api/analyze-text', { body: { recordingId: randomUUID(), text: 'Café practice.' }, onProgress: event => events.push(event) });
    assert.deepEqual(report, final); assert.deepEqual(events, progressFrames(stages));
    assert.equal(f.calls.at(-1).headers.Accept, 'application/x-ndjson'); assert.equal(f.calls.length, 1);
  }
});

test('progress is opt-in, supports older JSON responses, and cannot change request credentials', async () => {
  const f = fixture();
  const body = { recordingId: randomUUID(), text: 'Practice.' };
  await f.service.request('/api/analyze-text', { body });
  assert.equal(f.calls.at(-1).headers.Accept, undefined);
  let callbacks = 0;
  const report = await f.service.request('/api/analyze-text', { body, onProgress: () => callbacks++ });
  assert.deepEqual(report, { analysis: { method: 'ai' } }); assert.equal(callbacks, 0);
  assert.equal(f.calls.at(-1).headers.Authorization, 'Bearer private-session-token');
});

test('transcription progress starts on the paid POST after the single validated audio upload', async () => {
  const stages = ['accepted', 'audio_validated', 'speech_requested', 'transcript_received', 'saved'];
  const f = fixture({ handle: call => call.path === '/transcribe' ? ndjson([
    ...progressFrames(stages), { type: 'result', data: { text: 'Practice.', recordingId: call.body.recordingId } },
  ]) : undefined });
  const seen = [];
  const result = await f.service.request('/api/transcribe', { body: wav(), onProgress: event => seen.push(event.stage) });
  assert.equal(result.text, 'Practice.'); assert.deepEqual(seen, stages); assert.equal(f.uploads.length, 1);
  assert.equal(f.uploads[0].headers.Accept, undefined); assert.equal(f.calls.at(-1).headers.Accept, 'application/x-ndjson');
});

test('stream failures preserve retry IDs unless the server confirms a terminal failed job', async () => {
  for (const jobState of [undefined, 'failed']) {
    let first = true;
    const f = fixture({ handle: call => {
      if (call.path === '/analyze-text' && first) { first = false; return ndjson([
        ...progressFrames(['accepted', 'coach_requested']), { type: 'error', error: 'Coaching unavailable.', status: 502, ...(jobState ? { jobState } : {}) },
      ]); }
    } });
    const body = { recordingId: randomUUID(), text: 'Practice.' }, seen = [];
    await assert.rejects(f.service.request('/api/analyze-text', { body, onProgress: event => seen.push(event.stage) }), { status: 502 });
    assert.deepEqual(seen, ['accepted', 'coach_requested']);
    await f.service.request('/api/analyze-text', { body, onProgress: () => {} });
    assert.equal(f.calls[0].body.requestId === f.calls[1].body.requestId, !jobState);
  }
});

test('malformed, oversized, out-of-order and truncated streams fail without invented completion', async () => {
  const valid = progressFrames(coachStages);
  for (const events of [
    [], [{ type: 'progress', stage: 'model_thinking' }], progressFrames(['accepted', 'saved']),
    progressFrames(['accepted', 'accepted']), [{ type: 'progress', stage: 'accepted', secret: 'extra' }],
    [{ type: 'result', data: {} }], valid, [...valid, { type: 'result', data: {} }, { type: 'result', data: {} }],
    [{ type: 'error', status: 200, error: 'Invalid' }], [{ type: 'error', status: 502, error: 'x'.repeat(501) }],
  ]) {
    const f = fixture({ handle: call => call.path === '/analyze-text' ? ndjson(events) : undefined });
    await assert.rejects(f.service.request('/api/analyze-text', { body: { recordingId: randomUUID(), text: 'Practice.' }, onProgress: () => {} }), { status: 502 });
    assert.equal(f.calls.length, 1);
  }
  for (const content of ['{bad json}\n', JSON.stringify({ type: 'result', data: {} }), 'x'.repeat(2 * 1024 * 1024 + 1)]) {
    const f = fixture({ handle: () => new Response(content, { headers: { 'Content-Type': 'application/x-ndjson' } }) });
    await assert.rejects(f.service.request('/api/analyze-text', { body: { recordingId: randomUUID(), text: 'Practice.' }, onProgress: () => {} }), { status: 502 });
  }
});

test('cancel, dispose and account changes cancel stalled stream readers and suppress further progress', async () => {
  for (const mode of ['cancel', 'dispose', 'account']) {
    const started = deferred(); let canceled = false;
    const f = fixture({ handle: call => call.path === '/analyze-text' ? new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'progress', stage: 'accepted' }) + '\n')); },
      cancel() { canceled = true; return new Promise(() => {}); },
    }), { headers: { 'Content-Type': 'application/x-ndjson' } }) : undefined });
    f.service.onAuthChange(() => {}); f.authChange(firstSession);
    const controller = new AbortController(), seen = [];
    const pending = f.service.request('/api/analyze-text', { body: { recordingId: randomUUID(), text: 'Practice.' }, signal: controller.signal,
      onProgress: event => { seen.push(event.stage); started.resolve(); } });
    await started.promise;
    if (mode === 'cancel') controller.abort();
    else if (mode === 'dispose') f.service.dispose();
    else f.authChange(secondSession);
    await assert.rejects(pending, error => error.name === 'AbortError' || error.status === 401 || error.status === 410);
    assert.equal(canceled, true); assert.deepEqual(seen, ['accepted']);
  }
});

test('live speech uses the authenticated gateway, saves once, and reuses its recording for coaching', async () => {
  let id;
  const { service, calls, uploads } = fixture({ handle: call => {
    if (call.path === '/live-sessions') {
      id = call.body.recordingId;
      return response({ recordingId: id, bucket: 'recordings', storagePath: `${userId}/${id}/audio.wav` });
    }
    if (call.path.endsWith('/prepare')) return response({ ready: true });
    if (call.path.includes('/chunks/')) return response({ recordingId: id, sequence: 0, nextSequence: 1, text: 'Um, practice helps.' });
    if (call.path.endsWith('/finish')) return response({ recordingId: id, complete: true, text: 'Um, practice helps.' });
  } });
  const stream = createRealtimeSocketFixture();
  let saved;
  service.setRecordingSavedHandler((blob, recordingId) => { saved = { blob, recordingId }; });
  const audio = wav();
  const live = service.startLiveSession({ sampleRate: 16000, encodeAudio: () => audio, WebSocketImpl: stream.WebSocketImpl });
  live.push(new Float32Array(16000));
  const result = await live.finish(audio);
  assert.equal(result.complete, true); assert.equal(result.recordingId, id);
  assert.deepEqual(saved, { blob: audio, recordingId: id });
  await live.finish(audio);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].path, `/recordings/${id}/audio`);
  assert.equal(uploads[0].headers.Authorization, 'Bearer private-session-token');
  assert.equal(uploads[0].headers['Content-Type'], 'audio/wav');
  assert.equal(uploads[0].body, audio);
  assert.equal(calls.filter(call => call.path === '/recordings').length, 0);
  assert.equal(calls.some(call => call.path.includes('/chunks/') || call.path.endsWith('/prepare')), false);
  assert.equal(stream.sockets[0].url, 'wss://pilot.supabase.co/functions/v1/rehearsal-api/live-stream');
  const auth = stream.sockets[0].messages.find(message => message.type === 'start');
  assert.equal(auth.token, 'private-session-token');
  assert.equal(auth.recordingId, id);
  assert.equal(stream.consumedSamples, 24000);
  await service.request('/api/analyze-text', { body: { recordingId: id, text: result.text } });
  assert.equal(calls.at(-1).body.recordingId, id);
});

test('signed-out startup sends nothing; transcription requires OAuth and unsupported routes cannot send data', async () => {
  const { service, calls, uploads } = fixture({ signedIn: false });
  const config = await service.request('/api/config');
  assert.equal(config.hosted, true); assert.equal(config.localSpeech, false); assert.equal(config.liveTranscription, false);
  assert.equal(config.auth.signedIn, false);
  assert.ok(!JSON.stringify(config).includes('token'));
  await assert.rejects(service.request('/api/transcribe', { body: wav() }), { status: 401 });
  await assert.rejects(service.request('/api/welcome-preference'), { status: 401 });
  await assert.rejects(service.request('https://evil.example/steal'), { status: 404 });
  await assert.rejects(service.request('/api/settings', { body: { analysisApiKey: 'never-send' } }), { status: 404 });
  assert.equal(calls.length, 0); assert.equal(uploads.length, 0);
});

test('welcome preferences use the authenticated gateway and only send the checkbox choice', async () => {
  const sessionId = randomUUID();
  const f = fixture({ handle: call => call.path === '/welcome-preference' ? response({ signInCount: 3, dontShowAgain: call.body?.dontShowAgain ?? false, sessionId }) : undefined });
  assert.deepEqual(await f.service.request('/api/welcome-preference'), { signInCount: 3, dontShowAgain: false, sessionId });
  assert.deepEqual(await f.service.request('/api/welcome-preference', { method: 'POST', body: { dontShowAgain: true } }), { signInCount: 3, dontShowAgain: true, sessionId });
  assert.deepEqual(f.calls.map(call => [call.path, call.method, call.body]), [['/welcome-preference', 'GET', undefined], ['/welcome-preference', 'POST', { dontShowAgain: true }]]);
  assert.ok(f.calls.every(call => call.headers.Authorization === 'Bearer private-session-token'));
});

test('welcome preference transport rejects forged identity and invalid response before showing a tutorial', async () => {
  const value = { signInCount: 3, dontShowAgain: false, sessionId: randomUUID() };
  for (const options of [{ method: 'DELETE' }, { body: { signInCount: 0 } }, { method: 'POST', body: {} }, { method: 'POST', body: { dontShowAgain: 'true' } },
    { method: 'POST', body: { dontShowAgain: true, userId } }, { method: 'POST', body: { dontShowAgain: true, signInCount: 0 } }]) {
    const f = fixture();await assert.rejects(f.service.request('/api/welcome-preference', options), { status: 400 });assert.equal(f.calls.length, 0);
  }
  for (const invalid of [null, [], {}, { ...value, signInCount: -1 }, { ...value, signInCount: 5 }, { ...value, signInCount: 1.5 }, { ...value, dontShowAgain: 'false' }, { ...value, sessionId: 'not-a-session' }, { ...value, userId }]) {
    const f = fixture({ handle: () => response(invalid) });await assert.rejects(f.service.request('/api/welcome-preference'), { status: 502 });
  }
});

test('account changes discard a pending welcome preference response', async () => {
  const entered = deferred(), ready = deferred();
  const f = fixture({ handle: async call => { if (call.path === '/welcome-preference') { entered.resolve();await ready.promise;return response({ signInCount: 1, dontShowAgain: false, sessionId: randomUUID() }); } } });
  f.service.onAuthChange(() => {});
  const pending = f.service.request('/api/welcome-preference');await entered.promise;
  f.authChange(secondSession);ready.resolve();
  await assert.rejects(pending, error => error.name === 'AbortError' || error.status === 401);
});

test('sign-out, account changes and disposal close a live socket before more private audio can leave', async () => {
  for (const action of ['signout', 'account', 'dispose']) {
    let id;
    const f = fixture({ handle: call => {
      if (call.path === '/live-sessions') {
        id = call.body.recordingId;
        return response({ recordingId: id, bucket: 'recordings', storagePath: `${userId}/${id}/audio.wav` });
      }
    } });
    f.service.onAuthChange(() => {});
    const stream = createRealtimeSocketFixture();
    const live = f.service.startLiveSession({ sampleRate: 16000, WebSocketImpl: stream.WebSocketImpl });
    live.push(new Float32Array(1600));
    await new Promise(setImmediate);
    assert.equal(stream.sockets[0].readyState, 1);
    if (action === 'dispose') f.service.dispose();
    else f.authChange(action === 'account' ? secondSession : null);
    assert.equal(stream.sockets[0].readyState, 3);
    const count = stream.sockets[0].frames.length;
    assert.throws(() => live.push(new Float32Array(1600)), { name: 'AbortError' });
    assert.equal(stream.sockets[0].frames.length, count);
    await assert.rejects(live.finish(wav()), { name: 'AbortError' });
    assert.equal(f.uploads.length, 0);
  }
});

test('Google and Microsoft are the only sign-in choices and Azure includes email scope', async () => {
  const { service, oauth } = fixture();
  await service.signIn('google', 'https://capt-lando.github.io/neeley-dress-rehearsal/');
  await service.signIn('azure', 'https://capt-lando.github.io/neeley-dress-rehearsal/');
  assert.deepEqual(oauth.map(value => value.provider), ['google', 'azure']);
  assert.equal(oauth[1].options.scopes, 'email');
  await assert.rejects(service.signIn('email', url));
  await assert.rejects(service.signIn('google', `${url}/?token=secret`));
});

test('one explicit transcription saves a private WAV, sends a job ID, and reuses it after uncertain network failure', async () => {
  let fail = true;
  const { service, uploads, calls } = fixture({ handle: call => { if (call.path === '/transcribe' && fail) { fail = false; throw new TypeError('Network lost'); } } });
  const audio = wav();
  await assert.rejects(service.request('/api/transcribe', { body: audio }));
  const result = await service.request('/api/transcribe', { body: audio });
  assert.equal(result.text, 'Um, practice helps.');
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].path, `/recordings/${result.recordingId}/audio`);
  assert.equal(uploads[0].headers.Authorization, 'Bearer private-session-token');
  assert.equal(uploads[0].headers['Content-Type'], 'audio/wav');
  assert.equal(uploads[0].body, audio);
  assert.equal(calls.find(call => call.path === '/recordings').body.durationSeconds, 1);
  const jobs = calls.filter(call => call.path === '/transcribe');
  assert.equal(jobs[0].body.requestId, jobs[1].body.requestId);
  assert.equal(jobs[0].headers.Authorization, 'Bearer private-session-token');
  assert.ok(!JSON.stringify(jobs[0].body).includes('private-session-token'));
});

test('the hosted client saves a full fifteen-minute WAV and rejects one extra sample or byte-limit overflow before upload', async () => {
  const signedOut = fixture({ signedIn: false });
  const config = await signedOut.service.request('/api/config');
  assert.equal(config.maxDurationSeconds, 900); assert.equal(config.maxAudioBytes, 30 * 1024 * 1024);
  const f = fixture(), audio = wav(900);
  await f.service.request('/api/transcribe', { body: audio });
  assert.equal(f.uploads.length, 1); assert.equal(f.uploads[0].body, audio);
  assert.equal(f.calls.find(call => call.path === '/recordings').body.durationSeconds, 900);
  assert.equal(audio.size, 28_800_044);
  const tooLong = fixture();
  await assert.rejects(tooLong.service.request('/api/transcribe', { body: wav(900, 1) }), /15 minutes/);
  assert.equal(tooLong.calls.length, 0);
  const tooLarge = fixture();
  await assert.rejects(tooLarge.service.request('/api/transcribe', {
    body: new Blob([new Uint8Array(30 * 1024 * 1024 + 1)], { type: 'audio/wav' }),
  }), { status: 413 });
  assert.equal(tooLarge.calls.length, 0);
});

test('definite failed jobs require a new request ID on the next explicit retry; changed coaching gets a new ID', async () => {
  let fail = true;
  const { service, calls } = fixture({ handle: call => { if (call.path === '/transcribe' && fail) { fail = false; return response({ error: 'Speech provider failed.', jobState: 'failed' }, 502); } } });
  const audio = wav();
  await assert.rejects(service.request('/api/transcribe', { body: audio }), { status: 502 });
  const result = await service.request('/api/transcribe', { body: audio });
  const jobs = calls.filter(call => call.path === '/transcribe');
  assert.notEqual(jobs[0].body.requestId, jobs[1].body.requestId);
  const body = { recordingId: result.recordingId, text: 'Um, practice helps.' };
  await service.request('/api/analyze-text', { body }); await service.request('/api/analyze-text', { body });
  await service.request('/api/analyze-text', { body: { ...body, text: 'Practice helps everyone.' } });
  const coaching = calls.filter(call => call.path === '/analyze-text');
  assert.notEqual(coaching[0].body.requestId, coaching[1].body.requestId);
  assert.notEqual(coaching[1].body.requestId, coaching[2].body.requestId);
});

test('updating unchanged text after a completed report requests fresh coaching in JSON and streaming modes', async () => {
  for (const streaming of [false, true]) {
    const completed = new Map();
    const f = fixture({ handle: call => {
      if (call.path !== '/analyze-text') return;
      const cached = completed.has(call.body.requestId);
      if (!cached) completed.set(call.body.requestId, { transcript: call.body.text,
        analysis: { method: 'ai', reviewNumber: completed.size + 1 } });
      const result = completed.get(call.body.requestId);
      return streaming ? ndjson([...progressFrames(cached ? ['cached_result'] : coachStages), { type: 'result', data: result }]) : response(result);
    } });
    const options = { body: { recordingId: randomUUID(), text: 'The same recorded rehearsal.' }, ...(streaming ? { onProgress() {} } : {}) };
    const first = await f.service.request('/api/analyze-text', options);
    const refreshed = await f.service.request('/api/analyze-text', options);
    assert.equal(first.analysis.reviewNumber, 1);
    assert.equal(refreshed.analysis.reviewNumber, 2, 'an explicit Update must not replay the saved report');
    assert.notEqual(f.calls[0].body.requestId, f.calls[1].body.requestId);
    assert.equal(await f.service.getPendingRequest(), null);
  }
});

test('a lost coaching response retries the same completed job before a later explicit update starts fresh', async () => {
  const completed = new Map(); let first = true;
  const f = fixture({ handle: call => {
    if (call.path !== '/analyze-text') return;
    if (!completed.has(call.body.requestId)) completed.set(call.body.requestId,
      { analysis: { method: 'ai', reviewNumber: completed.size + 1 } });
    if (first) { first = false; throw new TypeError('The completed response was lost'); }
    return response(completed.get(call.body.requestId));
  } });
  const options = { body: { recordingId: randomUUID(), text: 'The same rehearsal.' } };
  await assert.rejects(f.service.request('/api/analyze-text', options), /response was lost/);
  const recovered = await f.service.request('/api/analyze-text', options);
  const refreshed = await f.service.request('/api/analyze-text', options);
  assert.equal(f.calls[0].body.requestId, f.calls[1].body.requestId, 'uncertain completion must not start duplicate paid work');
  assert.equal(recovered.analysis.reviewNumber, 1);
  assert.notEqual(f.calls[1].body.requestId, f.calls[2].body.requestId);
  assert.equal(refreshed.analysis.reviewNumber, 2);
});

test('an in-flight retry keeps its request ID until the completed result is acknowledged', async () => {
  const entered = deferred(), finish = deferred(); let attempts = 0;
  const f = fixture({ handle: async call => {
    if (call.path !== '/analyze-text') return;
    attempts++;
    if (attempts === 1) { entered.resolve(); await finish.promise; }
    else if (attempts === 2) return response({ error: 'This request is still processing.' }, 409);
    return response({ analysis: { method: 'ai' } });
  } });
  const options = { body: { recordingId: randomUUID(), text: 'The same rehearsal.' } };
  const original = f.service.request('/api/analyze-text', options);
  await entered.promise;
  await assert.rejects(f.service.request('/api/analyze-text', options), { status: 409 });
  assert.equal(f.calls[0].body.requestId, f.calls[1].body.requestId);
  finish.resolve(); await original;
  await f.service.request('/api/analyze-text', options);
  assert.notEqual(f.calls[0].body.requestId, f.calls[2].body.requestId);
});

test('same-tab recovery retires a terminal coaching request before updating unchanged text', async () => {
  for (const state of ['completed', 'failed', 'expired', 'cancelled']) {
    const recordingId = randomUUID(), audioUrl = `${url}/storage/v1/object/sign/recordings/${userId}/${recordingId}/audio.wav`;
    let lost = true;
    const f = fixture({ handle: call => {
      if (call.path === '/analyze-text' && lost) { lost = false; throw new TypeError('Response lost'); }
      if (call.path.startsWith('/requests/')) return response({ requestId: call.path.split('/')[2], recordingId, kind: 'coach', state,
        ...(state === 'completed' ? { result: { transcript: 'Practice.', analysis: { method: 'ai' } } } : {}) });
      if (call.path === `/recordings/${recordingId}`) return response({ audioUrl, recording: { id: recordingId, transcript: 'Practice.', report: null } });
      if (call.path === audioUrl) return new Response(wav());
    } });
    const options = { body: { recordingId, text: 'Practice.' } };
    await assert.rejects(f.service.request('/api/analyze-text', options), /Response lost/);
    const marker = await f.service.getPendingRequest();
    const recovered = await f.service.recoverPending(marker);
    assert.equal(recovered.state, state);
    await f.service.request('/api/analyze-text', options);
    const requests = f.calls.filter(call => call.path === '/analyze-text');
    assert.equal(requests.length, 2);
    assert.notEqual(requests[0].body.requestId, requests[1].body.requestId, `${state} recovery must retire the acknowledged ID`);
  }
});

test('explicit retries rotate IDs only for confirmed terminal failures, including a busy speech provider', async () => {
  for (const path of ['/transcribe', '/analyze-text']) {
    for (const [status, jobState] of [[429, 'failed'], [409, 'failed'], [429, undefined], [409, undefined], [502, undefined], [504, undefined]]) {
      let reject = true;
      const { service, calls, uploads } = fixture({ handle: call => {
        if (call.path === path && reject) { reject = false; return response({ error: 'Try again.', ...(jobState ? { jobState } : {}) }, status); }
      } });
      const options = path === '/transcribe' ? { body: wav() } : { body: { recordingId: randomUUID(), text: 'Practice helps.' } };
      await assert.rejects(service.request(`/api${path}`, options), { status });
      await service.request(`/api${path}`, options);
      const jobs = calls.filter(call => call.path === path);
      assert.equal(jobs.length, 2);
      assert.equal(jobs[0].body.requestId === jobs[1].body.requestId, jobState !== 'failed', `${path} ${status} ${jobState}`);
      assert.equal(uploads.length, path === '/transcribe' ? 1 : 0);
    }
  }
});

test('invalid audio and malicious storage destinations fail before uploading', async () => {
  const { service, uploads, calls } = fixture({ handle: call => call.path === '/recordings' ? response({ id: call.body.id, bucket: 'recordings', storagePath: `other-user/${call.body.id}/audio.wav` }) : null });
  await assert.rejects(service.request('/api/transcribe', { body: new Blob(['not WAV']) }));
  assert.equal(calls.length, 0);
  await assert.rejects(service.request('/api/transcribe', { body: wav() }), /upload location/);
  assert.equal(uploads.length, 0);
});

test('deleted recordings are uploaded as a new private take when explicitly transcribed again', async () => {
  const { service, uploads } = fixture();
  const audio = wav(); const first = await service.request('/api/transcribe', { body: audio });
  await service.request(`/api/recordings/${first.recordingId}`, { method: 'DELETE' });
  const second = await service.request('/api/transcribe', { body: audio });
  assert.notEqual(second.recordingId, first.recordingId); assert.equal(uploads.length, 2);
});

test('private history refuses foreign signed audio URLs and disposed sessions reject requests', async () => {
  const { service, calls } = fixture({ handle: call => call.path.startsWith('/recordings/') ? response({ recording: {}, audioUrl: 'https://evil.example/steal' }) : null });
  await assert.rejects(service.openRecording(randomUUID()), /saved audio link/);
  assert.equal(calls.length, 1);
  service.dispose();
  await assert.rejects(service.request('/api/config'), { status: 410 });
});

test('saved audio must match the verified owner and exact recording before any download', async () => {
  const id = randomUUID(), other = randomUUID();
  const path = `/storage/v1/object/sign/recordings/${userId}/${id}/audio.wav`;
  const cases = [
    { audioUrl: `${url}/storage/v1/object/sign/recordings/${secondSession.user.id}/${id}/audio.wav` },
    { audioUrl: `${url}/storage/v1/object/sign/recordings/${userId}/${other}/audio.wav` },
    { audioUrl: `${url}${path}/extra` },
    { audioUrl: `${url}${path.replace('/audio.wav', '/%2e%2e/other/audio.wav')}` },
    { audioUrl: `${url}${path.replace(`${userId}/`, `${userId}%2f`)}` },
    { audioUrl: `${url}${path.replace('audio.wav', 'audio.wav%2fextra')}` },
    { audioUrl: `${url}${path}#other` },
    { audioUrl: `https://other:password@pilot.supabase.co${path}` },
    { audioUrl: 'not a URL' },
    { recording: { id: other } },
    { recording: null },
  ];
  for (const change of cases) {
    const f = fixture({ handle: call => call.path === `/recordings/${id}` ? response({ recording: { id }, audioUrl: `${url}${path}`, ...change }) : null });
    await assert.rejects(f.service.openRecording(id), { status: 502 });
    assert.equal(f.calls.length, 1, JSON.stringify(change));
  }
});

test('valid private audio downloads cannot redirect or send ambient browser credentials', async () => {
  const id = randomUUID(), audioUrl = `${url}/storage/v1/object/sign/recordings/${userId}/${id}/audio.wav?token=signed-test-token`;
  const f = fixture({ handle: call => call.path === `/recordings/${id}` ? response({ recording: { id, transcript: 'Owned transcript.' }, audioUrl })
    : call.path === audioUrl ? new Response(wav()) : null });
  const record = await f.service.openRecording(id.toUpperCase());
  assert.equal(record.id, id); assert.equal(record.transcript, 'Owned transcript.'); assert.equal(record.blob.size, 32044);
  const download = f.calls.at(-1);
  assert.equal(download.redirect, 'error'); assert.equal(download.credentials, 'omit'); assert.equal(download.referrerPolicy, 'no-referrer');
  assert.equal(download.headers, undefined);
});

test('cancel, account change, and disposal abort pending saved-audio downloads', async () => {
  for (const stop of ['cancel', 'account', 'dispose']) {
    const id = randomUUID(), audioUrl = `${url}/storage/v1/object/sign/recordings/${userId}/${id}/audio.wav`;
    const entered = deferred(); let downloadSignal;
    const f = fixture({ handle: call => {
      if (call.path === `/recordings/${id}`) return response({ recording: { id }, audioUrl });
      if (call.path === audioUrl) {
        downloadSignal = call.signal; entered.resolve();
        return new Promise((_resolve, reject) => call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true }));
      }
    } });
    f.service.onAuthChange(() => {}); f.authChange(firstSession);
    const opening = f.service.openRecording(id);
    const rejected = assert.rejects(opening, error => error.name === 'AbortError' || error.status === 401 || error.status === 410);
    await entered.promise;
    if (stop === 'cancel') await f.service.cancelCurrentRequest();
    if (stop === 'account') f.authChange(secondSession);
    if (stop === 'dispose') f.service.dispose();
    await rejected;
    assert.equal(downloadSignal.aborted, true, stop);
    assert.equal(f.uploads.length, 0);
  }
});

test('an account switch during session lookup rejects stale tokens before any network mutation', async () => {
  const f = fixture(); f.service.onAuthChange(() => {}); f.authChange(firstSession);
  const lookup = deferred(); f.client.auth.getSession = () => lookup.promise;
  const sending = f.service.request('/api/events', { body: { events: [] } });
  f.authChange(secondSession); lookup.resolve({ data: { session: firstSession } });
  await assert.rejects(sending, { status: 401 });
  assert.equal(f.calls.length, 0);
});

test('an account switch during response decoding cannot return a prior account response', async () => {
  const body = deferred(), entered = deferred();
  const f = fixture({ handle: call => { if (call.path === '/recordings') { entered.resolve(); return { ok: true, json: () => body.promise }; } } });
  f.service.onAuthChange(() => {}); f.authChange(firstSession);
  const reading = f.service.request('/api/recordings'); await entered.promise;
  f.authChange(secondSession); body.resolve({ recordings: [{ title: 'Private to previous account' }] });
  await assert.rejects(reading, error => error.name === 'AbortError' || error.status === 401);
});

test('an account switch while reading WAV metadata prevents creating or uploading a recording', async () => {
  const header = deferred(), entered = deferred(), bytes = await wav().slice(0, 44).arrayBuffer();
  const f = fixture(); f.service.onAuthChange(() => {}); f.authChange(firstSession);
  const file = { size: 32044, arrayBuffer: async () => new ArrayBuffer(32044), slice: () => ({ arrayBuffer: () => { entered.resolve(); return header.promise; } }) };
  const sending = f.service.request('/api/transcribe', { body: file }); await entered.promise;
  f.authChange(secondSession); header.resolve(bytes);
  await assert.rejects(sending, { status: 401 });
  assert.equal(f.calls.length, 0); assert.equal(f.uploads.length, 0);
});

test('an account switch during gateway upload cannot mark the prior recording saved or start inference', async () => {
  const uploaded = deferred(), entered = deferred();
  const f = fixture({ handle: async call => { if (call.path.endsWith('/audio')) { entered.resolve(); await uploaded.promise; } } });
  f.service.onAuthChange(() => {}); f.authChange(firstSession);
  let saved = 0; f.service.setRecordingSavedHandler(() => saved++);
  const sending = f.service.request('/api/transcribe', { body: wav() }); await entered.promise;
  f.authChange(secondSession); uploaded.resolve({});
  await assert.rejects(sending, error => error.name === 'AbortError' || error.status === 401);
  assert.equal(saved, 0); assert.equal(f.calls.filter(call => call.path === '/transcribe').length, 0);
  assert.equal(f.calls.some(call => call.method === 'DELETE'), false);
});

test('simultaneous transcription requests coalesce reservation and authenticated audio upload', async () => {
  const entered=deferred(),uploaded=deferred();
  const f=fixture({handle:async call=>{if(call.path.endsWith('/audio')){entered.resolve();await uploaded.promise;}}});
  const audio=wav();let saved=0;f.service.setRecordingSavedHandler(()=>saved++);
  const first=f.service.request('/api/transcribe',{body:audio});await entered.promise;
  const second=f.service.request('/api/transcribe',{body:audio});await new Promise(setImmediate);
  assert.equal(f.calls.filter(call=>call.path==='/recordings').length,1);assert.equal(f.uploads.length,1);
  uploaded.resolve();const results=await Promise.all([first,second]);
  assert.equal(results[0].recordingId,results[1].recordingId);assert.equal(saved,1);
  const jobs=f.calls.filter(call=>call.path==='/transcribe');assert.equal(jobs[0].body.requestId,jobs[1].body.requestId);
});

test('uncertain audio upload keeps its reservation and retries identical bytes without deleting a saved take', async () => {
  let lost=true;
  const f=fixture({handle:call=>{if(call.path.endsWith('/audio')&&lost){lost=false;throw new TypeError('Reply lost after storage');}}});
  const audio=wav();let saved=0;f.service.setRecordingSavedHandler(()=>saved++);
  await assert.rejects(f.service.request('/api/transcribe',{body:audio}));
  assert.equal(saved,0);assert.equal(f.calls.some(call=>call.method==='DELETE'),false);
  await f.service.request('/api/transcribe',{body:audio});
  assert.equal(f.calls.filter(call=>call.path==='/recordings').length,1);
  assert.equal(f.uploads.length,2);assert.equal(f.uploads[0].path,f.uploads[1].path);
  assert.equal(f.uploads[0].body,audio);assert.equal(f.uploads[1].body,audio);assert.equal(saved,1);
});

test('definite format rejection cleans an empty reservation; failed cleanup retains the ID for safe retry', async () => {
  for(const cleanupFails of [false,true]) {
    let rejected=false;
    const f=fixture({handle:call=>{
      if(call.path.endsWith('/audio')&&!rejected){rejected=true;return response({error:'Invalid WAV.'},415);}
      if(call.method==='DELETE'&&cleanupFails)return response({error:'Try later.'},503);
    }});
    const audio=wav();await assert.rejects(f.service.request('/api/transcribe',{body:audio}),{status:415});
    assert.equal(f.calls.filter(call=>call.method==='DELETE').length,1);
    assert.equal(f.calls.filter(call=>call.path==='/transcribe').length,0);
    await f.service.request('/api/transcribe',{body:audio});
    assert.equal(f.uploads[0].path===f.uploads[1].path,cleanupFails);
    assert.equal(f.calls.filter(call=>call.path==='/recordings').length,cleanupFails?1:2);
  }
});

test('saved-audio acknowledgements must match the exact recording and WAV metadata', async () => {
  for(const patch of [{id:randomUUID()},{stored:false},{sizeBytes:32046},{durationSeconds:600},{durationSeconds:'1'}]) {
    const f=fixture({handle:call=>call.path.endsWith('/audio')?response({id:call.path.split('/')[2],stored:true,sizeBytes:32044,durationSeconds:1,...patch}):undefined});
    let saved=0;f.service.setRecordingSavedHandler(()=>saved++);
    await assert.rejects(f.service.request('/api/transcribe',{body:wav()}),{status:502});
    assert.equal(saved,0);assert.equal(f.calls.some(call=>call.path==='/transcribe'||call.method==='DELETE'),false);
  }
});

test('cancelled gateway upload cannot report success or start inference and a retry reuses its ID', async () => {
  const entered=deferred(),uploaded=deferred();let first=true;
  const f=fixture({handle:async call=>{if(call.path.endsWith('/audio')&&first){first=false;entered.resolve();await uploaded.promise;}}});
  const audio=wav(),controller=new AbortController();let saved=0;f.service.setRecordingSavedHandler(()=>saved++);
  const sending=f.service.request('/api/transcribe',{body:audio,signal:controller.signal});await entered.promise;
  controller.abort();uploaded.resolve();await assert.rejects(sending,{name:'AbortError'});
  assert.equal(saved,0);assert.equal(f.uploads[0].signal.aborted,true);
  assert.equal(f.calls.some(call=>call.method==='DELETE'||call.path==='/transcribe'),false);
  await f.service.request('/api/transcribe',{body:audio});
  assert.equal(f.calls.filter(call=>call.path==='/recordings').length,1);assert.equal(f.uploads[0].path,f.uploads[1].path);
});

test('failed live saving never finalizes a report and explicit cancelled-session fallback reuses the audio endpoint', async () => {
  let id,rejectUpload=true;
  const f=fixture({handle:call=>{
    if(call.path==='/live-sessions'){id=call.body.recordingId;return response({recordingId:id,bucket:'recordings',storagePath:`${userId}/${id}/audio.wav`});}
    if(call.path.endsWith('/prepare'))return response({ready:true});
    if(call.path.includes('/chunks/'))return response({recordingId:id,sequence:0,nextSequence:1,text:'Um, practice helps.'});
    if(call.path.endsWith('/audio')&&rejectUpload){rejectUpload=false;return response({error:'Storage unavailable.'},503);}
  }});
  const audio=wav();let saved=0;f.service.setRecordingSavedHandler(()=>saved++);
  const live=f.service.startLiveSession({sampleRate:16000,encodeAudio:()=>audio,WebSocketImpl:createRealtimeSocketFixture().WebSocketImpl});live.push(new Float32Array(16000));
  await assert.rejects(live.finish(audio),{status:503});await assert.rejects(live.finish(audio),{status:503});
  assert.equal(f.uploads.length,1);assert.equal(saved,0);assert.equal(f.calls.some(call=>call.path.endsWith('/finish')),false);
  live.cancel();await new Promise(setImmediate);
  const result=await f.service.request('/api/transcribe',{body:audio});
  assert.equal(result.recordingId,id);assert.equal(saved,1);
  assert.equal(f.calls.filter(call=>call.path==='/recordings').length,0);
  assert.equal(f.uploads.length,2);assert.equal(f.uploads[0].path,f.uploads[1].path);
});

test('refresh decrypts only the verified owner draft, saves the same recording, and never starts coaching', async () => {
  const f = interruptedDraft();
  const result = await f.service.recoverPending(f.marker);
  assert.equal(result.record.id, f.marker.recordingId); assert.equal(result.record.transcript, '');
  assert.equal(f.drafts.loads, 1); assert.equal(f.uploads.length, 1);
  assert.equal(f.uploads[0].path, `/recordings/${f.marker.recordingId}/audio`);
  assert.deepEqual(f.calls.filter(call => call.path.includes('/draft-key/')).map(call => call.path), [`/live-sessions/${f.marker.recordingId}/draft-key/${f.marker.requestId}`]);
  assert.equal(f.calls.some(call => ['/recordings', '/transcribe', '/analyze-text'].includes(call.path)), false);
  assert.equal(await f.service.getPendingRequest(), null);
  assert.ok(f.drafts.stores.every(store => store.closed && store.key === null));
  const other = interruptedDraft(); other.service.onAuthChange(() => {}); other.authChange(firstSession); other.authChange(secondSession);
  await assert.rejects(other.service.recoverPending(other.marker), { status: 401 });
  assert.equal(other.calls.length, 0); assert.equal(other.drafts.loads, 0);
});

test('only missing draft keys end recovery quietly; later save or reopen404 retains the recovery marker', async () => {
  const missing = interruptedDraft({ failStage: 'key' });
  assert.equal((await missing.service.recoverPending(missing.marker)).record, null);
  assert.equal(missing.drafts.loads, 0); assert.equal(await missing.service.getPendingRequest(), null);
  for (const failStage of ['finish', 'recording']) {
    const f = interruptedDraft({ failStage });
    await assert.rejects(f.service.recoverPending(f.marker), { status: 404 });
    assert.deepEqual(await f.service.getPendingRequest(), f.marker);
    assert.equal(f.drafts.removed.length, 0);
  }
});

test('verified drafts shorter than half a second are discarded without attempting an invalid upload', async () => {
  const f = interruptedDraft({ drafts: draftHarness({ audio: wav(0.25), durationSeconds: 0.25 }) });
  const result = await f.service.recoverPending(f.marker);
  assert.equal(result.record, null); assert.equal(f.uploads.length, 0);
  assert.equal(await f.service.getPendingRequest(), null);
  assert.ok(f.drafts.removed.some(id => id.recordingId === f.marker.recordingId && id.ownerId === userId));
});

test('account changes during draft decryption close the key and cannot save or disclose prior audio', async () => {
  const reading = deferred(), drafts = draftHarness({ loading: reading.promise });
  const f = interruptedDraft({ drafts }); f.service.onAuthChange(() => {}); f.authChange(firstSession);
  const recovery = f.service.recoverPending(f.marker); await new Promise(setImmediate);
  assert.equal(drafts.loads, 1);
  f.authChange(secondSession);
  assert.ok(drafts.stores.every(store => store.closed && store.key === null));
  reading.resolve(); await assert.rejects(recovery, error => error.status === 401 || error.name === 'AbortError');
  assert.equal(f.uploads.length, 0);
  assert.ok(f.recoveryStorage.getItem(`neeley-pending:${url}:${userId}`));
});

test('explicit cancel during draft decryption prevents a late recovery upload', async () => {
  const reading = deferred(), drafts = draftHarness({ loading: reading.promise });
  const f = interruptedDraft({ drafts });
  const recovery = f.service.recoverPending(f.marker); await new Promise(setImmediate);
  assert.equal(drafts.loads, 1);
  await f.service.cancelCurrentRequest();
  reading.resolve(); await assert.rejects(recovery, { name: 'AbortError' });
  assert.equal(f.uploads.length, 0); assert.equal(await f.service.getPendingRequest(), null);
  assert.ok(drafts.stores.every(store => store.closed && store.key === null));
});

test('cancel or account change during either draft cleanup cannot return a stale recovered recording', async () => {
  for (const cleanup of [1, 2]) for (const action of ['cancel', 'account']) {
    const entered = deferred(), removed = deferred();
    const drafts = draftHarness({ removing: async count => { if (count === cleanup) { entered.resolve(); await removed.promise; } } });
    const f = interruptedDraft({ drafts }); f.service.onAuthChange(() => {}); f.authChange(firstSession);
    const recovery = f.service.recoverPending(f.marker);
    await entered.promise;
    if (action === 'cancel') await f.service.cancelCurrentRequest(); else f.authChange(secondSession);
    removed.resolve();
    await assert.rejects(recovery, error => error.name === 'AbortError' || error.status === 401);
    assert.ok(drafts.stores.every(store => store.closed && store.key === null));
  }
});

test('explicit cancel and account changes immediately close active draft writers and keys', async () => {
  for (const mode of ['cancel', 'account']) {
    const drafts = draftHarness();
    const f = fixture({ draftStoreFactory: drafts.factory, handle: call => call.path === '/live-sessions'
      ? response({ recordingId: call.body.recordingId, bucket: 'recordings', storagePath: `${userId}/${call.body.recordingId}/audio.wav`, draftKey }) : undefined });
    f.service.onAuthChange(() => {}); f.authChange(firstSession);
    const live = f.service.startLiveSession({ sampleRate: 16000, WebSocketImpl: createRealtimeSocketFixture().WebSocketImpl });
    live.push(new Float32Array(1600)); await new Promise(setImmediate);
    assert.equal(drafts.stores[0].key, draftKey);
    if (mode === 'cancel') await f.service.cancelCurrentRequest(); else f.authChange(secondSession);
    assert.ok(drafts.stores.every(store => store.closed && store.key === null));
    assert.throws(() => live.push(new Float32Array(1)), { name: 'AbortError' });
    if (mode === 'cancel') { assert.equal(drafts.row, null); assert.equal(await f.service.getPendingRequest(), null); }
    else assert.equal(drafts.row.ownerId, userId, 'account switch preserves encrypted prior-owner recovery data');
  }
});

test('cancel during draft creation waits for the old creation and removes its late manifest', async () => {
  const gate = deferred(), drafts = draftHarness({ beginning: gate.promise });
  const f = fixture({ draftStoreFactory: drafts.factory, handle: call => call.path === '/live-sessions'
    ? response({ recordingId: call.body.recordingId, bucket: 'recordings', storagePath: `${userId}/${call.body.recordingId}/audio.wav`, draftKey }) : undefined });
  f.service.startLiveSession({ sampleRate: 16000, WebSocketImpl: createRealtimeSocketFixture().WebSocketImpl });
  await drafts.entered;
  let done = false; const cancelling = f.service.cancelCurrentRequest().then(value => { done = true; return value; });
  await new Promise(setImmediate);
  assert.equal(drafts.stores[0].closed, true); assert.equal(done, false);
  gate.resolve(); await cancelling; await new Promise(setImmediate);
  assert.equal(drafts.row, null); assert.ok(drafts.stores.every(store => store.key === null));
  assert.equal(await f.service.getPendingRequest(), null); assert.equal(f.uploads.length, 0);
});

test('asynchronous checkpoint storage warnings reach the recording UI', async () => {
  const drafts = draftHarness(), warnings = [];
  const f = fixture({ draftStoreFactory: drafts.factory, handle: call => call.path === '/live-sessions'
    ? response({ recordingId: call.body.recordingId, bucket: 'recordings', storagePath: `${userId}/${call.body.recordingId}/audio.wav`, draftKey }) : undefined });
  f.service.startLiveSession({ sampleRate: 16000, WebSocketImpl: createRealtimeSocketFixture().WebSocketImpl, onRecoveryWarning: message => warnings.push(message) });
  await new Promise(setImmediate); drafts.stores[0].options.onWarning(new Error('Quota exceeded'));
  assert.equal(warnings.length, 1); assert.match(warnings[0], /Refresh recovery is unavailable/); f.service.dispose();
});

test('paid requests persist only account-scoped IDs before sending and survive refresh without resubmitting', async () => {
  let stored, paid = 0;
  const f = fixture({ handle: call => {
    if (call.path !== '/analyze-text') return;
    paid++;
    stored = JSON.parse(f.recoveryStorage.getItem(`neeley-pending:${url}:${userId}`));
    assert.equal(stored.requestId, call.body.requestId);
    assert.equal(stored.recordingId, call.body.recordingId);
    assert.equal(stored.userId, userId);
    assert.doesNotMatch(JSON.stringify(stored), /Private preparation|Private transcript|private-session-token/);
    throw new TypeError('Response lost during refresh');
  } });
  const id = randomUUID();
  await assert.rejects(f.service.request('/api/analyze-text', { body: { recordingId: id, text: 'Private transcript', targetScript: 'Private preparation' } }), /Response lost/);
  const refreshed = fixture({ recoveryStorage: f.recoveryStorage });
  assert.deepEqual(await refreshed.service.getPendingRequest(), stored);
  assert.equal(refreshed.calls.length, 0); assert.equal(paid, 1);
  await assert.rejects(refreshed.service.request('/api/analyze-text', { body: { recordingId: id, text: 'New request' } }), /Recover the previous request/);
  assert.equal(refreshed.calls.length, 0);
});

test('unavailable recovery storage prevents paid requests and a successful response clears its marker', async () => {
  const denied = fixture({ recoveryStorage: { getItem: () => null, setItem() { throw new Error('Denied'); }, removeItem() {} } });
  await assert.rejects(denied.service.request('/api/analyze-text', { body: { recordingId: randomUUID(), text: 'Words' } }), /Allow session storage/);
  assert.equal(denied.calls.length, 0);
  const good = fixture();
  await good.service.request('/api/analyze-text', { body: { recordingId: randomUUID(), text: 'Words' } });
  assert.equal(await good.service.getPendingRequest(), null);
});

test('cancel uses the exact persisted request tombstone, aborts the client wait, and clears the marker only after acknowledgement', async () => {
  const entered = deferred(), delayed = deferred(); let expected;
  const f = fixture({ handle: async call => {
    if (call.path === '/analyze-text') { expected = call.body; entered.resolve(); await delayed.promise; return response({ transcript: 'Too late', analysis: { method: 'ai' } }); }
  } });
  const processing = f.service.request('/api/analyze-text', { body: { recordingId: randomUUID(), text: 'Words' } });
  await entered.promise;
  const result = await f.service.cancelCurrentRequest();
  const cancel = f.calls.find(call => call.path.endsWith('/cancel'));
  assert.equal(cancel.path, `/requests/${expected.requestId}/cancel`);
  assert.deepEqual(cancel.body, { recordingId: expected.recordingId });
  assert.equal(result.cancelled, true); assert.equal(await f.service.getPendingRequest(), null);
  delayed.resolve(); await assert.rejects(processing, { name: 'AbortError' });
  assert.equal(f.calls.filter(call => call.path === '/analyze-text').length, 1);
});

test('unconfirmed cancellation keeps its recovery marker and can be safely retried', async () => {
  let failCancel = true;
  const f = fixture({ handle: call => {
    if (call.path === '/analyze-text') throw new TypeError('Response lost');
    if (call.path.endsWith('/cancel') && failCancel) return response({ error: 'Temporary outage' }, 503);
  } });
  await assert.rejects(f.service.request('/api/analyze-text', { body: { recordingId: randomUUID(), text: 'Words' } }));
  const before = await f.service.getPendingRequest();
  await assert.rejects(f.service.cancelCurrentRequest(), { status: 503 });
  assert.deepEqual(await f.service.getPendingRequest(), { ...before, phase: 'cancelling' });
  failCancel = false; await f.service.cancelCurrentRequest();
  assert.equal(await f.service.getPendingRequest(), null);
});

test('refresh retries unconfirmed cancellation instead of trusting a cancelled job before the connection stops', async () => {
  const original = fixture({ handle: call => {
    if (call.path === '/analyze-text') throw new TypeError('Response lost');
    if (call.path.endsWith('/cancel')) return response({ error: 'Connection has not confirmed stopping' }, 503);
  } });
  await assert.rejects(original.service.request('/api/analyze-text', { body: { recordingId: randomUUID(), text: 'Words' } }));
  await assert.rejects(original.service.cancelCurrentRequest(), { status: 503 });
  let stopped = false;
  const refreshed = fixture({ recoveryStorage: original.recoveryStorage, handle: call => {
    assert.ok(call.path.endsWith('/cancel'), 'cancellation recovery must not poll the already cancelled job or reopen audio');
    if (!stopped) return response({ error: 'Connection has not confirmed stopping' }, 503);
  } });
  const marker = await refreshed.service.getPendingRequest(); assert.equal(marker.phase, 'cancelling');
  await assert.rejects(refreshed.service.recoverPending(marker), { status: 503 });
  assert.deepEqual(await refreshed.service.getPendingRequest(), marker);
  stopped = true;
  const result = await refreshed.service.recoverPending(marker);
  assert.equal(result.state, 'cancelled'); assert.equal(result.record, null);
  assert.match(result.message, /cancellation was confirmed/);
  assert.equal(await refreshed.service.getPendingRequest(), null);
  assert.equal(refreshed.calls.length, 2);
  for (const call of refreshed.calls) {
    assert.equal(call.path, `/requests/${marker.requestId}/cancel`);
    assert.deepEqual(call.body, { recordingId: marker.recordingId });
  }
});

test('chat transport requires sign-in and preserves the explicit request ID and payload on retry', async () => {
  const body = { requestId: randomUUID(), message: 'Help with my opening.', history: [], context: { phase: 'prepare', assignmentInstructions: 'Present for five minutes.\nFinish with one concrete action.', assignmentFileName: 'Assignment instructions.pdf' } };
  const signedOut = fixture({ signedIn: false });
  await assert.rejects(signedOut.service.request('/api/coach-chat', { method: 'POST', body }), { status: 401 });
  assert.equal(signedOut.calls.length, 0);
  const f = fixture({ handle: call => call.path === '/coach-chat' ? response({ requestId: call.body.requestId, model: 'gpt-6-luna', reply: 'Who is your audience?' }) : undefined });
  for (let i = 0; i < 2; i++) {
    const result = await f.service.request('/api/coach-chat', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(result.requestId, body.requestId); assert.equal(result.reply, 'Who is your audience?');
  }
  assert.equal(f.calls.length, 2); assert.equal(f.uploads.length, 0);
  for (const call of f.calls) {
    assert.equal(call.path, '/coach-chat'); assert.deepEqual(call.body, body);
    assert.equal(call.headers.Authorization, 'Bearer private-session-token'); assert.equal(call.headers.apikey, publishableKey);
    assert.equal(call.headers.Accept, undefined);
  }
  assert.equal(await f.service.getPendingRequest(), null);
});

test('chat can run alongside analysis without uploading audio or replacing its recovery marker', async () => {
  const entered = deferred(), finished = deferred();
  const f = fixture({ handle: async call => {
    if (call.path === '/analyze-text') { entered.resolve(); await finished.promise; return response({ analysis: { method: 'ai' } }); }
    if (call.path === '/coach-chat') return response({ requestId: call.body.requestId, model: 'gpt-6-luna', reply: 'We can work on your closing while the report loads.' });
  } });
  const analysis = f.service.request('/api/analyze-text', { body: { recordingId: randomUUID(), text: 'My recommendation.' } });
  await entered.promise;
  const key = `neeley-pending:${url}:${userId}`, before = f.recoveryStorage.getItem(key);
  assert.ok(before);
  await f.service.request('/api/coach-chat', { method: 'POST', body: { requestId: randomUUID(), message: 'Help me with the closing.', context: { phase: 'review' } } });
  assert.equal(f.recoveryStorage.getItem(key), before); assert.equal(f.uploads.length, 0);
  assert.deepEqual(f.calls.map(call => call.path), ['/analyze-text', '/coach-chat']);
  finished.resolve(); await analysis;
  assert.equal(await f.service.getPendingRequest(), null);
});

test('chat cancellation, disposal and account change interrupt stalled JSON bodies', async () => {
  for (const mode of ['abort', 'dispose', 'account']) {
    const entered = deferred(); let canceled = false;
    const f = fixture({ handle: call => call.path === '/coach-chat' ? new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"reply":"unfinished')); entered.resolve(); },
      cancel() { canceled = true; return new Promise(() => {}); },
    })) : undefined });
    f.service.onAuthChange(() => {}); f.authChange(firstSession);
    const controller = new AbortController();
    const pending = f.service.request('/api/coach-chat', { method: 'POST', signal: controller.signal, body: { requestId: randomUUID(), message: 'Help me rehearse.' } });
    await entered.promise;
    if (mode === 'abort') controller.abort();
    else if (mode === 'dispose') f.service.dispose();
    else f.authChange(secondSession);
    await assert.rejects(pending, error => error.name === 'AbortError' || [401, 410].includes(error.status));
    assert.equal(canceled, true); assert.equal(f.calls.length, 1);
  }
});

test('chat refuses mismatched identity, malformed JSON and oversized replies without another request', async () => {
  const requestId = randomUUID(), body = { requestId, message: 'Who is my audience?' };
  const results = [null, [], { requestId: randomUUID(), model: 'gpt-6-luna', reply: 'Wrong message.' },
    { requestId, model: 'other-model', reply: 'Wrong model.' }, { requestId, model: 'gpt-6-luna', reply: '' },
    { requestId, model: 'gpt-6-luna', reply: 'x'.repeat(4001) }];
  for (const value of results) {
    const f = fixture({ handle: () => response(value) });
    await assert.rejects(f.service.request('/api/coach-chat', { method: 'POST', body }), { status: 502 });
    assert.equal(f.calls.length, 1);
  }
  for (const value of ['{bad json}', 'x'.repeat(32769)]) {
    const f = fixture({ handle: () => new Response(value) });
    await assert.rejects(f.service.request('/api/coach-chat', { method: 'POST', body }), { status: 502 });
    assert.equal(f.calls.length, 1);
  }
});

test('chat preserves safe failure states and never silently generates a replacement request ID', async () => {
  for (const jobState of ['failed', 'not_started', undefined]) {
    const body = { requestId: randomUUID(), message: 'Help with my thesis.' };
    const f = fixture({ handle: () => response({ error: 'Chat temporarily unavailable.', ...(jobState ? { jobState } : {}) }, 502) });
    await assert.rejects(f.service.request('/api/coach-chat', { method: 'POST', body }), error => error.status === 502 && error.jobState === jobState);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].body.requestId, body.requestId);
    assert.equal(await f.service.getPendingRequest(), null);
  }
});

test('chat method and request identity are validated before sending', async () => {
  for (const options of [{ body: { requestId: randomUUID(), message: 'Hi' } },
    { method: 'GET', body: { requestId: randomUUID(), message: 'Hi' } }, { method: 'POST', body: { requestId: 'bad', message: 'Hi' } }]) {
    const f = fixture(); await assert.rejects(f.service.request('/api/coach-chat', options), { status: 400 });
    assert.equal(f.calls.length, 0); assert.equal(f.uploads.length, 0);
  }
});
