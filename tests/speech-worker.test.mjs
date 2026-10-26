import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { BARK_SAMPLE_RATE, splitBarkWindows } from '../lib/bark-engine.mjs';
import { BARK_MODEL_ID, BARK_STANDARD_ID, BARK_CLEAN_ID } from '../lib/speech-models.mjs';

const workerSource = (await readFile(new URL('../public/speech-worker.js', import.meta.url), 'utf8')).replace(/^import .*;[\r\n]*/gm, '');
const pcm = (seconds = 1, amplitude = 0.1) => new Float32Array(Math.round(seconds * BARK_SAMPLE_RATE)).fill(amplitude);
const recognized = () => ({ text: 'Recognized speech.', chunks: [] });

function harness({ gpu = false, f16 = true, adapterError = false, allowedModels = [BARK_MODEL_ID], makeEngine = () => ({ transcribe: async () => recognized(), async release() {} }) } = {}) {
  const messages = [], loads = [];
  let adapterCalls = 0;
  const context = {
    Float32Array, BARK_SAMPLE_RATE, splitBarkWindows, BARK_STANDARD_ID,
    isBarkModel: model => allowedModels.includes(model),
    loadBarkModel: async options => { loads.push(options); return makeEngine({ ...options, loadNumber: loads.length }); },
    self: {
      navigator: gpu || adapterError ? { gpu: { async requestAdapter() {
        adapterCalls++;
        if (adapterError) throw new Error('Adapter unavailable');
        return gpu ? { features: new Set(f16 ? ['shader-f16'] : []) } : null;
      } } } : {},
      postMessage(message) { messages.push(structuredClone(message)); },
    },
  };
  vm.createContext(context);
  vm.runInContext(workerSource, context);
  return {
    messages, loads, adapterCalls: () => adapterCalls,
    send: ({ id = 'take', model = BARK_MODEL_ID, samples = pcm(), ...operation } = {}) => context.self.onmessage({ data: { id, model, samples, ...operation } }),
  };
}
const finalMessage = (h, id = 'take') => h.messages.filter(message => message.id === id && message.type !== 'progress').at(-1);
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('unregistered models and unknown operations fail before model loading or GPU probing', async () => {
  const h = harness({ gpu: true });
  for (const model of ['onnx-community/whisper-base.en', 'onnx-community/whisper-small.en', 'https://example.com/model', '__proto__', null]) {
    await h.send({ model });
    assert.equal(finalMessage(h).type, 'error');
  }
  await h.send({ type: 'arbitrary' });
  assert.equal(finalMessage(h).type, 'error');
  assert.equal(h.loads.length, 0);
  assert.equal(h.adapterCalls(), 0);
});

test('both live and full-take PCM must be nonempty, finite, normalized and within their duration limit', async () => {
  const h = harness({ gpu: true });
  for (const type of ['chunk', 'transcribe']) {
    const limit = type === 'chunk' ? 30 : 600;
    for (const samples of [[], null, new Float32Array(), new Float32Array(limit * BARK_SAMPLE_RATE + 1), new Float32Array([NaN]), new Float32Array([Infinity]), new Float32Array([-Infinity]), new Float32Array([1.01]), new Float32Array([-1.01])]) {
      await h.send({ type, samples });
      assert.equal(finalMessage(h).type, 'error');
    }
  }
  assert.equal(h.loads.length, 0);
  assert.equal(h.adapterCalls(), 0);
  await h.send({ type: 'chunk', samples: new Float32Array([-1, 1]) });
  assert.equal(finalMessage(h).type, 'result');
});

test('only Standard requires shader-f16; unsupported or failed adapter probes use WASM', async () => {
  for (const model of [BARK_MODEL_ID, BARK_STANDARD_ID, BARK_CLEAN_ID]) {
    for (const setup of [{ gpu: true }, { gpu: true, f16: false }, { gpu: false }, { adapterError: true }]) {
      const expected = setup.gpu && (model !== BARK_STANDARD_ID || setup.f16 !== false) ? 'webgpu' : 'wasm';
      const h = harness({ ...setup, allowedModels: [model] });
      await h.send({ model });
      assert.deepEqual(h.loads.map(item => item.device), [expected]);
      assert.equal(h.loads[0].model, model);
      assert.equal(finalMessage(h).result.device, expected);
      await h.send({ id: 'cached', model });
      assert.equal(h.loads.length, 1);
      assert.equal(h.adapterCalls(), setup.gpu || setup.adapterError ? 1 : 0);
    }
  }
});

