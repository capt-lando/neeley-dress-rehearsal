import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { decodeRecording } from '../lib/wav.mjs';

function pcmData(length = 8000, amplitude = 8192) {
  const data = new Uint8Array(length * 2);
  const view = new DataView(data.buffer);
  for (let i = 0; i < length; i++) view.setInt16(i * 2, i % 2 ? -amplitude : amplitude, true);
  return data;
}

function wav({ length = 8000, amplitude = 8192, format = {}, chunks, data = pcmData(length, amplitude) } = {}) {
  const fmt = new Uint8Array(16);
  const view = new DataView(fmt.buffer);
  view.setUint16(0, format.encoding ?? 1, true);
  view.setUint16(2, format.channels ?? 1, true);
  view.setUint32(4, format.rate ?? 16000, true);
  view.setUint32(8, 32000, true);
  view.setUint16(12, 2, true);
  view.setUint16(14, format.bits ?? 16, true);
  const entries = chunks ?? [['fmt ', fmt], ['data', data]];
  const size = 12 + entries.reduce((sum, [, bytes]) => sum + 8 + bytes.length + (bytes.length % 2), 0);
  const buffer = new ArrayBuffer(size);
  const out = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const label = (offset, value) => [...value].forEach((char, index) => out.setUint8(offset + index, char.charCodeAt(0)));
  label(0, 'RIFF'); out.setUint32(4, size - 8, true); label(8, 'WAVE');
  let offset = 12;
  for (const [name, payload] of entries) {
    label(offset, name); out.setUint32(offset + 4, payload.length, true);
    bytes.set(payload, offset + 8); offset += 8 + payload.length + (payload.length % 2);
  }
  return buffer;
}

test('WAV decoding preserves signed PCM and derives duration from actual data', () => {
  const source = wav();
  const view = new DataView(source);
  view.setInt16(44, -32768, true); view.setInt16(46, 32767, true);
  const result = decodeRecording(source);
  assert.equal(result.durationSeconds, 0.5);
  assert.equal(result.samples.length, 8000);
  assert.equal(result.samples[0], -1);
  assert.equal(result.samples[1], 32767 / 32768);
  assert.equal(result.samples[2], 0.25);
});

test('WAV parser accepts padded metadata chunks and data before the format chunk', () => {
  const ordinary = wav();
  const fmt = new Uint8Array(ordinary.slice(20, 36));
  const buffer = wav({ chunks: [['JUNK', new Uint8Array([7, 8, 9])], ['data', pcmData()], ['fmt ', fmt]] });
  assert.equal(decodeRecording(buffer).durationSeconds, 0.5);
  assert.equal(decodeRecording(buffer).samples[0], 0.25);
});

test('WAV bounds reject invalid containers, oversized input and truncated chunks before decoding', () => {
  for (const invalid of [null, new Uint8Array(44), new ArrayBuffer(43), new ArrayBuffer(20 * 1024 * 1024 + 1)]) {
    assert.throws(() => decodeRecording(invalid), /recording/i);
  }
  const wrongType = wav(); new DataView(wrongType).setUint8(0, 0);
  assert.throws(() => decodeRecording(wrongType), /WAV/i);
  const truncated = wav(); new DataView(truncated).setUint32(40, 0xffffffff, true);
  assert.throws(() => decodeRecording(truncated), /incomplete/i);
  assert.throws(() => decodeRecording(wav({ chunks: [['JUNK', new Uint8Array(40)]] })), /compatible/i);
});

test('WAV decoding rejects unsupported PCM formats, incomplete samples and duration limits', () => {
  for (const format of [{ encoding: 3 }, { channels: 2 }, { rate: 48000 }, { bits: 8 }]) {
    assert.throws(() => decodeRecording(wav({ format })), /compatible/i);
  }
  assert.throws(() => decodeRecording(wav({ data: new Uint8Array(16001) })), /compatible/i);
  assert.throws(() => decodeRecording(wav({ length: 7999 })), /half a second/i);
  assert.throws(() => decodeRecording(wav({ length: 9600801 })), /10 minutes/i);
});

test('silent and near-silent WAV recordings are rejected without invoking a speech model', () => {
  assert.throws(() => decodeRecording(wav({ amplitude: 0 })), /silent/i);
  assert.throws(() => decodeRecording(wav({ amplitude: 1 })), /silent/i);
  assert.equal(decodeRecording(wav({ amplitude: 100 })).samples.length, 8000);
});

const moduleUrl = new URL('../public/local-speech.js', import.meta.url);
const localSource = (await readFile(moduleUrl, 'utf8'))
  .replace(/^import \{ decodeRecording \} from [^;]+;\s*/m, '')
  .replaceAll('export async function ', 'async function ')
  .replaceAll('import.meta.url', JSON.stringify(moduleUrl.href));

