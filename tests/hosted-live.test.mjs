import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostedLiveSession } from '../lib/hosted-live.mjs';
import { createRealtimeSocketFixture } from './fixtures/realtime-socket.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fakeTimers() {
  const tasks = new Map(); let next = 0;
  return {
    setTimeout(callback, milliseconds) { const id = ++next; tasks.set(id, { callback, milliseconds }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    run(milliseconds) {
      const task = [...tasks].find(([, value]) => value.milliseconds === milliseconds);
      assert.ok(task, 'Expected a scheduled ' + milliseconds + ' ms timer');
      tasks.delete(task[0]); task[1].callback();
    },
    get size() { return tasks.size; },
  };
}
function fixture({ request: override, saveAudio: save, sampleRate = 24_000, getConnection, socket = {}, ...options } = {}) {
  const calls = [], updates = [], recordingId = 'recording', start = { recordingId };
  const transport = createRealtimeSocketFixture(socket);
  let active = false, saves = 0, connections = 0;
  const session = createHostedLiveSession({ sampleRate, recordingId, requestId: 'request',
    WebSocketImpl: transport.WebSocketImpl,
    getConnection: async settings => { connections++; return getConnection ? getConnection(settings) : { url: 'wss://example.test/live-stream', token: 'private-token' }; },
    onUpdate: value => updates.push(value),
    validateStart: value => assert.equal(value, start),
    saveAudio: async () => { saves++; await save?.(); return { sizeBytes: 320044, durationSeconds: 10 }; },
    request: async (path, settings) => {
      calls.push({ path, ...settings });
      if (override) await override(path, settings);
      if (path === '/live-sessions') { active = true; return start; }
      if (path.endsWith('/cancel')) { active = false; return { cancelled: true }; }
      assert.ok(path.endsWith('/finish'), 'Only creation, cancellation and final save use HTTP');
      return { recordingId, complete: active, text: transport.transcript };
    },
    ...options,
  });
  return { session, calls, updates, ...transport, sockets: transport.sockets,
    get active() { return active; }, get saves() { return saves; }, get connections() { return connections; } };
}
const pcm = f => Buffer.concat(f.sockets.flatMap(socket => socket.frames.map(frame => Buffer.from(frame))));

test('authenticates in the first message and sends sub-200 ms PCM before Stop, with immediate partial words', async () => {
  const f = fixture({ sampleRate: 48_000, socket: { onAudio: () => 'Um, I, I think' } });
  f.session.push(new Float32Array(4096).fill(0.25));
  await tick();
  const socket = f.sockets[0];
  assert.deepEqual(socket.messages[0], { type: 'start', token: 'private-token', recordingId: 'recording', requestId: 'request', segmentIndex: 0 });
  assert.ok(!socket.url.includes('private-token'));
  assert.equal(socket.frames.length, 1); assert.equal(socket.frames[0].byteLength, 4096);
  assert.equal(f.session.getState().text, 'Um, I, I think');
  assert.equal(f.session.getState().finishing, false);
  assert.ok(f.updates.some(update => update.text === 'Um, I, I think'));
  assert.deepEqual(f.calls.map(call => call.path), ['/live-sessions']);
  await f.session.finish(new Blob());
});

test('PCM frames are bounded, little-endian, clipped and independent of caller buffers', async () => {
  const f = fixture({ socket: { autoReady: false } });
  const samples = new Float32Array([-1, -0.5, 0, 0.5, 1, NaN, 2, -2]);
  f.session.push(samples); samples.fill(0); await tick();
  assert.equal(f.sockets[0].frames.length, 0, 'No PCM precedes authenticated readiness');
  f.sockets[0].serverMessage({ type: 'ready', segmentIndex: 0, sampleRate: 24_000, maxSamples: 2_640_000, transcript: '' });
  assert.deepEqual([...new Int16Array(pcm(f).buffer, pcm(f).byteOffset, 8)], [-32768, -16384, 0, 16384, 32767, 0, 32767, -32768]);
  f.session.push(new Float32Array(24_000)); await tick();
  assert.ok(f.sockets[0].frames.every(frame => frame.byteLength <= 9600));
  await f.session.finish(new Blob());
});

test('resampling across arbitrary microphone boundaries matches whole-buffer PCM, including the final tail', async () => {
  for (const sampleRate of [16_000, 44_100, 48_000, 96_000]) {
    const input = Float32Array.from({ length: 1703 }, (_, index) => Math.sin(index / 43) * 0.7);
    const whole = fixture({ sampleRate }), split = fixture({ sampleRate });
    whole.session.push(input);
    let offset = 0;
    for (const length of [1, 3, 11, 409, 1, 270, 1008]) {
      split.session.push(input.subarray(offset, offset + length)); offset += length;
    }
    assert.equal(offset, input.length);
    await Promise.all([whole.session.finish(new Blob()), split.session.finish(new Blob())]);
    assert.equal(pcm(split).length / 2, Math.round(input.length * 24_000 / sampleRate));
    assert.deepEqual(pcm(split), pcm(whole), 'No dropped or duplicated samples at ' + sampleRate + ' Hz');
  }
});

test('rotation keeps every queued sample and commits each segment before authenticating the next one', async () => {
  const f = fixture({ socket: { maxSamples: 6001, text: index => 'Part ' + index + '.' } });
  const samples = Float32Array.from({ length: 17_003 }, (_, index) => Math.sin(index / 200));
  f.session.push(samples);
  const result = await f.session.finish(new Blob());
  assert.equal(result.complete, true);
  assert.equal(result.text, 'Part 0. Part 1. Part 2.');
  assert.deepEqual(f.sockets.map(socket => socket.samples), [6001, 6001, 5001]);
  assert.deepEqual(f.sockets.map(socket => socket.start.segmentIndex), [0, 1, 2]);
  assert.ok(f.sockets.every(socket => socket.readyState === 3));
  const reference = fixture(); reference.session.push(samples); await reference.session.finish(new Blob());
  assert.deepEqual(pcm(f), pcm(reference), 'A frame split at a rotation is neither lost nor replayed');
  assert.equal(f.saves, 1);
});

test('wall-clock rotation preserves backpressured audio and waits for new audio while paused', async () => {
  const timers = fakeTimers(), f = fixture({ timers });
  f.session.push(new Float32Array(100).fill(0.5)); await tick();
  timers.run(95_000); await tick();
  assert.equal(f.sockets.length, 1, 'A paused take does not start empty paid segments repeatedly');
  f.session.push(new Float32Array(111).fill(-0.5)); await tick();
  assert.equal(f.sockets.length, 2);
  f.sockets[1].bufferedAmount = 24_000;
  f.session.push(new Float32Array(222).fill(0.25));
  timers.run(95_000); await tick();
  assert.equal(f.sockets.length, 3);
  assert.deepEqual(f.sockets.map(socket => socket.samples), [100, 111, 222]);
  await f.session.finish(new Blob());
  assert.equal(pcm(f).byteLength, (100 + 111 + 222) * 2);
  assert.equal(timers.size, 0);
});

test('browser send-buffer backpressure delays PCM without discarding it', async () => {
  const timers = fakeTimers(), f = fixture({ timers });
  await tick(); f.sockets[0].bufferedAmount = 24_000;
  f.session.push(new Float32Array(4800));
  assert.equal(f.sockets[0].frames.length, 0);
  f.sockets[0].bufferedAmount = 0; timers.run(25); await tick();
  assert.equal(f.sockets[0].samples, 4800);
  await f.session.finish(new Blob()); assert.equal(timers.size, 0);
});

test('Stop waits for the provider final and commits the exact complete audio only once', async () => {
  const pending = deferred();
  const f = fixture({ socket: { onAudio: () => 'Draft', onFinish: () => pending.promise } });
  f.session.push(new Float32Array(100)); await tick();
  const finishing = f.session.finish(new Blob());
  assert.equal(finishing, f.session.finish(new Blob()));
  await tick(); assert.equal(f.saves, 0); assert.equal(f.session.getState().text, 'Draft');
  pending.resolve('Final words.');
  assert.equal((await finishing).text, 'Final words.');
  assert.equal(f.saves, 1); assert.equal(f.session.cancel(), false);
});

test('cancel during creation waits for its commit and never opens a stream', async () => {
  const entered = deferred(), response = deferred();
  const f = fixture({ request: async (path, settings) => {
    if (path === '/live-sessions') { assert.equal(settings.signal, undefined); entered.resolve(); await response.promise; }
  } });
  f.session.push(new Float32Array(100)); await entered.promise;
  assert.equal(f.session.cancel(), true); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.sockets.length, 0);
  response.resolve(); await tick();
  assert.deepEqual(f.calls.map(call => call.path), ['/live-sessions', '/live-sessions/recording/cancel']);
  assert.equal(f.active, false); assert.equal(f.session.cancel(), false);
});