test('load and inference progress retain the request ID and exactly one final result', async () => {
  const h = harness({ makeEngine({ onProgress }) {
    onProgress('Downloading Bark… 50%');
    return { async transcribe(_samples, options) { options.onProgress('Transcribing Bark… 50%'); return { text: '  Hello, Neeley students.  ', chunks: [] }; } };
  } });
  await h.send({ id: 'english' });
  assert.equal(finalMessage(h, 'english').result.text, 'Hello, Neeley students.');
  assert.deepEqual(finalMessage(h, 'english').result.chunks, []);
  assert.equal(h.messages.filter(message => message.type === 'result').length, 1);
  assert.ok(h.messages.some(message => message.message === 'Downloading Bark… 50%'));
  assert.ok(h.messages.some(message => message.message === 'Transcribing Bark… 50%'));
  assert.ok(h.messages.every(message => message.id === 'english'));
});

test('GPU model initialization retries once on WASM and keeps that choice for later requests', async () => {
  const h = harness({ gpu: true, makeEngine({ device }) {
    if (device === 'webgpu') throw new Error('Graphics initialization failed');
    return { transcribe: async () => recognized() };
  } });
  await h.send();
  await h.send({ id: 'later', type: 'chunk' });
  assert.deepEqual(h.loads.map(item => item.device), ['webgpu', 'wasm']);
  assert.equal(h.adapterCalls(), 1);
  assert.equal(finalMessage(h, 'later').result.device, 'wasm');
});

test('GPU inference failure releases its sessions before retrying the same live samples on WASM', async () => {
  const lifecycle = [], samples = pcm(8);
  const h = harness({ gpu: true, makeEngine({ device }) {
    lifecycle.push(`load:${device}`);
    return {
      async transcribe(actual) { assert.equal(actual, samples); lifecycle.push(`run:${device}`); if (device === 'webgpu') throw new Error('Device lost'); return recognized(); },
      async release() { lifecycle.push(`release:${device}`); },
    };
  } });
  await h.send({ type: 'chunk', samples });
  assert.deepEqual(lifecycle, ['load:webgpu', 'run:webgpu', 'release:webgpu', 'load:wasm', 'run:wasm']);
  assert.equal(finalMessage(h).result.device, 'wasm');
});

test('a rejected GPU release cannot prevent compatible-engine recovery', async () => {
  const h = harness({ gpu: true, makeEngine({ device }) {
    return {
      async transcribe() { if (device === 'webgpu') throw new Error('Device lost'); return recognized(); },
      async release() { if (device === 'webgpu') throw new Error('Release failed'); },
    };
  } });
  await h.send();
  assert.deepEqual(h.loads.map(item => item.device), ['webgpu', 'wasm']);
  assert.equal(finalMessage(h).type, 'result');
});

test('registered model changes release the old sessions and do not reuse another variant', async () => {
  const secondModel = 'registered-bark-test-variant';
  const lifecycle = [];
  const h = harness({ allowedModels: [BARK_MODEL_ID, secondModel], makeEngine({ model }) {
    lifecycle.push(`load:${model}`);
    return { transcribe: async () => ({ text: model }), async release() { lifecycle.push(`release:${model}`); } };
  } });
  await h.send(); await h.send({ id: 'cached' });
  assert.equal(h.loads.length, 1);
  await h.send({ id: 'changed', model: secondModel });
  assert.deepEqual(lifecycle, [`load:${BARK_MODEL_ID}`, `release:${BARK_MODEL_ID}`, `load:${secondModel}`]);
  assert.equal(finalMessage(h, 'changed').result.text, secondModel);
});

