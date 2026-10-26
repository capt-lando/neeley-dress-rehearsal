import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveTranscription as createSession } from '../lib/live-transcription.mjs';
// Short windows keep queue/merge tests independent of the production defaults.
const createLiveTranscription = options => createSession({ chunkSeconds: 8, overlapSeconds: 1, ...options });

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const pcm = (length, start = 0) => Float32Array.from({ length }, (_, index) => start + index);

test('default windows stay at 30 seconds, overlap by two and flush a final remainder on stop', async () => {
  const calls = [];
  const session = createSession({sampleRate:10, transcribe:async (samples, metadata)=>{calls.push({samples:[...samples],metadata});return '';}});
  session.push(pcm(299)); await tick(); assert.equal(calls.length, 0);
  session.push(pcm(1, 299)); await tick(); assert.equal(calls.length, 1);
  session.push(pcm(279, 300)); await tick(); assert.equal(calls.length, 1);
  session.push(pcm(1, 579)); await tick(); assert.equal(calls.length, 2);
  session.push(pcm(11, 580)); await session.finish();
  assert.deepEqual(calls.map(call=>call.samples), [[...pcm(300)],[...pcm(300,280)],[...pcm(31,560)]]);
  assert.deepEqual(calls.map(({metadata:m})=>[m.startSeconds,m.endSeconds,m.overlapSeconds,m.isFinal]), [[0,30,0,false],[28,58,2,false],[56,59.1,2,true]]);
  assert.deepEqual(calls.flatMap(({samples,metadata})=>samples.slice(metadata.overlapSeconds*10)), [...pcm(591)]);
  assert.equal(session.getState().completedSeconds, 59.1);
});

test('default stop flushes partial windows immediately without adding overlap-only jobs at exact boundaries', async () => {
  const sampleRate = 100;
  for (const [length, expectedLengths] of [
    [0, []], [1, [1]], [2999, [2999]], [3000, [3000]], [3001, [3000, 201]],
    [5800, [3000, 3000]], [5801, [3000, 3000, 201]], [8600, [3000, 3000, 3000]],
  ]) {
    const calls = [];
    const session = createSession({ sampleRate, transcribe: async (samples, metadata) => { calls.push({ samples: [...samples], metadata }); return ''; } });
    session.push(pcm(length));
    const result = await session.finish();
    assert.deepEqual(calls.map(call => call.samples.length), expectedLengths);
    assert.deepEqual(calls.flatMap(({ samples, metadata }) => samples.slice(metadata.overlapSeconds * sampleRate)), [...pcm(length)]);
    assert.ok(calls.every(call => call.samples.length <= 30 * sampleRate));
    assert.equal(result.durationSeconds, length / sampleRate);
    assert.equal(session.getState().pendingSeconds, 0);
  }
});

test('real cut-off numbers and phrases are corrected using unique boundary anchors', async () => {
  const outputs = [
    'The starting budget would be $300, not $300.',
    'budget would be $300, not $3,000. We would spend $80 on basic tools. For example, a loose bicycle brake may need an adjustment in',
    'a loose bicycle brake may need an adjustment instead of a complete replacement. We should explain these limits clearly, because volunteers must not attempt preparing',
    'Early, because volunteers must not attempt repairs they cannot complete safely. Next, we would record the number of completed repairs.',
  ];
  const session = createSession({sampleRate:1, transcribe:async()=>outputs.shift()});
  session.push(pcm(114));
  assert.equal((await session.finish()).text, 'The starting budget would be $300, not $3,000. We would spend $80 on basic tools. For example, a loose bicycle brake may need an adjustment instead of a complete replacement. We should explain these limits clearly, because volunteers must not attempt repairs they cannot complete safely. Next, we would record the number of completed repairs.');
});

test('boundary repair handles a split numeric prefix and preserves internal repetitions', async () => {
  const outputs=['Um, um, the budget is $300, not $3.', '000, not $3,000. I, I would proceed.'];
  const session=createLiveTranscription({sampleRate:1,transcribe:async()=>outputs.shift()});
  session.push(pcm(15));
  assert.equal((await session.finish()).text,'Um, um, the budget is $300, not $3,000. I, I would proceed.');
});

test('ambiguous boundary anchors do not overwrite existing speech', async () => {
  const outputs=['Earlier meaning. we can x we can wrong', 'we can improve.'];
  const session=createSession({sampleRate:1,transcribe:async()=>outputs.shift()});
  session.push(pcm(58));
  assert.equal((await session.finish()).text,'Earlier meaning. we can x we can wrong we can improve.');
});