test('cancel before preparation starts makes no cloud request', async () => {
  const f = fixture(); f.session.cancel(); await tick();
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.session.finish(new Blob()), { name: 'AbortError' });
});

test('a cancelled take can still save complete audio after the outstanding creation settles', async () => {
  const entered = deferred(), response = deferred();
  const f = fixture({ request: async path => { if (path === '/live-sessions') { entered.resolve(); await response.promise; } } });
  f.session.push(new Float32Array(100)); await entered.promise; f.session.cancel();
  const finishing = f.session.finish(new Blob()); response.resolve();
  assert.equal((await finishing).complete, false);
  assert.equal(f.saves, 1); assert.equal(f.sockets.length, 0);
});

test('cancellation closes the provider stream immediately and ignores late private words', async () => {
  const f = fixture(); f.session.push(new Float32Array(100)); await tick();
  const socket = f.sockets[0];
  assert.equal(f.session.cancel(), true);
  assert.equal(socket.readyState, 3); assert.equal(socket.messages.at(-1).type, 'cancel');
  socket.emit('message', { data: JSON.stringify({ type: 'transcript', text: 'Stale private text' }) });
  assert.equal(f.session.getState().text, ''); await tick();
  assert.equal(f.active, false); assert.equal(f.sockets.length, 1);
});