test('preload optionally warms one second once, discards synthetic output, and reuses sessions for live audio', async () => {
  const calls = [];
  const h = harness({ makeEngine: () => ({ async transcribe(samples) { calls.push(samples); return { text: 'Synthetic or real speech.' }; } }) });
  await h.send({ id: 'load', type: 'preload', warmup: false });
  assert.equal(calls.length, 0);
  await h.send({ id: 'warm', type: 'preload' });
  assert.equal(calls[0].length, BARK_SAMPLE_RATE);
  assert.ok(calls[0].every(value => value === 0));
  assert.deepEqual(finalMessage(h, 'warm').result, { ready: true, device: 'wasm' });
  await h.send({ id: 'again', type: 'preload' });
  assert.equal(calls.length, 1);
  const audio = pcm(8);
  await h.send({ id: 'live', type: 'chunk', samples: audio });
  assert.equal(calls.length, 2); assert.equal(calls[1], audio);
  assert.equal(h.loads.length, 1);
  assert.equal(finalMessage(h, 'live').result.text, 'Synthetic or real speech.');
});

test('failed GPU warmup falls back once and remembers the compatible engine', async () => {
  const calls = [];
  const h = harness({ gpu: true, makeEngine: ({ device }) => ({ async transcribe(samples) {
    calls.push({ device, length: samples.length });
    if (device === 'webgpu') throw new Error('Warmup failed');
    return recognized();
  } }) });
  await h.send({ type: 'preload' });
  await h.send({ id: 'live', type: 'chunk', samples: pcm(8) });
  assert.deepEqual(calls, [{ device: 'webgpu', length: 16000 }, { device: 'wasm', length: 16000 }, { device: 'wasm', length: 128000 }]);
  assert.equal(h.loads.length, 2);
});

test('full takes use actual disjoint quiet windows up to 30 seconds without dropping repeated speech', async () => {
  for (const seconds of [0.5, 30, 30 + 1 / BARK_SAMPLE_RATE, 61, 600]) {
    const audio = pcm(seconds), calls = [];
    if (seconds > 30) audio.fill(0, 25 * BARK_SAMPLE_RATE, 25.1 * BARK_SAMPLE_RATE);
    const windows = splitBarkWindows(audio);
    const h = harness({ makeEngine: () => ({ async transcribe(samples) { calls.push(samples); return { text: 'um um same phrase' }; } }) });
    await h.send({ samples: audio });
    assert.equal(finalMessage(h).type, 'result');
    assert.equal(calls.length, windows.length);
    assert.equal(calls.reduce((total, samples) => total + samples.length, 0), audio.length);
    for (const [index, samples] of calls.entries()) {
      assert.equal(samples.buffer, audio.buffer);
      assert.equal(samples.byteOffset, windows[index][0] * 4);
      assert.equal(samples.length, windows[index][1] - windows[index][0]);
      assert.ok(samples.length <= 30 * BARK_SAMPLE_RATE);
    }
    assert.equal(finalMessage(h).result.text, windows.map(() => 'um um same phrase').join(' '));
    const completed = h.messages.filter(message => /^Transcribed \d+ of/.test(message.message));
    assert.equal(completed.length, windows.length);
    assert.equal(completed.at(-1).message, `Transcribed ${windows.length} of ${windows.length} sections on this device…`);
  }
});

test('partial GPU failure restarts full-take windows on CPU without joining partial GPU output', async () => {
  const audio = pcm(61), expected = splitBarkWindows(audio).length;
  const counts = { webgpu: 0, wasm: 0 };
  const h = harness({ gpu: true, makeEngine: ({ device }) => ({ async transcribe() {
    counts[device]++;
    if (device === 'webgpu' && counts[device] === 2) throw new Error('Device lost after one window');
    return { text: device === 'webgpu' ? 'Discard partial graphics result.' : 'Retain complete CPU result.' };
  } }) });
  await h.send({ samples: audio });
  assert.equal(counts.webgpu, 2); assert.equal(counts.wasm, expected);
  assert.equal(finalMessage(h).result.text, Array(expected).fill('Retain complete CPU result.').join(' '));
  assert.equal(finalMessage(h).result.device, 'wasm');
  assert.equal(h.messages.filter(message => message.type === 'result').length, 1);
});