function harness({ failPost = false, failConstructor = false, realTransfer = false } = {}) {
  const workers = [];
  let postShouldFail = failPost;
  let constructorShouldFail = failConstructor;
  class FakeWorker {
    constructor(url, options) {
      if (constructorShouldFail) { constructorShouldFail = false; throw new Error('Cannot start'); }
      this.url = url; this.options = options; this.messages = []; this.terminated = false;
      workers.push(this);
    }
    postMessage(message, transfer) {
      if (postShouldFail) { postShouldFail = false; throw new Error('Transfer failed'); }
      this.messages.push({ message: realTransfer ? structuredClone(message, { transfer }) : message, transfer });
    }
    terminate() { this.terminated = true; }
    emit(type, value, id = this.messages.at(-1)?.message.id) {
      this.onmessage?.({ data: { id, type, ...(type === 'result' ? { result: value } : { message: value }) } });
    }
  }
  const context = vm.createContext({ decodeRecording, Worker: FakeWorker, Float32Array, URL, DOMException, console });
  vm.runInContext(`${localSource}\nglobalThis.testApi = { transcribe: transcribeLocally, chunk: transcribeChunkLocally, preload: preloadLocalSpeech };`, context);
  return { ...context.testApi, workers };
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const recording = () => new Blob([wav()], { type: 'audio/wav' });
const options = extra => ({ model: 'onnx-community/whisper-base.en', ...extra });

test('local inference transfers only PCM to a module worker and reuses the worker after success', async () => {
  const h = harness(); const progress = [];
  const first = h.transcribe(recording(), options({ onProgress: value => progress.push(value) }));
  await flush();
  const worker = h.workers[0]; const sent = worker.messages[0];
  assert.equal(worker.options.type, 'module');
  assert.match(worker.url.href, /speech-worker\.js$/);
  assert.deepEqual(Object.keys(sent.message).sort(), ['id', 'model', 'samples']);
  assert.equal(sent.message.samples.length, 8000);
  assert.equal(sent.transfer[0], sent.message.samples.buffer);
  worker.emit('progress', 'Local recognition in progress');
  worker.emit('result', { text: 'Hello from this device.' });
  assert.equal((await first).durationSeconds, 0.5);
  assert.ok(progress.includes('Local recognition in progress'));
  assert.equal(worker.onmessage, null);
  const second = h.transcribe(recording(), options()); await flush();
  assert.equal(h.workers.length, 1);
  worker.emit('result', { text: 'A second take.' });
  assert.equal((await second).text, 'A second take.');
});

test('abort terminates inference, ignores stale messages and permits a fresh worker', async () => {
  const h = harness(); const controller = new AbortController();
  const first = h.transcribe(recording(), options({ signal: controller.signal }));
  await flush();
  const old = h.workers[0]; const oldHandler = old.onmessage; const oldId = old.messages[0].message.id;
  controller.abort();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(old.terminated, true); assert.equal(old.onmessage, null);
  const second = h.transcribe(recording(), options()); await flush();
  const fresh = h.workers[1];
  oldHandler({ data: { id: oldId, type: 'error', message: 'Late failure' } });
  assert.equal(fresh.terminated, false);
  fresh.emit('result', { text: 'Fresh take.' });
  assert.equal((await second).text, 'Fresh take.');
});

test('concurrent local requests are rejected, and a signal aborted before decoding starts no worker', async () => {
  const h = harness(); const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.transcribe(recording(), options({ signal: controller.signal })), { name: 'AbortError' });
  assert.equal(h.workers.length, 0);
  const first = h.transcribe(recording(), options()); await flush();
  await assert.rejects(h.transcribe(recording(), options()), /Another recording/);
  h.workers[0].emit('result', { text: 'One operation.' }); await first;
});

test('synchronous worker transfer failure removes old abort handlers before a later operation', async () => {
  const h = harness({ failPost: true }); const oldController = new AbortController();
  await assert.rejects(h.transcribe(recording(), options({ signal: oldController.signal })), /Transfer failed/);
  assert.equal(h.workers[0].terminated, true);
  assert.equal(h.workers[0].onmessage, null);
  const next = h.transcribe(recording(), options()); await flush();
  oldController.abort();
  assert.equal(h.workers[1].terminated, false, 'an earlier failure must not leave an abort listener targeting the next worker');
  h.workers[1].emit('result', { text: 'Transfer recovered.' });
  assert.equal((await next).text, 'Transfer recovered.');
});

test('throwing progress callbacks clean up the worker instead of poisoning the next transcription', async () => {
  const h = harness(); const oldController = new AbortController();
  await assert.rejects(h.transcribe(recording(), options({ signal: oldController.signal, onProgress: () => { throw new Error('Broken progress view'); } })), /Broken progress view/);
  assert.equal(h.workers[0].terminated, true);
  const next = h.transcribe(recording(), options()); await flush();
  oldController.abort(); assert.equal(h.workers[1].terminated, false);
  h.workers[1].emit('result', { text: 'Progress recovered.' }); await next;
});

test('worker constructor and runtime failures release the local request lock', async () => {
  const h = harness({ failConstructor: true });
  await assert.rejects(h.transcribe(recording(), options()), /could not start/);
  const first = h.transcribe(recording(), options()); await flush();
  h.workers[0].onerror(); await assert.rejects(first, /stopped/);
  const second = h.transcribe(recording(), options()); await flush();
  h.workers[1].emit('result', { text: 'Worker restarted.' }); await second;
});