test('an account abort discards the take and cannot save or connect with a late token', async () => {
  const controller = new AbortController(), pending = deferred();
  const f = fixture({ signal: controller.signal, getConnection: () => pending.promise });
  f.session.push(new Float32Array(100)); await tick(); controller.abort();
  pending.resolve({ url: 'wss://example.test/live-stream', token: 'old-user-token' }); await tick();
  assert.equal(f.sockets.length, 0); assert.equal(f.active, false);
  await assert.rejects(f.session.finish(new Blob()), { name: 'AbortError' });
  assert.equal(f.saves, 0);
});

test('an account abort closes an already-connected stream before any subsequent upload', async () => {
  const controller = new AbortController(), f = fixture({ signal: controller.signal });
  f.session.push(new Float32Array(100)); await tick(); controller.abort(); await tick();
  assert.equal(f.sockets[0].readyState, 3);
  await assert.rejects(f.session.finish(new Blob()), { name: 'AbortError' });
  assert.equal(f.saves, 0);
});

test('cancellation releases a hung credential lookup so Stop can save the audio', async () => {
  const pending = deferred(), f = fixture({ getConnection: () => pending.promise });
  f.session.push(new Float32Array(100)); await tick(); f.session.cancel();
  assert.equal((await f.session.finish(new Blob())).complete, false);
  assert.equal(f.saves, 1); assert.equal(f.sockets.length, 0);
  pending.resolve({ url: 'wss://example.test/live-stream', token: 'late-token' }); await tick();
  assert.equal(f.sockets.length, 0);
});

