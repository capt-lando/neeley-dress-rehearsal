import { loadBarkModel } from '../lib/bark-loader.mjs';
import { BARK_SAMPLE_RATE, splitBarkWindows } from '../lib/bark-engine.mjs';
import { BARK_STANDARD_ID, isBarkModel } from '../lib/speech-models.mjs';

let recognizer;
let loadedModel;
let loadedDevice;
let warmedRecognizer;
let busy = false;
const cpuModels = new Set();

async function releaseRecognizer() {
  const previous = recognizer;
  recognizer = null;
  loadedModel = null;
  loadedDevice = null;
  warmedRecognizer = null;
  // A lost graphics device may reject release, but must not prevent CPU recovery.
  try { await previous?.release(); } catch {}
}

async function load(model, device, onProgress) {
  if (recognizer && loadedModel === model && loadedDevice === device) return recognizer;
  await releaseRecognizer();
  recognizer = await loadBarkModel({ model, device, onProgress });
  loadedModel = model;
  loadedDevice = device;
  return recognizer;
}

async function preferredDevice(model) {
  if (recognizer && loadedModel === model) return loadedDevice;
  if (!cpuModels.has(model)) {
    try {
      const adapter = await self.navigator.gpu?.requestAdapter();
      // Only Standard's q4f16 export needs half-precision shaders; Plus/Clean use int8.
      if (adapter && (model !== BARK_STANDARD_ID || adapter.features?.has('shader-f16'))) return 'webgpu';
    } catch {}
    cpuModels.add(model);
  }
  return 'wasm';
}

function isSilent(samples) {
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  // Skip only near-digital silence; this is not a voice-activity classifier.
  return Math.sqrt(energy / samples.length) < 0.0001;
}

function validateAudio(samples, type) {
  const maxSeconds = type === 'chunk' ? 30 : 600;
  if (!(samples instanceof Float32Array) || !samples.length || samples.length > maxSeconds * BARK_SAMPLE_RATE) {
    return `Use mono 16 kHz audio of up to ${maxSeconds === 600 ? '10 minutes' : '30 seconds'}.`;
  }
  for (const sample of samples) {
    if (!Number.isFinite(sample) || Math.abs(sample) > 1) return 'Audio samples must be finite values between -1 and 1.';
  }
  return '';
}

async function transcribeTake(engine, samples, progress) {
  const windows = splitBarkWindows(samples);
  const text = [];
  for (const [index, [start, end]] of windows.entries()) {
    progress(`Transcribing on this device… section ${index + 1} of ${windows.length}. You can keep listening.`);
    const window = samples.subarray(start, end);
    if (!isSilent(window)) {
      const result = await engine.transcribe(window, { onProgress: progress });
      if (typeof result.text === 'string' && result.text.trim()) text.push(result.text.trim());
    }
    progress(`Transcribed ${index + 1} of ${windows.length} sections on this device…`);
  }
  // Windows are disjoint. Deduplication would erase deliberate repetitions.
  return { text: text.join(' '), chunks: [] };
}

async function handleRequest({ id, model, samples, type = 'transcribe', warmup = true }) {
  const progress = message => self.postMessage({ id, type: 'progress', message });
  const fail = message => self.postMessage({ id, type: 'error', message });
  if (!isBarkModel(model)) { fail('Choose an available Bark speech model.'); return; }
  if (!['transcribe', 'chunk', 'preload'].includes(type)) { fail('This speech operation is not available.'); return; }
  if (type !== 'preload') {
    const invalid = validateAudio(samples, type);
    if (invalid) { fail(invalid); return; }
    if (isSilent(samples)) {
      if (type === 'chunk') self.postMessage({ id, type: 'result', result: { text: '', chunks: [], device: loadedModel === model ? loadedDevice : null } });
      else fail('No speech was detected. Check your microphone and try another take.');
      return;
    }
  }
  let device = await preferredDevice(model);
  try {
    const run = async engine => {
      if (type === 'preload') {
        if (warmup && warmedRecognizer !== engine) {
          progress('Warming Bark on this device…');
          await engine.transcribe(new Float32Array(BARK_SAMPLE_RATE), { onProgress: progress });
          warmedRecognizer = engine;
        }
        return { ready: true };
      }
      progress(`Transcribing English with Bark on this device${device === 'webgpu' ? ' with graphics acceleration' : ''}…`);
      return type === 'chunk' ? engine.transcribe(samples, { onProgress: progress }) : transcribeTake(engine, samples, progress);
    };
    let result;
    try {
      result = await run(await load(model, device, progress));
    } catch (error) {
      if (device !== 'webgpu') throw error;
      cpuModels.add(model);
      progress('Switching to the compatible Bark engine on this device…');
      device = 'wasm';
      result = await run(await load(model, device, progress));
    }
    if (type === 'preload') self.postMessage({ id, type: 'result', result: { ready: true, device } });
    else {
      const text = typeof result.text === 'string' ? result.text.trim() : '';
      if (!text && type !== 'chunk') { fail('No speech was detected. Check your microphone and try another take.'); return; }
      self.postMessage({ id, type: 'result', result: { text, chunks: text ? result.chunks || [] : [], device } });
    }
  } catch {
    await releaseRecognizer();
    fail('Bark could not transcribe on this device. Check your connection for the initial download, then try a shorter recording or reload the app.');
  }
}

self.onmessage = async ({ data }) => {
  if (busy) { self.postMessage({ id: data?.id, type: 'error', message: 'Another recording is being transcribed. Wait for it to finish.' }); return; }
  busy = true;
  try { await handleRequest(data || {}); } finally { busy = false; }
};
