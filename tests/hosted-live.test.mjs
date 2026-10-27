import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostedLiveSession } from '../lib/hosted-live.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture({ request: override, saveAudio: save, sampleRate = 16000 } = {}) {
  const calls = [], chunks = [], recordingId = 'recording', start = { recordingId };
  let active = false, saves = 0;
  const session = createHostedLiveSession({ sampleRate, recordingId, requestId: 'request',
    encodeAudio: samples => new Blob([new Uint8Array(44 + 2 * Math.round(samples.length * 16000 / sampleRate))]),
    validateStart: value => assert.equal(value, start),
    saveAudio: async () => { saves++; await save?.(); return { sizeBytes: 320044, durationSeconds: 10 }; },
    request: async (path, options) => {
      calls.push({ path, ...options });
      if (override) await override(path, options);
      if (path === '/live-sessions') { active = true; return start; }
      if (path.endsWith('/cancel')) { active = false; return { cancelled: true }; }
      if (path.endsWith('/prepare')) return { ready: true };
      if (path.endsWith('/finish')) return { recordingId, complete: active, text: active ? 'Um, I, I finish.' : '' };
      const index = Number(path.split('/').pop()); chunks.push(options.body.size);
      return { recordingId, sequence: index, nextSequence: index + 1, text: 'Um, I, I finish.' };
    },
  });
  return { session, calls, chunks, get active() { return active; }, get saves() { return saves; } };
}

test('cancel during session creation waits for its commit and never warms or sends chunks', async () => {
  const started = deferred(), response = deferred();
  const f = fixture({ request: async (path, options) => {
    if (path === '/live-sessions') { assert.equal(options.signal, undefined); started.resolve(); await response.promise; }
  } });
  f.session.push(new Float32Array(160000)); await started.promise;
  assert.equal(f.session.cancel(), true); await tick();
  assert.equal(f.calls.length, 1, 'Cancellation waits until creation settles in this tab');
  response.resolve(); await tick(); await tick();
  assert.deepEqual(f.calls.map(call => [call.path, call.method]), [['/live-sessions', 'POST'], ['/live-sessions/recording/cancel', 'POST']]);
  assert.equal(f.active, false); assert.equal(f.chunks.length, 0);
  assert.equal(f.session.cancel(), false);
});

test('cancel before preparation starts makes no cloud request', async () => {
  const f = fixture(); f.session.cancel(); await tick();
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.session.finish(new Blob()), { name: 'AbortError' });
});

test('a canceled take can finish saving after an outstanding start response settles', async () => {
  const started = deferred(), response = deferred();
  const f = fixture({ request: async path => { if (path === '/live-sessions') { started.resolve(); await response.promise; } } });
  f.session.push(new Float32Array(160000)); await started.promise; f.session.cancel();
  const finishing = f.session.finish(new Blob()); response.resolve();
  assert.equal((await finishing).complete, false);
  assert.deepEqual(f.calls.map(call => call.path), ['/live-sessions', '/live-sessions/recording/cancel', '/live-sessions/recording/finish']);
});

test('a final source sample that rounds away does not invent audio or send an empty WAV', async () => {
  for (const sampleRate of [44100, 48000]) {
    const f = fixture({ sampleRate });
    f.session.push(new Float32Array(sampleRate * 10 + 1));
    const result = await f.session.finish(new Blob());
    assert.equal(result.complete, true); assert.deepEqual(f.chunks, [320044]);
  }
  const f = fixture(); f.session.push(new Float32Array(160001)); await f.session.finish(new Blob());
  assert.deepEqual(f.chunks, [320044, 46], 'a real 16 kHz final sample must still be sent');
});

test('discarding a take while finish waits for transcription prevents its upload', async () => {
  const entered = deferred(), response = deferred();
  const f = fixture({ request: async path => { if (path.includes('/chunks/')) { entered.resolve(); await response.promise; } } });
  f.session.push(new Float32Array(160000));
  const finishing = f.session.finish(new Blob()); await entered.promise;
  assert.equal(f.session.abandon(), true);
  await assert.rejects(finishing, { name: 'AbortError' }); response.resolve(); await tick();
  assert.equal(f.session.abandon(), false); assert.equal(f.saves, 0);
  assert.equal(f.active, false); assert.ok(!f.calls.some(call => call.path.endsWith('/finish')));
});

test('discarding during an upload prevents finalization and returning a stale take', async () => {
  const entered = deferred(), response = deferred();
  const f = fixture({ saveAudio: async () => { entered.resolve(); await response.promise; } });
  f.session.push(new Float32Array(160000));
  const finishing = f.session.finish(new Blob()); await entered.promise;
  f.session.abandon(); response.resolve();
  await assert.rejects(finishing, { name: 'AbortError' });
  assert.equal(f.saves, 1); assert.ok(!f.calls.some(call => call.path.endsWith('/finish')));
});

test('a discarded take cannot later be finished', async () => {
  const f = fixture(); f.session.abandon();
  await assert.rejects(f.session.finish(new Blob()), { name: 'AbortError' });
  assert.equal(f.saves, 0); assert.equal(f.calls.length, 0);
});