test('a stalled credential lookup times out before opening any provider stream', async () => {
  const timers = fakeTimers(), pending = deferred(), f = fixture({ timers, getConnection: () => pending.promise });
  f.session.push(new Float32Array(100)); await tick(); timers.run(15_000); await tick();
  assert.match(f.session.getState().error.message, /Sign-in could not be confirmed/);
  assert.equal((await f.session.finish(new Blob())).complete, false);
  assert.equal(f.sockets.length, 0); assert.equal(timers.size, 0);
  pending.resolve({ url: 'wss://example.test/live-stream', token: 'late-token' });
});

test('discarding while Stop waits for final words prevents the upload', async () => {
  const pending = deferred(), f = fixture({ socket: { onFinish: () => pending.promise } });
  f.session.push(new Float32Array(100)); await tick();
  const finishing = f.session.finish(new Blob()); await tick();
  assert.equal(f.session.abandon(), true);
  await assert.rejects(finishing, { name: 'AbortError' });
  pending.resolve('Discarded words'); await tick();
  assert.equal(f.saves, 0); assert.equal(f.session.abandon(), false);
});

test('discarding during upload prevents finalization and a stale take result', async () => {
  const entered = deferred(), response = deferred();
  const f = fixture({ saveAudio: async () => { entered.resolve(); await response.promise; } });
  f.session.push(new Float32Array(100));
  const finishing = f.session.finish(new Blob()); await entered.promise;
  f.session.abandon(); response.resolve();
  await assert.rejects(finishing, { name: 'AbortError' });
  assert.equal(f.saves, 1); assert.ok(!f.calls.some(call => call.path.endsWith('/finish')));
});

test('an unexpected close fails explicitly without replaying uncertain audio or claiming completion', async () => {
  const f = fixture(); f.session.push(new Float32Array(100)); await tick();
  f.sockets[0].close(1006); await tick();
  assert.match(f.session.getState().error.message, /closed/);
  assert.equal(f.sockets.length, 1);
  assert.equal((await f.session.finish(new Blob())).complete, false);
  assert.equal(f.saves, 1);
});

test('invalid acknowledgements or commit counts never silently drop audio', async () => {
  for (const type of ['audio_ack', 'segment_complete']) {
    const f = fixture({ socket: { autoComplete: false } });
    f.session.push(new Float32Array(100)); await tick();
    let finishing;
    if (type === 'segment_complete') { finishing = f.session.finish(new Blob()); await tick(); }
    f.sockets[0].serverMessage(type === 'audio_ack'
      ? { type, samples: 101 }
      : { type, samples: 99, consumedSamples: 99, nextSequence: 1, transcript: 'Incomplete' });
    assert.ok(f.session.getState().error);
    assert.equal((await (finishing || f.session.finish(new Blob()))).complete, false);
    assert.equal(f.sockets.length, 1);
  }
});

test('a bounded connection timeout stops work and retains an explicit complete-audio retry', async () => {
  const timers = fakeTimers(), f = fixture({ timers, socket: { autoReady: false } });
  f.session.push(new Float32Array(100)); await tick();
  timers.run(15_000); await tick();
  assert.match(f.session.getState().error.message, /did not start/);
  assert.equal(f.sockets[0].readyState, 3);
  assert.equal((await f.session.finish(new Blob())).complete, false);
  assert.equal(timers.size, 0);
});

test('a finalization timeout cannot hang Stop indefinitely or mark the transcript complete', async () => {
  const timers = fakeTimers(), f = fixture({ timers, socket: { autoComplete: false } });
  f.session.push(new Float32Array(100)); await tick();
  const finishing = f.session.finish(new Blob()); await tick(); timers.run(20_000);
  assert.equal((await finishing).complete, false);
  assert.match(f.session.getState().error.message, /did not finish/); assert.equal(timers.size, 0);
});

test('the live backlog and total recording duration are explicitly bounded', async () => {
  const backlog = fixture();
  assert.throws(() => backlog.session.push(new Float32Array(24_000 * 31)), { code: 'LIVE_BACKLOG_LIMIT' });
  await tick(); assert.equal(backlog.sockets.length, 0); assert.equal(backlog.calls.length, 0);
  const duration = fixture();
  assert.throws(() => duration.session.push(new Float32Array(24_000 * 900 + 1)), { code: 'LIVE_AUDIO_LIMIT' });
  await tick(); assert.equal(duration.calls.length, 0);
});