test('near-digital silence skips loading; empty recognition is valid only for live chunks', async () => {
  const h = harness({ gpu: true, makeEngine: () => ({ transcribe: async () => ({ text: ' ', chunks: [{ text: 'Unusable' }] }) }) });
  for (const amplitude of [0, 0.00001]) {
    await h.send({ type: 'chunk', samples: pcm(8, amplitude) });
    assert.deepEqual(finalMessage(h).result, { text: '', chunks: [], device: null });
    await h.send({ samples: pcm(8, amplitude) });
    assert.equal(finalMessage(h).type, 'error');
    assert.match(finalMessage(h).message, /No speech/);
  }
  assert.equal(h.loads.length, 0); assert.equal(h.adapterCalls(), 0);
  await h.send({ type: 'chunk' });
  assert.deepEqual(finalMessage(h).result, { text: '', chunks: [], device: 'webgpu' });
  await h.send();
  assert.equal(finalMessage(h).type, 'error');
  assert.equal(h.loads.length, 1, 'empty recognition must not trigger a CPU model download');
});

test('full takes skip silent windows without erasing words before or after them', async () => {
  const audio = pcm(70, 0);
  audio.fill(0.1, 0, 10 * BARK_SAMPLE_RATE);
  audio.fill(0.1, 65 * BARK_SAMPLE_RATE);
  const windows = splitBarkWindows(audio);
  const calls = [];
  const h = harness({ makeEngine: () => ({ async transcribe(samples) { calls.push(samples); return { text: 'keep' }; } }) });
  await h.send({ samples: audio });
  assert.equal(calls.length, 2);
  assert.equal(finalMessage(h).result.text, 'keep keep');
  assert.equal(h.messages.filter(message => /^Transcribed \d+ of/.test(message.message)).length, windows.length);
});

test('WASM failures are sanitized, release sessions, and permit a later retry without looping', async () => {
  let releases = 0;
  const h = harness({ makeEngine({ loadNumber }) { return {
    async transcribe() { if (loadNumber === 1) throw new Error('SECRET private path diagnostic'); return recognized(); },
    async release() { releases++; },
  }; } });
  await h.send();
  assert.equal(h.loads.length, 1); assert.equal(releases, 1);
  assert.equal(h.messages.filter(message => message.type === 'error').length, 1);
  assert.doesNotMatch(JSON.stringify(h.messages), /SECRET|smaller model|Whisper/i);
  assert.equal(h.messages.some(message => message.type === 'result'), false);
  await h.send({ id: 'retry' });
  assert.equal(h.loads.length, 2);
  assert.equal(finalMessage(h, 'retry').type, 'result');
});

test('a GPU and CPU failure terminates after exactly two attempts', async () => {
  const h = harness({ gpu: true, makeEngine: () => ({ async transcribe() { throw new Error('Failure'); } }) });
  await h.send();
  assert.deepEqual(h.loads.map(item => item.device), ['webgpu', 'wasm']);
  assert.equal(h.messages.filter(message => message.type === 'error').length, 1);
  await h.send({ id: 'retry' });
  assert.deepEqual(h.loads.map(item => item.device), ['webgpu', 'wasm', 'wasm']);
  assert.equal(h.adapterCalls(), 1);
});

test('overlapping commands cannot start another model and completed work releases the busy guard', async () => {
  let finish;
  const h = harness({ makeEngine: () => ({ transcribe: () => new Promise(resolve => { finish = resolve; }) }) });
  const active = h.send({ id: 'active', type: 'chunk' });
  await nextTurn();
  await h.send({ id: 'overlap', type: 'preload' });
  assert.match(finalMessage(h, 'overlap').message, /Another recording/);
  assert.equal(h.loads.length, 1);
  finish(recognized()); await active;
  assert.equal(finalMessage(h, 'active').type, 'result');
  await h.send({ id: 'later', type: 'preload', warmup: false });
  assert.deepEqual(finalMessage(h, 'later').result, { ready: true, device: 'wasm' });
  assert.equal(h.loads.length, 1);
});
