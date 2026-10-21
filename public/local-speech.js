import { decodeRecording } from '../lib/wav.mjs';

let worker;
let pending;
let nextId = 0;
function stopWorker() { worker?.terminate(); worker = null; }

// One operation owns the reusable worker. Release ownership during abort itself,
// so a replacement recording can start before the old promise's catch runs.
async function requestLocal(prepare, { model, signal, onProgress = () => {} } = {}) {
  signal?.throwIfAborted();
  if (pending) throw new Error('Another recording is being transcribed. Wait for it to finish.');
  const active = {};
  pending = active;
  return new Promise((resolve, reject) => {
    let done = false;
    let jobWorker;
    const cleanup = () => {
      signal?.removeEventListener('abort', abort);
      if (jobWorker) { jobWorker.onmessage = null; jobWorker.onerror = null; }
      if (pending === active) pending = null;
    };
    const finish = (error, value) => { if (done) return; done = true; cleanup(); if (error) reject(error); else resolve(value); };
    const fail = error => {
      if (done) return;
      if (jobWorker) { if (worker === jobWorker) stopWorker(); else jobWorker.terminate(); }
      finish(error);
    };
    const abort = () => fail(new DOMException('Transcription stopped.', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try {
      // Prepare PCM synchronously when available; blob reading may finish after cancellation.
      Promise.resolve(prepare()).then(({ payload, durationSeconds }) => {
        if (done) return;
        const id = ++nextId;
        try { worker ||= new Worker(new URL('./speech-worker.js', import.meta.url), { type: 'module' }); jobWorker = worker; }
        catch { finish(new Error('Local speech recognition could not start. Try the latest Chrome or Edge.')); return; }
        jobWorker.onmessage = ({ data }) => {
          if (done || data.id !== id) return;
          if (data.type === 'progress') {
            try { onProgress(data.message); } catch (error) { fail(error); }
          }
          if (data.type === 'result') finish(null, { ...data.result, ...(durationSeconds === undefined ? {} : { durationSeconds }), model });
          if (data.type === 'error') fail(new Error(data.message));
        };
        jobWorker.onerror = () => fail(new Error('Local speech recognition stopped. Try the smaller speech model or a shorter recording.'));
        try {
          onProgress(payload.type === 'preload' ? 'Preparing the local speech model…' : 'Preparing English speech recognition on this device…');
          if (!done) jobWorker.postMessage({ id, model, ...payload }, payload.samples ? [payload.samples.buffer] : []);
        } catch (error) { fail(error); }
      }, fail);
    } catch (error) { fail(error); }
  });
}

// A worker keeps recorder, playback and cancel controls responsive during inference.
export async function transcribeLocally(blob, options = {}) {
  return requestLocal(async () => {
    const { samples, durationSeconds } = decodeRecording(await blob.arrayBuffer());
    return { payload: { samples }, durationSeconds };
  }, options);
}

// Copy source audio, then use the same averaged resampling as the saved WAV path.
// The caller's recording buffer is never transferred or detached.
export async function transcribeChunkLocally(source, { sampleRate = 16000, ...options } = {}) {
  return requestLocal(() => {
    if (!(source instanceof Float32Array) || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || !source.length || source.length > sampleRate * 30) {
      throw new Error('Use a mono audio chunk of up to 30 seconds at a supported sample rate.');
    }
    const input = source.slice();
    for (const sample of input) if (!Number.isFinite(sample)) throw new Error('This audio chunk contains invalid samples.');
    const ratio = sampleRate / 16000;
    const samples = new Float32Array(Math.max(1, Math.round(input.length / ratio)));
    for (let i = 0; i < samples.length; i++) {
      const start = Math.min(input.length - 1, Math.floor(i * ratio));
      const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
      let total = 0;
      for (let j = start; j < end; j++) total += input[j];
      samples[i] = Math.max(-1, Math.min(1, total / (end - start)));
    }
    return { payload: { type: 'chunk', samples }, durationSeconds: input.length / sampleRate };
  }, options);
}

export async function preloadLocalSpeech({ warmup = true, ...options } = {}) {
  return requestLocal(() => ({ payload: { type: 'preload', warmup: warmup !== false } }), options);
}