test('fifteen minutes stream across ordinary segment rotations without dropped samples', async () => {
  const f = fixture(), frame = new Float32Array(24_000).fill(0.25);
  for (let second = 0; second < 900; second++) {
    f.session.push(frame);
    await tick();
  }
  assert.equal(f.session.getState().audioSeconds, 900);
  assert.equal((await f.session.finish(new Blob())).complete, true);
  assert.equal(f.sockets.reduce((sum, socket) => sum + socket.samples, 0), 21_600_000);
  assert.equal(f.session.getState().completedSeconds, 900);
  assert.equal(f.sockets.length, 9);
  assert.equal(f.saves, 1);
  assert.ok(f.sockets.every(socket => socket.readyState === 3));
});

test('capture-only recovery retains fifteen minutes after a stream failure and rejects one extra sample', async () => {
  let checkpointSamples = 0;
  const f = fixture({ checkpoint: bytes => { checkpointSamples += bytes.byteLength / 2; }, checkpointFlush: async () => {} });
  const frame = new Float32Array(24_000);
  f.session.push(frame); await tick();
  f.sockets[0].serverMessage({ type: 'error', message: 'Synthetic connection failure.' });
  for (let second = 1; second < 900; second++) f.session.captureRemaining(frame);
  assert.equal(f.session.getState().audioSeconds, 900);
  assert.throws(() => f.session.captureRemaining(new Float32Array(1)), { code: 'LIVE_AUDIO_LIMIT' });
  assert.equal((await f.session.finish(new Blob())).complete, false);
  assert.equal(checkpointSamples, 21_600_000);
  assert.equal(f.sockets.length, 1);
});

test('observer errors cannot prevent microphone streaming or final save', async () => {
  const f = fixture({ onUpdate: () => { throw new Error('Broken renderer'); }, onProgress: () => { throw new Error('Broken progress'); } });
  f.session.push(new Float32Array(100));
  assert.equal((await f.session.finish(new Blob())).complete, true);
});

test('checkpoints wait for verified start and include every PCM sample before sending, including the final tail', async () => {
  const entered = deferred(), response = deferred(), checkpointed = [];
  let initialized = false, flushed = 0;
  const f = fixture({ sampleRate: 16_000, request: async path => {
    if (path === '/live-sessions') { entered.resolve(); await response.promise; initialized = true; }
  }, checkpoint: bytes => { assert.equal(initialized, true); checkpointed.push(Buffer.from(bytes).subarray()); },
  checkpointFlush: async () => { flushed++; } });
  f.session.push(new Float32Array(101).fill(0.4)); await entered.promise;
  assert.equal(checkpointed.length, 0);
  const finishing = f.session.finish(new Blob()); response.resolve();
  assert.equal((await finishing).complete, true);
  assert.deepEqual(Buffer.concat(checkpointed), pcm(f));
  assert.equal(Buffer.concat(checkpointed).length / 2, Math.round(101 * 1.5));
  assert.ok(flushed > 0);
});

test('a checkpoint storage failure warns once while live words and final saving continue', async () => {
  const warnings = [], error = new Error('Browser storage is full.');
  const f = fixture({ checkpoint: () => { throw error; }, onCheckpointError: value => warnings.push(value),
    socket: { onAudio: () => 'Still live.' } });
  f.session.push(new Float32Array(100)); await tick();
  f.session.push(new Float32Array(100)); await tick();
  assert.equal(f.session.getState().text, 'Still live.');
  assert.equal(f.session.getState().checkpointError, error); assert.equal(f.session.getState().error, null);
  assert.deepEqual(warnings, [error]); assert.equal((await f.session.finish(new Blob())).complete, true);
});

