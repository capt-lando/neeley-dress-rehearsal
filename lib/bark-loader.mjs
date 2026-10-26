import * as ort from 'onnxruntime-web/webgpu';
import { createBarkEngine } from './bark-engine.mjs';
import { BARK_MODEL_ID, BARK_STANDARD_ID, BARK_REVISION, BARK_MODELS } from './speech-models.mjs';

const RUNTIME_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/';
const CACHE_NAME = 'dress-rehearsal-bark-v1';
const variants = {
  webgpu: { suffix: '_q4f16', graph: 1288280, weights: 452846336 },
  wasm: { suffix: '_quantized', graph: 3272834, weights: 838048256 },
};
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = RUNTIME_URL;

// The immutable revision keeps config, tokenizer and graph weights in agreement.
export async function loadBarkModel({ model = BARK_MODEL_ID, device = 'wasm', onProgress = () => {} } = {}) {
  const info = BARK_MODELS.find(entry => entry.id === model);
  if (!info) throw new Error('Choose an available Bark model.');
  const variant = variants[device];
  if (!variant) throw new Error('Unsupported Bark speech device.');
  let cache;
  try { cache = await globalThis.caches?.open(CACHE_NAME); } catch {}
  async function file(name, expectedSize, repo = model, revision = info.revision) {
    const url = `https://huggingface.co/${repo}/resolve/${revision}/${name}`;
    let saved;
    try { saved = await cache?.match(url); } catch {}
    if (saved) {
      const bytes = new Uint8Array(await saved.arrayBuffer());
      if (!expectedSize || bytes.length === expectedSize) return bytes;
      try { await cache.delete(url); } catch {}
    }
    onProgress(`Downloading Bark 3.0: ${name.split('/').at(-1)}… Your audio stays on this device.`);
    const response = await fetch(url, { credentials: 'omit' });
    if (!response.ok) throw new Error(`Bark download failed (${response.status}). Check your connection and try again.`);
    let bytes;
    if (expectedSize && response.body) {
      bytes = new Uint8Array(expectedSize);
      const reader = response.body.getReader();
      let offset = 0;
      let percent = -1;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (offset + value.length > bytes.length) throw new Error('Unexpected Bark model file size.');
          bytes.set(value, offset); offset += value.length;
          const next = Math.floor(offset / expectedSize * 100);
          if (next !== percent) { percent = next; onProgress(`Downloading Bark 3.0… ${next}% of ${name.split('/').at(-1)}.`); }
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      if (offset !== expectedSize) throw new Error('The Bark model download was incomplete. Try again.');
    } else bytes = new Uint8Array(await response.arrayBuffer());
    // Storage denial must not prevent recognition for the current session.
    try { await cache?.put(url, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } })); } catch {}
    return bytes;
  }
  const json = async name => JSON.parse(new TextDecoder().decode(await file(name, undefined, BARK_STANDARD_ID, BARK_REVISION)));
  const [config, tokenizer, preprocessor, generation] = await Promise.all(
    ['config.json', 'tokenizer.json', 'preprocessor_config.json', 'generation_config.json'].map(json),
  );
  const encoderName = `encoder_model${variant.suffix}.onnx`;
  let encoder;
  let decoder;
  let joiner;
  try {
    if (info.layout === 'separate') {
      const encoderBytes = await file('encoder.int8.onnx', info.clean ? 630748321 : 630748318);
      onProgress('Loading Bark 3.0 on this device…');
      encoder = await ort.InferenceSession.create(encoderBytes, { executionProviders: device === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'] });
      const decoderBytes = await file('decoder.onnx', 48874353);
      decoder = await ort.InferenceSession.create(decoderBytes, { executionProviders: ['wasm'] });
      const joinerBytes = await file('joiner.onnx', 23644902);
      joiner = await ort.InferenceSession.create(joinerBytes, { executionProviders: ['wasm'] });
      const tokens = new TextDecoder().decode(await file('tokens.txt', 93939));
      return createBarkEngine({ ort, encoder, decoder, joiner, config: { ...config, encoder_hidden_size: 1024 }, tokenizer: tokens,
        preprocessor: { ...preprocessor, leading_silence_seconds: info.clean ? 0 : 0.25 }, generation });
    }
    const graph = await file(`onnx/${encoderName}`, variant.graph);
    const weights = await file(`onnx/${encoderName}_data`, variant.weights);
    onProgress('Loading Bark 3.0 on this device…');
    encoder = await ort.InferenceSession.create(graph, {
      executionProviders: device === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'],
      externalData: [{ path: `${encoderName}_data`, data: weights }],
    });
    const decoderBytes = await file(`onnx/decoder_joint_model${variant.suffix}.onnx`, 69895381);
    decoder = await ort.InferenceSession.create(decoderBytes, { executionProviders: ['wasm'] });
    return createBarkEngine({ ort, encoder, decoder, config, tokenizer, preprocessor, generation });
  } catch (error) {
    await Promise.allSettled([encoder, decoder, joiner].map(session => Promise.resolve().then(() => session?.release())));
    throw error;
  }
}