test('exact boundary matching preserves the corrected punctuation of a cut-off number', async () => {
  for (const continuation of ['not $3,000. We would spend $80.', '$3,000. We would spend $80.']) {
    const outputs=['The budget would be $300, not $3.', continuation];
    const session=createSession({sampleRate:1,transcribe:async()=>outputs.shift()});
    session.push(pcm(58));
    assert.equal((await session.finish()).text,'The budget would be $300, not $3,000. We would spend $80.');
  }
});

test('new audio is batched once with one-second overlap and correct unique progress', async () => {
  const calls = [], updates = [];
  const session = createLiveTranscription({ sampleRate: 10, onUpdate: state => updates.push(state), transcribe: async (samples, meta) => { calls.push({ samples: [...samples], ...meta }); return `part ${meta.index}`; } });
  session.push(pcm(37)); session.push(pcm(128, 37));
  const result = await session.finish();
  assert.deepEqual(calls.map(call => call.samples), [Array.from(pcm(80)), Array.from(pcm(80, 70)), Array.from(pcm(25, 140))]);
  assert.deepEqual(calls.map(({ startSeconds, endSeconds, overlapSeconds, isFinal }) => [startSeconds, endSeconds, overlapSeconds, isFinal]), [[0, 8, 0, false], [7, 15, 1, false], [14, 16.5, 1, true]]);
  assert.equal(result.durationSeconds, 16.5);
  assert.equal(session.getState().completedSeconds, 16.5);
  assert.equal(session.getState().pendingChunks, 0);
  assert.equal(session.getState().finished, true);
  assert.ok(updates.some(state => state.completedSeconds === 8));
});

test('slow inference is serial and catches up without dropping queued PCM', async () => {
  const gates = [], calls = [];
  const session = createLiveTranscription({ sampleRate: 1, transcribe: (samples, meta) => { const gate = deferred(); gates.push(gate); calls.push({ samples: [...samples], meta }); return gate.promise; } });
  session.push(pcm(22)); await tick();
  assert.equal(calls.length, 1);
  assert.equal(session.getState().pendingChunks, 3);
  assert.equal(session.getState().catchingUp, true);
  const result = session.finish();
  gates[0].resolve('first section'); await tick(); assert.equal(calls.length, 2);
  gates[1].resolve('next section'); await tick(); assert.equal(calls.length, 3);
  gates[2].resolve('last section');
  assert.deepEqual(await result, { text: 'first section next section last section', durationSeconds: 22 });
  assert.equal(session.getState().pendingSeconds, 0);
});

test('stop flushes a final fragment shorter than half a second, even a single sample', async () => {
  const calls = [];
  const session = createLiveTranscription({ sampleRate: 100, transcribe: async (samples, meta) => { calls.push({ length: samples.length, meta }); return meta.isFinal ? 'last word' : 'Opening'; } });
  session.push(new Float32Array(801));
  assert.deepEqual(await session.finish(), { text: 'Opening last word', durationSeconds: 8.01 });
  assert.deepEqual(calls.map(call => call.length), [800, 101]);
  assert.equal(calls[1].meta.isFinal, true);
});

test('pause adds no elapsed time or silent padding and stop at an exact boundary adds no job', async () => {
  const calls = [];
  const session = createLiveTranscription({ sampleRate: 2, transcribe: async samples => { calls.push([...samples]); return 'heard'; } });
  session.push(pcm(8)); await tick(); // No pushes while the recorder is paused.
  assert.equal(calls.length, 0); assert.equal(session.getState().audioSeconds, 4);
  session.push(pcm(8, 8));
  assert.deepEqual(await session.finish(), { text: 'heard', durationSeconds: 8 });
  assert.equal(calls.length, 1); assert.deepEqual(calls[0], Array.from(pcm(16)));
});

test('known boundary overlap is removed while deliberate repetitions inside chunks survive', async () => {
  const results = ['I, I think we should act.', 'we should act. Um, um, we should act now.', 'act now. I, I agree.'];
  const session = createLiveTranscription({ sampleRate: 1, transcribe: async () => ({ text: results.shift() }) });
  session.push(pcm(22));
  assert.equal((await session.finish()).text, 'I, I think we should act. Um, um, we should act now. I, I agree.');
});

