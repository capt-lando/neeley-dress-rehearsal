import test from 'node:test';
import assert from 'node:assert/strict';
import { browserRecoveryStorage, createPendingRequests, recoverPendingRequest, recoveryDelay } from '../lib/hosted-recovery.mjs';
import { createHostedService } from '../lib/hosted-service.mjs';

const userId = '11111111-1111-4111-8111-111111111111';
const otherUser = '22222222-2222-4222-8222-222222222222';
const requestId = '33333333-3333-4333-8333-333333333333';
const recordingId = '44444444-4444-4444-8444-444444444444';
const otherRequest = '55555555-5555-4555-8555-555555555555';
const marker = (kind = 'transcribe', phase = 'active') => ({ userId, requestId, recordingId, kind, phase, createdAt: 1 });
const job = (kind, state, result = null) => ({ requestId, recordingId, kind, state, result });
function memoryStorage() {
  const data = new Map();
  return { data, getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
}
const missing = () => Object.assign(new Error('Not found'), { status: 404 });

test('pending markers survive recreation, contain identifiers only, and isolate account/project', () => {
  const storage = memoryStorage(), first = createPendingRequests(storage, 'https://one.supabase.co');
  first.save({ ...marker(), text: 'PRIVATE TRANSCRIPT', token: 'PRIVATE TOKEN', preparation: 'PRIVATE SCRIPT', audio: 'PRIVATE AUDIO' });
  const bytes = [...storage.data.values()].join('');
  assert.doesNotMatch(bytes, /PRIVATE|text|token|preparation|audio/);
  assert.deepEqual(createPendingRequests(storage, 'https://one.supabase.co').read(userId), marker());
  assert.equal(first.read(otherUser), null);
  assert.equal(createPendingRequests(storage, 'https://two.supabase.co').read(userId), null);
  first.save({ ...marker('coach'), userId: otherUser });
  assert.equal(first.read(otherUser).kind, 'coach');
  assert.equal(first.read(userId).kind, 'transcribe');
});

test('pending marker prevents new requests from replacing unresolved work and stale clear cannot erase newer work', () => {
  const pending = createPendingRequests(memoryStorage(), 'project');
  pending.save(marker());
  assert.throws(() => pending.save({ ...marker('coach'), requestId: otherRequest }), /Recover the previous request/);
  pending.clear({ ...marker(), requestId: otherRequest });
  assert.deepEqual(pending.read(userId), marker());
  pending.clear(marker());
  const newer = { ...marker('coach'), requestId: otherRequest };
  pending.save(newer); pending.clear(marker());
  assert.deepEqual(pending.read(userId), newer);
});

test('corrupt and mismatched stored markers are ignored instead of directing account actions', () => {
  const storage = memoryStorage(), pending = createPendingRequests(storage, 'project');
  pending.save(marker()); const key = [...storage.data.keys()][0];
  for (const value of ['broken json', '[]', 'null', JSON.stringify({ ...marker(), userId: otherUser }),
    JSON.stringify({ ...marker(), requestId: '../../other' }), JSON.stringify({ ...marker(), recordingId: 'bad' }),
    JSON.stringify({ ...marker(), kind: 'delete-everything' }), JSON.stringify({ ...marker(), phase: 'unknown' })]) {
    storage.setItem(key, value); assert.equal(pending.read(userId), null);
  }
});

test('storage denial fails before unrecoverable work can be marked as saved', () => {
  const denied = { getItem() { throw new Error('Denied'); }, setItem() { throw new Error('Quota'); }, removeItem() { throw new Error('Denied'); } };
  const pending = createPendingRequests(denied, 'project');
  assert.equal(pending.read(userId), null);
  assert.throws(() => pending.save(marker()), /Allow session storage/);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
  try { assert.throws(() => createPendingRequests(browserRecoveryStorage(), 'project').save(marker()), /Allow session storage/); }
  finally { if (descriptor) Object.defineProperty(globalThis, 'sessionStorage', descriptor); else delete globalThis.sessionStorage; }
});

test('refresh polls the same admitted transcription and restores its exact result without a paid POST', async () => {
  const calls = [], messages = [], waits = [];
  const states = [job('transcribe', 'reserved'), job('transcribe', 'completed', { recordingId, text: 'Recovered words.' })];
  const result = await recoverPendingRequest(marker(), {
    request: async (path, options) => { calls.push({ path, options }); return states.shift(); },
    openRecording: async id => { assert.equal(id, recordingId); return { id, transcript: 'Older words.', report: { older: true }, blob: new Blob(['audio']) }; },
    onProgress: value => messages.push(value), wait: async ms => waits.push(ms),
  });
  assert.equal(result.state, 'completed'); assert.equal(result.record.transcript, 'Recovered words.'); assert.equal(result.record.report, null);
  assert.equal(calls.length, 2); assert.ok(calls.every(call => call.path === `/requests/${requestId}` && !call.options.method));
  assert.deepEqual(waits, [2000]); assert.match(messages.join(' '), /still processing/);
  assert.match(result.message, /Choose Analyze/);
});

test('completed coaching restores the exact report including preparation metadata', async () => {
  const report = { transcript: 'Corrected words.', meta: { plannedIntroduction: 'My introduction', targetTalkingPoints: 'First point' }, analysis: { overallRating: 80 } };
  const result = await recoverPendingRequest(marker('coach'), {
    request: async () => job('coach', 'completed', report), openRecording: async () => ({ id: recordingId, transcript: 'Old words.', report: null }),
  });
  assert.equal(result.record.report, report); assert.equal(result.record.transcript, 'Corrected words.');
  assert.equal(result.record.report.meta.plannedIntroduction, 'My introduction');
});

test('failed and expired requests restore saved audio and permit explicit retry without automatic processing', async () => {
  for (const state of ['failed', 'expired']) {
    let reads = 0;
    const saved = { id: recordingId, transcript: 'Previously saved', report: null };
    const result = await recoverPendingRequest(marker('coach'), {
      request: async (path, options) => { reads++; assert.equal(options.method, undefined); return job('coach', state); },
      openRecording: async () => saved,
    });
    assert.equal(result.state, state); assert.equal(result.record, saved); assert.equal(reads, 1); assert.match(result.message, /retry transcription or coaching/);
  }
});

test('late admission after refresh is retried read-only, and persistently unknown requests remain recoverable', async () => {
  let reads = 0;
  const recovered = await recoverPendingRequest(marker(), {
    request: async () => { if (++reads === 1) throw missing(); return job('transcribe', 'completed', { text: 'Late result.' }); },
    openRecording: async () => ({ id: recordingId }), wait: async () => {}, attempts: 3, now: () => 1,
  });
  assert.equal(reads, 2); assert.equal(recovered.record.transcript, 'Late result.');
  reads = 0; let waits = 0;
  await assert.rejects(recoverPendingRequest(marker(), {
    request: async () => { reads++; throw missing(); }, openRecording: async () => assert.fail('No admitted recording to open'),
    wait: async () => { waits++; }, attempts: 3, now: () => 1,
  }), /Retry recovery/);
  assert.equal(reads, 3); assert.equal(waits, 2);
});

test('a missing request past the admission window restores its saved recording and unlocks explicit retry', async () => {
  const saved = { id: recordingId, transcript: '', report: null };
  const result = await recoverPendingRequest(marker(), {
    request: async () => { throw missing(); }, openRecording: async () => saved, now: () => 600002,
    wait: async () => assert.fail('Expired missing work needs no further polling'),
  });
  assert.equal(result.state, 'expired'); assert.equal(result.record, saved); assert.match(result.message, /did not start/);
});

test('mismatched request/recording/kind or unknown state never restores private content', async () => {
  for (const bad of [{ requestId: otherRequest }, { recordingId: otherRequest }, { kind: 'coach' }, { state: 'unknown' }]) {
    await assert.rejects(recoverPendingRequest(marker(), {
      request: async () => ({ ...job('transcribe', 'completed', { text: 'Words' }), ...bad }),
      openRecording: async () => assert.fail('Must verify response before opening'),
    }), /could not be verified/);
  }
});

test('recovery network failure preserves the marker for Retry recovery', async () => {
  const pending = createPendingRequests(memoryStorage(), 'project'); pending.save(marker());
  await assert.rejects(recoverPendingRequest(pending.read(userId), {
    request: async () => { throw new TypeError('Offline'); }, openRecording: async () => assert.fail('Offline'), wait: async () => {},
  }), /Offline/);
  assert.deepEqual(pending.read(userId), marker());
});

test('bounded polling releases control without clearing unresolved work and honors cancellation', async () => {
  let reads = 0;
  await assert.rejects(recoverPendingRequest(marker(), {
    request: async () => { reads++; return job('transcribe', 'reserved'); }, openRecording: async () => assert.fail('Still pending'), wait: async () => {}, attempts: 2,
  }), /Retry recovery/);
  assert.equal(reads, 2);
  const controller = new AbortController();
  await assert.rejects(recoverPendingRequest(marker(), {
    signal: controller.signal,
    request: async () => { controller.abort(); return job('transcribe', 'reserved'); },
    openRecording: async () => assert.fail('Aborted'), wait: async (_ms, signal) => signal.throwIfAborted(),
  }), { name: 'AbortError' });
  const already = new AbortController(); already.abort();
  await assert.rejects(recoveryDelay(10000, already.signal), { name: 'AbortError' });
  const later = new AbortController(), waiting = recoveryDelay(10000, later.signal); later.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
});

test('live refresh uses exact cancellation tombstone before any recording is restored', async () => {
  const calls = [];
  const result = await recoverPendingRequest(marker('live'), {
    request: async (path, options) => { calls.push({ path, options }); return { recordingId, cancelled: true, status: 'cancelled', audioSaved: false }; },
    openRecording: async () => assert.fail('Unsaved microphone audio cannot be restored'),
  });
  assert.equal(result.state, 'cancelled'); assert.equal(result.record, null);
  assert.equal(calls.length, 1); assert.equal(calls[0].path, `/live-sessions/${recordingId}/cancel`);
  assert.equal(calls[0].options.method, 'POST'); assert.deepEqual(calls[0].options.body, { requestId });
  assert.match(result.message, /not saved before refresh/);
});

test('live refresh after save preserves and reopens saved audio without deleting it', async () => {
  const calls = [], saved = { id: recordingId, blob: new Blob(['audio']) };
  const result = await recoverPendingRequest(marker('live', 'saved'), {
    request: async (path, options) => { calls.push([path, options.method]); return { recordingId, cancelled: true, status: 'cancelled', audioSaved: true }; },
    openRecording: async id => { assert.equal(id, recordingId); return saved; },
  });
  assert.equal(result.record, saved); assert.equal(result.state, 'cancelled');
  assert.deepEqual(calls, [[`/live-sessions/${recordingId}/cancel`, 'POST']]);
});

test('unconfirmed live cancellation does not pretend the lock was released', async () => {
  for (const response of [{ recordingId, cancelled: false }, { recordingId: otherRequest, cancelled: true }, { recordingId, cancelled: true },
    { recordingId, cancelled: true, status: 'active', audioSaved: false }]) {
    await assert.rejects(recoverPendingRequest(marker('live'), {
      request: async () => response, openRecording: async () => assert.fail('Not confirmed'),
    }), /Cancellation could not be confirmed/);
  }
});

function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function serviceHarness(fetchImpl) {
  const storage = memoryStorage(), url = 'https://recovery.supabase.co';
  let session = { access_token: 'test-only-first-account', user: { id: userId } }, authChanged;
  const client = { auth: {
    getSession: async () => ({ data: { session } }),
    onAuthStateChange: callback => { authChanged = callback; return { data: { subscription: { unsubscribe() {} } } }; },
  } };
  const calls = [];
  const service = createHostedService({ client, url, publishableKey: 'sb_publishable_test', policyText: 'Test policy.', recoveryStorage: storage,
    fetchImpl: async (...args) => { calls.push(args); return fetchImpl(...args); } });
  service.onAuthChange(() => {});
  const pending = createPendingRequests(storage, url); pending.save(marker('coach'));
  return { service, calls, pending, switchAccount() { session = { access_token: 'test-only-second-account', user: { id: otherUser } }; authChanged('SIGNED_IN', session); } };
}

test('a different signed-in user cannot even initiate recovery with the previous account marker', async () => {
  const h = serviceHarness(() => assert.fail('Foreign marker must not make network requests'));
  const previous = await h.service.getPendingRequest(); assert.equal(previous.userId, userId);
  h.switchAccount();
  assert.equal(await h.service.getPendingRequest(), null);
  await assert.rejects(h.service.recoverPending(previous), { status: 401 });
  assert.equal(h.calls.length, 0); assert.ok(h.pending.read(userId));
  h.service.dispose();
});

test('switching accounts while recovery status is decoding cannot return prior private results', async () => {
  const entered = deferred(), decoded = deferred();
  const h = serviceHarness(async (_url, options) => {
    assert.match(options.headers.Authorization, /first-account/);
    entered.resolve(); return { ok: true, json: () => decoded.promise };
  });
  const previous = await h.service.getPendingRequest();
  const recovering = h.service.recoverPending(previous, { wait: async () => {} });
  await entered.promise; h.switchAccount();
  decoded.resolve(job('coach', 'completed', { transcript: 'PRIVATE OLD ACCOUNT', meta: { targetScript: 'PRIVATE PREPARATION' } }));
  await assert.rejects(recovering, error => error.name === 'AbortError' || error.status === 401);
  assert.equal(h.calls.length, 1); assert.ok(h.pending.read(userId));
  assert.equal(await h.service.getPendingRequest(), null);
  h.service.dispose();
});

test('switching accounts while recovery audio is decoding cannot restore old transcript, report or audio', async () => {
  const entered = deferred(), audio = deferred();
  const h = serviceHarness(async url => {
    if (url.includes('/requests/')) return Response.json(job('coach', 'completed', { transcript: 'PRIVATE OLD ACCOUNT', analysis: {}, meta: { targetScript: 'PRIVATE SCRIPT' } }));
    if (url.includes('/functions/v1/rehearsal-api/recordings/')) return Response.json({ recording: { id: recordingId, transcript: 'PRIVATE OLD ACCOUNT', report: null }, audioUrl: `https://recovery.supabase.co/storage/v1/object/sign/recordings/${userId}/${recordingId}/audio.wav` });
    entered.resolve(); return { ok: true, blob: () => audio.promise };
  });
  const previous = await h.service.getPendingRequest();
  const recovering = h.service.recoverPending(previous);
  await entered.promise; h.switchAccount(); audio.resolve(new Blob(['private audio']));
  await assert.rejects(recovering, error => error.name === 'AbortError' || error.status === 401);
  assert.equal(h.calls.length, 3); assert.ok(h.pending.read(userId));
  assert.equal(await h.service.getPendingRequest(), null);
  h.service.dispose();
});
