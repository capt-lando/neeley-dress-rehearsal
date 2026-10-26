import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createHostedService, readHostedConfig } from '../lib/hosted-service.mjs';

const policyText = await readFile(new URL('../lib/coaching-prompt.md', import.meta.url), 'utf8');
const url = 'https://pilot.supabase.co', publishableKey = 'sb_publishable_test';
const userId = '12345678-1234-4123-8123-123456789012';
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
const firstSession = { access_token: 'private-session-token', user: { id: userId } };
const secondSession = { access_token: 'second-token', user: { id: 'abcdefab-1234-4123-8123-123456789012' } };
function wav(seconds = 1) {
  const bytes = Buffer.alloc(44 + seconds * 32000);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  return new Blob([bytes], { type: 'audio/wav' });
}
function fixture({ signedIn = true, handle } = {}) {
  const calls = [], uploads = [], oauth = [];
  let session = signedIn ? { access_token: 'private-session-token', user: { id: userId } } : null;
  let authHandler;
  const client = {
    auth: {
      getSession: async () => ({ data: { session } }),
      signInWithOAuth: async options => { oauth.push(options); return {}; },
      signOut: async () => { session = null; authHandler?.('SIGNED_OUT', null); return {}; },
      onAuthStateChange: callback => { authHandler = callback; return { data: { subscription: { unsubscribe() {} } } }; },
    },
    storage: { from: bucket => ({ upload: async (path, blob, options) => { uploads.push({ bucket, path, blob, options }); return {}; } }) },
  };
  const fetchImpl = async (destination, options) => {
    const call = { path: destination.replace(`${url}/functions/v1/rehearsal-api`, ''), ...options, body: options?.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    if (handle) { const handled = await handle(call); if (handled) return handled; }
    if (call.path === '/recordings' && options.method === 'POST') return response({ id: call.body.id, storagePath: `${userId}/${call.body.id}/audio.wav`, bucket: 'recordings' });
    if (call.path === '/transcribe') return response({ text: 'Um, practice helps.', durationSeconds: 1, chunks: [], model: 'bark-3.0-plus', localSpeech: false, recordingId: call.body.recordingId });
    if (call.path === '/analyze-text') return response({ analysis: { method: 'ai' } });
    if (call.path === '/config') return response({ auth: { signedIn: true }, analysisConfigured: true });
    if (call.method === 'DELETE') return response({ deleted: true });
    throw new Error('Unexpected request');
  };
  const service = createHostedService({ client, url, publishableKey, policyText, fetchImpl, uuid: randomUUID });
  return { service, client, calls, uploads, oauth, authChange(value) { session = value; authHandler?.('SIGNED_IN', session); } };
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

test('signed-out startup sends nothing; transcription requires OAuth and unsupported routes cannot send data', async () => {
  const { service, calls, uploads } = fixture({ signedIn: false });
  const config = await service.request('/api/config');
  assert.equal(config.hosted, true); assert.equal(config.localSpeech, false); assert.equal(config.liveTranscription, false);
  assert.equal(config.auth.signedIn, false);
  assert.ok(!JSON.stringify(config).includes('token'));
  await assert.rejects(service.request('/api/transcribe', { body: wav() }), { status: 401 });
  await assert.rejects(service.request('https://evil.example/steal'), { status: 404 });
  await assert.rejects(service.request('/api/settings', { body: { analysisApiKey: 'never-send' } }), { status: 404 });
  assert.equal(calls.length, 0); assert.equal(uploads.length, 0);
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
  assert.equal(uploads[0].bucket, 'recordings');
  assert.equal(uploads[0].options.upsert, false);
  assert.ok(uploads[0].path.startsWith(`${userId}/`));
  assert.equal(calls.find(call => call.path === '/recordings').body.durationSeconds, 1);
  const jobs = calls.filter(call => call.path === '/transcribe');
  assert.equal(jobs[0].body.requestId, jobs[1].body.requestId);
  assert.equal(jobs[0].headers.Authorization, 'Bearer private-session-token');
  assert.ok(!JSON.stringify(jobs[0].body).includes('private-session-token'));
});

test('definite failed jobs require a new request ID on the next explicit retry; changed coaching gets a new ID', async () => {
  let fail = true;
  const { service, calls } = fixture({ handle: call => { if (call.path === '/transcribe' && fail) { fail = false; return response({ error: 'Speech worker failed.' }, 502); } } });
  const audio = wav();
  await assert.rejects(service.request('/api/transcribe', { body: audio }), { status: 502 });
  const result = await service.request('/api/transcribe', { body: audio });
  const jobs = calls.filter(call => call.path === '/transcribe');
  assert.notEqual(jobs[0].body.requestId, jobs[1].body.requestId);
  const body = { recordingId: result.recordingId, text: 'Um, practice helps.' };
  await service.request('/api/analyze-text', { body }); await service.request('/api/analyze-text', { body });
  await service.request('/api/analyze-text', { body: { ...body, text: 'Practice helps everyone.' } });
  const coaching = calls.filter(call => call.path === '/analyze-text');
  assert.equal(coaching[0].body.requestId, coaching[1].body.requestId);
  assert.notEqual(coaching[1].body.requestId, coaching[2].body.requestId);
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

test('an account switch during storage upload cannot mark the prior recording saved or start inference', async () => {
  const uploaded = deferred(), entered = deferred();
  const f = fixture(); f.service.onAuthChange(() => {}); f.authChange(firstSession);
  f.client.storage.from = () => ({ upload: () => { entered.resolve(); return uploaded.promise; } });
  let saved = 0; f.service.setRecordingSavedHandler(() => saved++);
  const sending = f.service.request('/api/transcribe', { body: wav() }); await entered.promise;
  f.authChange(secondSession); uploaded.resolve({});
  await assert.rejects(sending, { status: 401 });
  assert.equal(saved, 0); assert.equal(f.calls.filter(call => call.path === '/transcribe').length, 0);
});