test('Stop waits for outstanding checkpoint writes before the complete-audio save', async () => {
  const pending = deferred();
  const f = fixture({ checkpoint: () => pending.promise, checkpointFlush: async () => {} });
  f.session.push(new Float32Array(100)); await tick();
  const finishing = f.session.finish(new Blob()); await tick();
  assert.equal(f.saves, 0);
  pending.resolve(); assert.equal((await finishing).complete, true); assert.equal(f.saves, 1);
});

test('recording checkpoints continue after live transcription fails without reopening or replaying the stream', async () => {
  const checkpointed = [];
  const f = fixture({ sampleRate: 16_000, checkpoint: bytes => checkpointed.push(bytes.slice(0)), checkpointFlush: async () => {} });
  f.session.push(new Float32Array(1600)); await tick();
  f.sockets[0].serverMessage({ type: 'error', message: 'Speech connection lost.' }); f.session.cancel();
  f.session.captureRemaining(new Float32Array(16_000 * 35));
  assert.equal(f.sockets.length, 1); assert.equal(f.sockets[0].samples, 2399, 'The interpolated boundary sample waits for the next source frame');
  assert.equal((await f.session.finish(new Blob())).complete, false);
  assert.equal(checkpointed.reduce((sum, bytes) => sum + bytes.byteLength / 2, 0), 24_000 * 35.1);
  assert.equal(f.session.getState().audioSeconds, 35.1);
});

test('abandoning prevents additional private checkpoints, but cancellation does not delete existing drafts', async () => {
  const checkpoints = [], f = fixture({ checkpoint: bytes => checkpoints.push(bytes), checkpointFlush: async () => {} });
  f.session.push(new Float32Array(100)); await tick(); const count = checkpoints.length;
  f.session.abandon();
  assert.throws(() => f.session.captureRemaining(new Float32Array(100)), { name: 'AbortError' });
  assert.equal(checkpoints.length, count, 'Draft deletion belongs to confirmed account/cancel cleanup');
});

test('long silence may rotate a connection but never stops or saves the user recording', async () => {
  const timers = fakeTimers(), f = fixture({ timers });
  f.session.push(new Float32Array(100)); await tick(); timers.run(95_000); await tick();
  assert.equal(f.session.getState().finished, false); assert.equal(f.session.getState().finishing, false);
  assert.equal(f.saves, 0); assert.ok(!f.calls.some(call => call.path.endsWith('/finish')));
  f.session.push(new Float32Array(100)); await tick();
  assert.equal(f.sockets.length, 2);
  assert.equal((await f.session.finish(new Blob())).complete, true);
});

test('the frame that first exceeds network backlog is retained in recovery before switching to capture-only', async () => {
  const checkpoints = [], f = fixture({ checkpoint: bytes => checkpoints.push(bytes.slice(0)), checkpointFlush: async () => {},
    socket: { autoReady: false } });
  await tick();
  f.session.push(new Float32Array(24_000 * 30));
  assert.throws(() => f.session.push(new Float32Array(100)), { code: 'LIVE_BACKLOG_LIMIT' });
  f.session.cancel(); f.session.captureRemaining(new Float32Array(200));
  assert.equal((await f.session.finish(new Blob())).complete, false);
  assert.equal(checkpoints.reduce((sum, bytes) => sum + bytes.byteLength / 2, 0), 24_000 * 30 + 300);
});

test('failed session creation warns that refresh recovery never started and releases unencrypted pending frames', async () => {
  const warnings = [], checkpoints = [];
  const f = fixture({ request: async path => { if (path === '/live-sessions') throw new Error('Connection unavailable'); },
    checkpoint: bytes => checkpoints.push(bytes), onCheckpointError: error => warnings.push(error) });
  f.session.push(new Float32Array(100)); await tick();
  assert.equal(warnings.length, 1); assert.match(warnings[0].message, /could not start/);
  f.session.captureRemaining(new Float32Array(100));
  assert.equal(checkpoints.length, 0);
  await assert.rejects(f.session.finish(new Blob()), /Connection unavailable/);
});