test('overlap comparison is limited and is disabled when there is no shared audio', async () => {
  const result = 'one two three four five six seven eight';
  const session = createLiveTranscription({ sampleRate: 1, transcribe: async () => result });
  session.push(pcm(15));
  assert.equal((await session.finish()).text, `${result} ${result}`, 'do not remove eight words when only six boundary words are eligible');
  const noOverlap = createLiveTranscription({ sampleRate: 1, overlapSeconds: 0, transcribe: async () => 'I repeat' });
  noOverlap.push(pcm(16));
  assert.equal((await noOverlap.finish()).text, 'I repeat I repeat');
});

test('silence is valid empty output and does not deduplicate speech across a silent chunk', async () => {
  const outputs = ['Hello.', '', 'Hello.'];
  const session = createLiveTranscription({ sampleRate: 1, transcribe: async () => outputs.shift() });
  session.push(pcm(22)); assert.equal((await session.finish()).text, 'Hello. Hello.');
  const silent = createLiveTranscription({ sampleRate: 1, transcribe: async () => ({ text: '' }) });
  silent.push(new Float32Array(3)); assert.deepEqual(await silent.finish(), { text: '', durationSeconds: 3 });
  const empty = createLiveTranscription({ sampleRate: 1, transcribe: () => assert.fail('No audio should not invoke the engine') });
  assert.deepEqual(await empty.finish(), { text: '', durationSeconds: 0 });
});

test('cancellation aborts current work, rejects finish, and ignores a late result', async () => {
  const gate = deferred(), updates = []; let signal, calls = 0;
  const session = createLiveTranscription({ sampleRate: 1, onUpdate: state => updates.push(state), transcribe: (_, meta) => { calls++; signal = meta.signal; return gate.promise; } });
  session.push(pcm(24)); await tick();
  const finishing = session.finish(); session.cancel();
  assert.equal(signal.aborted, true);
  await assert.rejects(finishing, { name: 'AbortError' });
  const updateCount = updates.length;
  gate.resolve('stale text'); await tick();
  assert.equal(calls, 1); assert.equal(updates.length, updateCount); assert.equal(session.getState().text, '');
  assert.throws(() => session.push(pcm(1)), { name: 'AbortError' });
});

test('engine failure is explicit, stops the queue, and does not discard the partial transcript', async () => {
  const failure = new Error('Engine unavailable'); let calls = 0;
  const session = createLiveTranscription({ sampleRate: 1, transcribe: async () => { if (++calls === 1) return 'Saved partial'; throw failure; } });
  session.push(pcm(24));
  await assert.rejects(session.finish(), failure);
  assert.equal(calls, 2); assert.equal(session.getState().error, failure); assert.equal(session.getState().text, 'Saved partial');
  assert.equal(session.getState().completedSeconds, 8); assert.equal(session.getState().audioSeconds, 24);
});

test('caller mutation and transferred inference buffers cannot corrupt queued audio or overlap', async () => {
  const calls = [];
  const session = createLiveTranscription({ sampleRate: 1, transcribe: async samples => { calls.push([...samples]); structuredClone(samples.buffer, { transfer: [samples.buffer] }); return ''; } });
  const input = pcm(15); session.push(input); input.fill(-100);
  await session.finish();
  assert.deepEqual(calls, [Array.from(pcm(8)), Array.from(pcm(8, 7))]);
});

test('default backlog reconstructs all 600 seconds at 16 kHz with no window exceeding 30 seconds', async () => {
  const sampleRate = 16_000, input = pcm(sampleRate * 600), calls = [];
  let reconstructed = 0;
  const session = createSession({ sampleRate, transcribe: async (samples, metadata) => {
    const start = Math.round(metadata.startSeconds * sampleRate), end = Math.round(metadata.endSeconds * sampleRate);
    assert.ok(samples.length <= sampleRate * 30);
    assert.equal(start + metadata.overlapSeconds * sampleRate, reconstructed);
    assert.deepEqual(samples, input.subarray(start, end));
    reconstructed = end;
    calls.push(metadata);
    return '';
  } });
  // Irregular frames exercise rollover without relying on capture alignment.
  for (let offset = 0; offset < input.length; offset += 137_003) session.push(input.subarray(offset, offset + 137_003));
  assert.equal(session.getState().pendingChunks, 22);
  assert.equal((await session.finish()).durationSeconds, 600);
  assert.equal(reconstructed, input.length);
  assert.equal(calls.length, 22);
  assert.deepEqual(calls.map(call => call.endSeconds), [...Array.from({ length: 21 }, (_, i) => 30 + i * 28), 600]);
  assert.equal(calls.at(-1).startSeconds, 588);
  assert.equal(calls.at(-1).isFinal, true);
  assert.equal(session.getState().completedSeconds, 600);
});