test('live chunks resample microphone PCM without detaching or reading later mutations of source audio', async () => {
  const h = harness({ realTransfer: true });
  const source = new Float32Array([1, 0, -1, 0.5, 0.5, 0.5]);
  const pending = h.chunk(source, options({ sampleRate: 48000 }));
  source.fill(-0.75);
  await flush();
  const worker = h.workers[0];
  const sent = worker.messages[0];
  assert.equal(sent.message.type, 'chunk');
  assert.deepEqual([...sent.message.samples], [0, 0.5]);
  assert.equal(sent.transfer[0].byteLength, 0, 'the worker-owned copy is transferred');
  assert.equal(source.byteLength, 24, 'the recording buffer remains usable');
  assert.deepEqual([...source], new Array(6).fill(-0.75));
  worker.emit('result', { text: 'Short tail.', chunks: [], device: 'wasm' });
  assert.equal((await pending).durationSeconds, 6 / 48000);
});

test('eight-second 44.1k microphone chunks produce exactly 128,000 finite 16k samples', async () => {
  const h = harness();
  const source = new Float32Array(44100 * 8).fill(0.25);
  const pending = h.chunk(source, options({ sampleRate: 44100 }));
  await flush();
  const samples = h.workers[0].messages[0].message.samples;
  assert.equal(samples.length, 128000);
  assert.ok(samples.every(sample => sample === 0.25));
  h.workers[0].emit('result', { text: 'Eight seconds.' });
  assert.equal((await pending).durationSeconds, 8);
});

test('invalid live PCM and chunk lengths fail before starting a worker and release the request lock', async () => {
  const h = harness();
  for (const [samples, sampleRate] of [[[], 16000], [new Float64Array(8), 16000], [new Float32Array(), 16000], [new Float32Array(480001), 16000], [new Float32Array([NaN]), 16000], [new Float32Array([Infinity]), 16000], [new Float32Array(8), 4000], [new Float32Array(8), 44100.5]]) {
    await assert.rejects(h.chunk(samples, options({ sampleRate })), /audio chunk|invalid samples/);
  }
  assert.equal(h.workers.length, 0);
  const pending = h.chunk(new Float32Array(8000).fill(0.2), options());
  await flush(); h.workers[0].emit('result', { text: 'Valid chunk.' });
  assert.equal((await pending).text, 'Valid chunk.');
});

test('preload, empty live chunks and full-take inference reuse one worker with no concurrent operation', async () => {
  const h = harness();
  const warm = h.preload(options()); await flush();
  const worker = h.workers[0];
  assert.equal(worker.messages[0].message.type, 'preload');
  assert.equal(worker.messages[0].message.warmup, true);
  assert.equal(Object.hasOwn(worker.messages[0].message, 'samples'), false);
  await assert.rejects(h.chunk(new Float32Array(16000), options()), /Another recording/);
  await assert.rejects(h.transcribe(recording(), options()), /Another recording/);
  worker.emit('result', { ready: true, device: 'webgpu' });
  assert.equal((await warm).ready, true);
  const chunk = h.chunk(new Float32Array(16000), options()); await flush();
  worker.emit('result', { text: '', chunks: [], device: 'webgpu' });
  assert.equal((await chunk).text, '');
  const take = h.transcribe(recording(), options()); await flush();
  worker.emit('result', { text: 'Full take.' }); await take;
  assert.equal(h.workers.length, 1);
});

test('canceling preload releases ownership synchronously for an immediate replacement chunk', async () => {
  const h = harness(); const controller = new AbortController();
  const first = h.preload(options({ signal: controller.signal }));
  const rejected = assert.rejects(first, { name: 'AbortError' });
  await flush();
  const old = h.workers[0], staleHandler = old.onmessage, staleId = old.messages[0].message.id;
  controller.abort();
  const replacement = h.chunk(new Float32Array(16000).fill(0.2), options());
  await flush();
  assert.equal(old.terminated, true);
  const fresh = h.workers[1];
  staleHandler({ data: { id: staleId, type: 'error', message: 'Late warmup error' } });
  assert.equal(fresh.terminated, false);
  fresh.emit('result', { text: 'Replacement.' });
  assert.equal((await replacement).text, 'Replacement.'); await rejected;
});

test('canceling pending blob decoding never posts its late audio into the next session', async () => {
  const h = harness(); const controller = new AbortController(); let finishRead;
  const first = h.transcribe({ arrayBuffer: () => new Promise(resolve => { finishRead = resolve; }) }, options({ signal: controller.signal }));
  const rejected = assert.rejects(first, { name: 'AbortError' });
  controller.abort();
  const replacement = h.preload(options({ warmup: false })); await flush();
  finishRead(wav()); await flush();
  assert.equal(h.workers.length, 1);
  assert.equal(h.workers[0].messages.length, 1);
  assert.equal(h.workers[0].messages[0].message.warmup, false);
  h.workers[0].emit('result', { ready: true, device: 'wasm' });
  assert.equal((await replacement).ready, true); await rejected;
});
