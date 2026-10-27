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
function ndjson(events) {
  return new Response(events.map(event => JSON.stringify(event)).join('\n') + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
}
const coachStages = ['accepted', 'coach_requested', 'feedback_received', 'feedback_validated', 'saved'];
const progressFrames = stages => stages.map(stage => ({ type: 'progress', stage }));
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
function fixture({ signedIn = true, handle, recoveryStorage } = {}) {
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
    if (call.path === '/transcribe') return response({ text: 'Um, practice helps.', durationSeconds: 1, chunks: [], model: 'bark-3.0-plus', localSpeech: false, recordingId: call.body.recordingId });
    if (call.path === '/analyze-text') return response({ analysis: { method: 'ai' } });
    if (call.path === '/config') return response({ auth: { signedIn: true }, analysisConfigured: true });
    if (call.path.startsWith('/requests/') && call.path.endsWith('/cancel')) return response({ recordingId: call.body.recordingId, requestId: call.path.split('/')[2], cancelled: true, state: 'cancelled' });
    if (call.path.endsWith('/cancel')) return response({ recordingId: call.path.split('/')[2], cancelled: true, status: 'cancelled', audioSaved: false });
    if (call.method === 'DELETE') return response({ deleted: true });
    throw new Error('Unexpected request');
  };
  const service = createHostedService({ client, url, publishableKey, policyText, fetchImpl, uuid: randomUUID, recoveryStorage });
  return { service, client, calls, uploads, oauth, recoveryStorage, authChange(value) { session = value; authHandler?.('SIGNED_IN', session); } };
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
  let saved;
  service.setRecordingSavedHandler((blob, recordingId) => { saved = { blob, recordingId }; });
  const audio = wav();
  const live = service.startLiveSession({ sampleRate: 16000, encodeAudio: () => audio });
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
  const chunk = calls.find(call => call.path.includes('/chunks/'));
  assert.equal(chunk.headers['Content-Type'], 'audio/wav');
  assert.equal(chunk.headers.Authorization, 'Bearer private-session-token');
  assert.equal(chunk.headers['X-Rehearsal-Final'], 'true');
  assert.equal(chunk.body, audio);
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

test('definite failed jobs require a new request ID on the next explicit retry; changed coaching gets a new ID', async () => {
  let fail = true;
  const { service, calls } = fixture({ handle: call => { if (call.path === '/transcribe' && fail) { fail = false; return response({ error: 'Speech worker failed.', jobState: 'failed' }, 502); } } });
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

test('explicit retries rotate IDs only for confirmed terminal failures, including a busy speech worker', async () => {
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
  const live=f.service.startLiveSession({sampleRate:16000,encodeAudio:()=>audio});live.push(new Float32Array(16000));
  await assert.rejects(live.finish(audio),{status:503});await assert.rejects(live.finish(audio),{status:503});
  assert.equal(f.uploads.length,1);assert.equal(saved,0);assert.equal(f.calls.some(call=>call.path.endsWith('/finish')),false);
  live.cancel();await new Promise(setImmediate);
  const result=await f.service.request('/api/transcribe',{body:audio});
  assert.equal(result.recordingId,id);assert.equal(saved,1);
  assert.equal(f.calls.filter(call=>call.path==='/recordings').length,0);
  assert.equal(f.uploads.length,2);assert.equal(f.uploads[0].path,f.uploads[1].path);
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

test('refresh retries unconfirmed cancellation instead of trusting a cancelled job before the worker stops', async () => {
  const original = fixture({ handle: call => {
    if (call.path === '/analyze-text') throw new TypeError('Response lost');
    if (call.path.endsWith('/cancel')) return response({ error: 'Worker has not confirmed stopping' }, 503);
  } });
  await assert.rejects(original.service.request('/api/analyze-text', { body: { recordingId: randomUUID(), text: 'Words' } }));
  await assert.rejects(original.service.cancelCurrentRequest(), { status: 503 });
  let stopped = false;
  const refreshed = fixture({ recoveryStorage: original.recoveryStorage, handle: call => {
    assert.ok(call.path.endsWith('/cancel'), 'cancellation recovery must not poll the already cancelled job or reopen audio');
    if (!stopped) return response({ error: 'Worker has not confirmed stopping' }, 503);
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
  const body = { requestId: randomUUID(), message: 'Help with my opening.', history: [], context: { phase: 'prepare' } };
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