test('default backlog rejects overflow explicitly without accepting excess PCM', async () => {
  const overflow = createSession({ sampleRate: 1, transcribe: async () => '' });
  overflow.push(pcm(600));
  assert.throws(() => overflow.push(pcm(1)), { code: 'LIVE_AUDIO_LIMIT' });
  await assert.rejects(overflow.finish(), { code: 'LIVE_AUDIO_LIMIT' });
  assert.equal(overflow.getState().audioSeconds, 600);
});

test('window settings respect the engine limit and cannot round to a zero-sample advance', () => {
  for (const options of [
    { chunkSeconds: 31 }, { chunkSeconds: 30, overlapSeconds: 30 },
    { sampleRate: 1, chunkSeconds: 1, overlapSeconds: 0.75 }, { maxSeconds: 601 },
  ]) {
    assert.throws(() => createSession({ sampleRate: 16_000, transcribe: async () => '', ...options }), RangeError);
  }
});

test('finish is idempotent, rejects malformed output, and rejects pushes after stop', async () => {
  const session = createLiveTranscription({ sampleRate: 1, transcribe: async () => 'Done' });
  session.push(pcm(3)); const first = session.finish(); assert.equal(session.finish(), first);
  assert.throws(() => session.push(pcm(1)), /already stopped/); await first;
  assert.equal(session.cancel(), false);
  const malformed = createLiveTranscription({ sampleRate: 1, transcribe: async () => ({ missing: true }) });
  malformed.push(pcm(1)); await assert.rejects(malformed.finish(), /invalid live transcript/);
});

test('preparation starts asynchronously, capture stays synchronous, and inference waits for readiness', async () => {
  const gate = deferred(), order = [];
  const session = createLiveTranscription({ sampleRate: 1,
    prepare: async () => { order.push('prepare'); await gate.promise; order.push('ready'); },
    transcribe: async () => { order.push('transcribe'); return 'Ready'; },
  });
  assert.deepEqual(order, []);
  assert.equal(session.push(pcm(8)), 8);
  assert.equal(session.getState().audioSeconds, 8);
  await tick(); assert.deepEqual(order, ['prepare']);
  const done = session.finish(); gate.resolve();
  assert.deepEqual(await done, { text: 'Ready', durationSeconds: 8 });
  assert.deepEqual(order, ['prepare', 'ready', 'transcribe']);
});

test('cancelling while warming uses the shared signal and ignores late preparation', async () => {
  const gate = deferred(); let signal, calls = 0;
  const session = createLiveTranscription({ sampleRate: 1, prepare: meta => { signal = meta.signal; return gate.promise; }, transcribe: async () => { calls++; return 'Late'; } });
  session.push(pcm(8)); await tick();
  const done = session.finish(); session.cancel();
  assert.equal(signal.aborted, true); await assert.rejects(done, { name: 'AbortError' });
  gate.resolve(); await tick();
  assert.equal(calls, 0); assert.equal(session.getState().text, ''); assert.equal(session.getState().cancelled, true);
});

test('preparation failures are observed before stop and later finish rejects without losing the error', async () => {
  const failure = new Error('Model unavailable'), updates = [];
  const session = createLiveTranscription({ sampleRate: 1, prepare: async () => { throw failure; }, onUpdate: state => updates.push(state), transcribe: () => assert.fail('Failed preparation must not run inference') });
  session.push(pcm(3)); await tick();
  assert.equal(updates.at(-1).error, failure);
  assert.equal(session.getState().audioSeconds, 3);
  await assert.rejects(session.finish(), failure);
});

test('empty finish still observes an in-flight preparation failure', async () => {
  const gate = deferred();
  const session = createLiveTranscription({ sampleRate: 1, prepare: () => gate.promise, transcribe: () => assert.fail('No samples') });
  const done = session.finish(); const rejection = assert.rejects(done, /Warmup failed/);
  gate.reject(new Error('Warmup failed')); await rejection;
});

test('audio frames do not create per-frame observer updates', async () => {
  const updates = [];
  const session = createLiveTranscription({ sampleRate: 100, onUpdate: state => updates.push(state), transcribe: async () => '' });
  for (let index = 0; index < 799; index++) session.push(new Float32Array(1));
  assert.equal(updates.length, 0); assert.equal(session.getState().audioSeconds, 7.99);
  session.push(new Float32Array(1)); assert.equal(updates.length, 1);
  await session.finish(); assert.ok(updates.length <= 6);
});
