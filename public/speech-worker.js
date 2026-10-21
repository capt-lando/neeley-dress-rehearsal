import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;
env.useBrowserCache = true;
// GitHub Pages cannot supply cross-origin isolation headers. One WASM thread is portable.
env.backends.onnx.wasm.numThreads = 1;

let recognizer;
let loadedModel;
let loadedDevice;
let warmedRecognizer;
let busy = false;
const cpuModels = new Set();
const allowed = new Set(['onnx-community/whisper-base.en', 'onnx-community/whisper-small.en']);
async function load(model, device, progress) {
  if (recognizer && loadedModel === model && loadedDevice === device) return recognizer;
  const previous = recognizer;
  recognizer = null;
  loadedModel = null;
  loadedDevice = null;
  warmedRecognizer = null;
  // A lost graphics device can also reject disposal. Still allow a CPU retry.
  try { await previous?.dispose(); } catch {}
  recognizer = await pipeline('automatic-speech-recognition', model, {
    device, dtype: 'q8',
    progress_callback: event => {
      if (event.status === 'progress' && event.total) progress(`Downloading English speech model… ${Math.floor(event.progress)}% of the current file. Your recording stays on this device.`);
      else if (event.status === 'initiate') progress('Loading English speech model. The first download can take a moment…');
    },
  });
  loadedModel = model;
  loadedDevice = device;
  return recognizer;
}

async function transcribe(engine, samples, progress) {
  const model = engine.model;
  const generate = model.generate;
  const total = Math.max(1, Math.ceil((samples.length - 30 * 16000) / (20 * 16000)) + 1);
  let completed = 0;
  // The pipeline calls model.generate once per overlapping window. Streamer.end
  // can fire several times inside that window during Whisper's timestamp seek loop.
  model.generate = async function (...args) {
    progress(`Transcribing on this device… section ${completed + 1} of ${total}. You can keep listening.`);
    const result = await generate.apply(this, args);
    completed++;
    progress(`Transcribed ${completed} of ${total} sections on this device…`);
    return result;
  };
  try {
    // Keep the library's chunking, overlap removal, timestamps, and final text assembly.
    // Both English models have 448 decoder positions minus one prefix token.
    // An explicit bound also avoids 4.3.1's non-advancing timestamp seek loop.
    return await engine(samples, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true, max_new_tokens: 447 });
  } finally { model.generate = generate; }
}

async function handleRequest({ id, model, samples, type = 'transcribe', warmup = true }) {
  const progress = message => self.postMessage({ id, type: 'progress', message });
  if (!allowed.has(model)) { self.postMessage({ id, type: 'error', message: 'Choose an available English speech model.' }); return; }
  if (!['transcribe', 'chunk', 'preload'].includes(type)) { self.postMessage({ id, type: 'error', message: 'This speech operation is not available.' }); return; }
  if (type === 'chunk') {
    if (!(samples instanceof Float32Array) || !samples.length || samples.length > 30 * 16000) {
      self.postMessage({ id, type: 'error', message: 'Use an audio chunk of up to 30 seconds.' }); return;
    }
    let energy = 0;
    for (const sample of samples) {
      if (!Number.isFinite(sample)) { self.postMessage({ id, type: 'error', message: 'This audio chunk contains invalid samples.' }); return; }
      energy += sample * sample;
    }
    // Skip only near-digital silence; this is not a voice-activity classifier.
    if (Math.sqrt(energy / samples.length) < 0.0001) {
      self.postMessage({ id, type: 'result', result: { text: '', chunks: [], device: loadedModel === model ? loadedDevice : null } }); return;
    }
  }
  let device = 'wasm';
  try { if (!cpuModels.has(model) && self.navigator.gpu && await self.navigator.gpu.requestAdapter()) device = 'webgpu'; } catch {}
  try {
    const run = async engine => {
      if (type === 'preload') {
        if (warmup && warmedRecognizer !== engine) {
          progress('Warming the local speech model…');
          // One real decoder token warms inference; synthetic output is discarded.
          await engine(new Float32Array(16000), { return_timestamps: false, max_new_tokens: 1 });
          warmedRecognizer = engine;
        }
        return { ready: true };
      }
      progress(`Transcribing English on this device${device === 'webgpu' ? ' with graphics acceleration' : ''}…`);
      if (type === 'chunk') {
        // Live drafts need text only. Allow ample speech tokens plus a margin,
        // while bounding run-on decoding; two of 448 decoder positions hold prefix tokens.
        const maxTokens = Math.min(446, Math.max(64, Math.ceil(samples.length / 16000 * 16) + 32));
        return engine(samples, { return_timestamps: false, max_new_tokens: maxTokens });
      }
      return transcribe(engine, samples, progress);
    };
    let result;
    try {
      const engine = await load(model, device, progress);
      result = await run(engine);
    } catch (error) {
      if (device !== 'webgpu') throw error;
      cpuModels.add(model);
      progress('Switching to the compatible speech engine on this device…');
      const engine = await load(model, 'wasm', progress);
      device = 'wasm';
      result = await run(engine);
    }
    if (type === 'preload') self.postMessage({ id, type: 'result', result: { ready: true, device } });
    else {
      const text = result.text?.trim() || '';
      if (!text && type !== 'chunk') throw new Error('No words were detected.');
      self.postMessage({ id, type: 'result', result: { text, chunks: text ? result.chunks || [] : [], device } });
    }
  } catch {
    self.postMessage({ id, type: 'error', message: 'Could not transcribe on this device. Check your internet for the initial model download, then try a shorter recording or the smaller English model.' });
  }
}

self.onmessage = async ({ data }) => {
  if (busy) { self.postMessage({ id: data.id, type: 'error', message: 'Another recording is being transcribed. Wait for it to finish.' }); return; }
  busy = true;
  try { await handleRequest(data); } finally { busy = false; }
};
