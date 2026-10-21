import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { AutomaticSpeechRecognitionPipeline, PreTrainedModel, Tensor, WhisperForConditionalGeneration, WhisperTimeStampLogitsProcessor } from '@huggingface/transformers';

const workerSource = (await readFile(new URL('../public/speech-worker.js', import.meta.url), 'utf8'))
  .replace(/^import\s+\{\s*pipeline,\s*env\s*\}\s+from\s+['"]@huggingface\/transformers['"];?\s*/u, '');

function harness({ gpu = false, adapterError = false, makeEngine = () => async () => ({ text: 'Recognized speech.' }) } = {}) {
  const messages = [];
  const loads = [];
  const env = { backends: { onnx: { wasm: { numThreads: 4 } } } };
  let adapterCalls = 0;
  const context = {
    env,
    Float32Array,
    pipeline: async (task, model, options) => {
      loads.push({ task, model, options });
      const engine = makeEngine({ task, model, options, loadNumber: loads.length });
      engine.model ??= { async generate() {} };
      return engine;
    },
    self: {
      navigator: gpu || adapterError ? { gpu: { async requestAdapter() { adapterCalls++; if (adapterError) throw new Error('Adapter unavailable'); return gpu ? {} : null; } } } : {},
      postMessage(message) { messages.push(structuredClone(message)); },
    },
  };
  vm.createContext(context);
  vm.runInContext(workerSource, context);
  return {
    messages, loads, env,
    adapterCalls: () => adapterCalls,
    send: ({ id = 'recording-1', model = 'onnx-community/whisper-base.en', samples = new Float32Array(16000), ...operation } = {}) =>
      context.self.onmessage({ data: { id, model, samples, ...operation } }),
  };
}

function finalMessage(harness, id) {
  return harness.messages.filter(message => message.id === id && message.type !== 'progress').at(-1);
}

// Exercise the installed library's real windowing and merge path without loading
// model weights. Only feature extraction, model inference, and token decoding are stubbed.
function installedWhisper({ failAt = Infinity } = {}) {
  const calls = [];
  const processor = async audio => ({ input_features: { sampleCount: audio.length } });
  processor.feature_extractor = { config: { sampling_rate: 16000, chunk_length: 30, hop_length: 160 } };
  const model = {
    config: { model_type: 'whisper', max_source_positions: 1500 },
    async generate(options) {
      assert.equal(this, model, 'the wrapper must preserve the model receiver');
      calls.push(options);
      if (calls.length === failAt) throw new Error('Simulated graphics device loss');
      return [{ tolist: () => [BigInt(calls.length)] }];
    },
    async dispose() {},
  };
  const originalGenerate = model.generate;
  const tokenizer = {
    _decode_asr(chunks, options) {
      assert.equal(options.return_timestamps, true);
      assert.deepEqual(chunks.map(chunk => chunk.tokens), calls.map((_call, index) => [BigInt(index + 1)]));
      return ['Library-assembled transcript.', { chunks: [{ text: 'Original timestamped text.', timestamp: [0, 1] }] }];
    },
  };
  return {
    engine: new AutomaticSpeechRecognitionPipeline({ task: 'automatic-speech-recognition', model, processor, tokenizer }),
    model, originalGenerate, calls,
  };
}

test('unsupported or arbitrary model IDs fail before model loading or GPU probing', async () => {
  const h = harness({ gpu: true });
  for (const model of ['openai/whisper-large-v3', 'onnx-community/whisper-base', 'https://example.com/model', '__proto__']) {
    await h.send({ id: model, model });
    assert.equal(finalMessage(h, model).type, 'error');
  }
  assert.equal(h.loads.length, 0);
  assert.equal(h.adapterCalls(), 0);
});

test('English inference preserves 30-second chunking and never sends rejected language or task options', async () => {
  const seen = [];
  const h = harness({ makeEngine: ({ options }) => {
    options.progress_callback({ status: 'initiate' });
    options.progress_callback({ status: 'progress', total: 100, progress: 37 });
    return async (samples, inference) => {
      seen.push({ samples, inference });
      return { text: '  Hello, Neeley students.  ', chunks: [{ text: 'Hello, Neeley students.', timestamp: [0, 3] }] };
    };
  } });
  const samples = new Float32Array(16000 * 61);
  await h.send({ id: 'english', samples });
  assert.equal(seen[0].samples, samples);
  assert.equal(seen[0].inference.chunk_length_s, 30);
  assert.equal(seen[0].inference.stride_length_s, 5);
  assert.equal(seen[0].inference.return_timestamps, true);
  assert.equal(seen[0].inference.max_new_tokens, 447);
  assert.equal(Object.hasOwn(seen[0].inference, 'language'), false);
  assert.equal(Object.hasOwn(seen[0].inference, 'task'), false);
  assert.equal(finalMessage(h, 'english').result.text, 'Hello, Neeley students.');
  assert.deepEqual(finalMessage(h, 'english').result.chunks[0].timestamp, [0, 3]);
  assert.ok(h.messages.some(message => message.type === 'progress'));
  assert.ok(h.messages.every(message => message.id === 'english'));
  assert.equal(h.env.backends.onnx.wasm.numThreads, 1, 'Pages without cross-origin isolation must not require shared-memory WASM');
});

test('installed Whisper bounds zero-boundary output once per window while retaining timestamp processing and merge', async t => {
  // Shared Base.en/Small.en decoder settings, verified against their model configs.
  const model = Object.assign(Object.create(WhisperForConditionalGeneration.prototype), {
    config: { model_type: 'whisper', max_source_positions: 1500, max_target_positions: 448, max_length: 448, decoder_start_token_id: 50257, eos_token_id: 50256 },
    configs: { generation_config: { is_multilingual: false, no_timestamps_token_id: 50362, max_length: 448, begin_suppress_tokens: [220, 50256] } },
  });
  const originalGenerate = model.generate;
  const calls = [];
  const zeroBoundary = [50257n, 50363n, 10n, 50363n, 50363n, 50256n];
  t.mock.method(PreTrainedModel.prototype, 'generate', async function (options) {
    assert.equal(this, model);
    calls.push(options);
    // Without the explicit bound, installed Whisper repeatedly seeks to zero.
    // Keep the regression finite even if that upstream path is reintroduced.
    if (calls.length > 3) throw new Error('Repeated timestamp seek detected');
    return new Tensor('int64', zeroBoundary, [1, zeroBoundary.length]);
  });
  const processor = async () => ({ input_features: new Tensor('float32', new Float32Array(80 * 3000), [1, 80, 3000]) });
  processor.feature_extractor = { config: { sampling_rate: 16000, chunk_length: 30, hop_length: 160 } };
  const tokenizer = {
    _decode_asr(chunks, options) {
      assert.equal(options.return_timestamps, true);
      assert.deepEqual(chunks.map(chunk => chunk.tokens), [zeroBoundary, zeroBoundary, zeroBoundary]);
      assert.deepEqual(chunks.map(chunk => chunk.stride), [[30, 0, 5], [30, 5, 5], [21, 5, 0]]);
      return ['Merged bounded windows.', { chunks: [{ text: 'Merged bounded windows.', timestamp: [0, 61] }] }];
    },
  };
  const engine = new AutomaticSpeechRecognitionPipeline({ task: 'automatic-speech-recognition', model, processor, tokenizer });
  const h = harness({ makeEngine: () => engine });
  await h.send({ id: 'bounded', samples: new Float32Array(61 * 16000) });
  assert.equal(finalMessage(h, 'bounded').type, 'result');
  assert.equal(finalMessage(h, 'bounded').result.text, 'Merged bounded windows.');
  assert.deepEqual(finalMessage(h, 'bounded').result.chunks[0].timestamp, [0, 61]);
  assert.equal(calls.length, 3, 'each actual pipeline window must invoke only one decoder pass');
  assert.equal(model.generate, originalGenerate);
  assert.equal(h.messages.filter(message => /^Transcribed \d+ of 3 sections/.test(message.message)).length, 3);
  for (const options of calls) {
    assert.deepEqual(options.decoder_input_ids, [50257]);
    assert.equal(options.max_new_tokens, 447);
    assert.equal(options.generation_config.return_timestamps, true);
    const timestampProcessor = [...options.logits_processor].find(item => item instanceof WhisperTimeStampLogitsProcessor);
    assert.ok(timestampProcessor, 'the normal timestamp processor must remain active');
    const prefix = [50257n];
    for (const token of zeroBoundary.slice(1)) {
      const scores = new Float32Array(51864).fill(-100);
      scores[Number(token)] = 100;
      const logits = new Tensor('float32', scores, [1, scores.length]);
      timestampProcessor([prefix], logits);
      assert.ok(Number.isFinite(logits.data[Number(token)]), 'the reproducing sequence is permitted by the real timestamp processor');
      assert.equal(logits.data[50362], -Infinity, 'no-timestamps remains suppressed');
      prefix.push(token);
    }
    const maxLength = options.decoder_input_ids.length + options.generation_config.max_new_tokens;
    assert.equal(maxLength, model.config.max_target_positions);
    const criteria = model._get_stopping_criteria({ ...options.generation_config, max_length: maxLength });
    assert.deepEqual(criteria([new Array(447).fill(10n)], []), [false]);
    assert.deepEqual(criteria([new Array(448).fill(10n)], []), [true]);
  }
});

test('progress counts actual installed Whisper windows at overlap boundaries and restores model generation', async () => {
  for (const [seconds, expected] of [[0.5, 1], [30, 1], [30.0000625, 2], [50, 2], [50.0000625, 3], [61, 3], [120, 6], [599, 30], [600, 30]]) {
    const real = installedWhisper();
    const h = harness({ makeEngine: () => real.engine });
    await h.send({ id: 'windows', samples: new Float32Array(Math.round(seconds * 16000)) });
    assert.equal(finalMessage(h, 'windows').type, 'result', `${seconds}s must retain the library result`);
    assert.equal(real.calls.length, expected, `${seconds}s actual library window count`);
    const completed = h.messages.filter(message => /^Transcribed \d+ of \d+ sections/.test(message.message));
    assert.equal(completed.length, expected);
    assert.deepEqual(completed.map(message => message.message), Array.from({ length: expected }, (_, index) => `Transcribed ${index + 1} of ${expected} sections on this device…`));
    assert.ok(h.messages.some(message => message.message === `Transcribing on this device… section 1 of ${expected}. You can keep listening.`));
    assert.equal(real.model.generate, real.originalGenerate);
    assert.equal(finalMessage(h, 'windows').result.text, 'Library-assembled transcript.');
    assert.deepEqual(finalMessage(h, 'windows').result.chunks, [{ text: 'Original timestamped text.', timestamp: [0, 1] }]);
    assert.ok(real.calls.every(call => !Object.hasOwn(call, 'chunk_callback') && !Object.hasOwn(call, 'streamer')));
  }
});

test('partial GPU failure restores generation and restarts actual window progress for the CPU retry', async () => {
  const gpu = installedWhisper({ failAt: 2 }), cpu = installedWhisper();
  const h = harness({ gpu: true, makeEngine: ({ options }) => options.device === 'webgpu' ? gpu.engine : cpu.engine });
  await h.send({ id: 'retry', samples: new Float32Array(61 * 16000) });
  assert.equal(gpu.calls.length, 2);
  assert.equal(cpu.calls.length, 3);
  assert.equal(gpu.model.generate, gpu.originalGenerate);
  assert.equal(cpu.model.generate, cpu.originalGenerate);
  const completed = h.messages.filter(message => /^Transcribed \d+ of \d+ sections/.test(message.message)).map(message => message.message);
  assert.deepEqual(completed, [
    'Transcribed 1 of 3 sections on this device…',
    'Transcribed 1 of 3 sections on this device…',
    'Transcribed 2 of 3 sections on this device…',
    'Transcribed 3 of 3 sections on this device…',
  ]);
  assert.equal(finalMessage(h, 'retry').result.device, 'wasm');
});

test('failed outer windows are not counted and the cached generation method is restored', async () => {
  const real = installedWhisper({ failAt: 1 });
  const h = harness({ makeEngine: () => real.engine });
  await h.send({ id: 'failed-window', samples: new Float32Array(61 * 16000) });
  assert.equal(finalMessage(h, 'failed-window').type, 'error');
  assert.equal(real.model.generate, real.originalGenerate);
  assert.equal(h.messages.some(message => /^Transcribed \d+/.test(message.message)), false);
});

test('GPU adapter errors use portable WASM without failing transcription', async () => {
  const h = harness({ adapterError: true });
  await h.send({ id: 'no-adapter' });
  assert.deepEqual(h.loads.map(load => load.options.device), ['wasm']);
  assert.equal(finalMessage(h, 'no-adapter').result.device, 'wasm');
});

test('a GPU model load failure retries the same English model with WASM', async () => {
  const h = harness({ gpu: true, makeEngine: ({ options }) => {
    if (options.device === 'webgpu') throw new Error('GPU model initialization failed');
    return async () => ({ text: 'Recovered on the compatible engine.' });
  } });
  await h.send({ id: 'load-fallback' });
  assert.deepEqual(h.loads.map(load => load.options.device), ['webgpu', 'wasm']);
  assert.ok(h.loads.every(load => load.model === 'onnx-community/whisper-base.en'));
  assert.equal(finalMessage(h, 'load-fallback').result.device, 'wasm');
});

test('a GPU inference failure releases its recognizer before retrying the same samples on WASM', async () => {
  const lifecycle = [];
  const samples = new Float32Array(16000);
  const h = harness({ gpu: true, makeEngine: ({ options }) => {
    lifecycle.push(`load:${options.device}`);
    const engine = async actual => {
      assert.equal(actual, samples);
      lifecycle.push(`run:${options.device}`);
      if (options.device === 'webgpu') throw new Error('GPU execution failed');
      return { text: 'Recovered speech.' };
    };
    engine.dispose = async () => { lifecycle.push(`dispose:${options.device}`); };
    return engine;
  } });
  await h.send({ id: 'inference-fallback', samples });
  assert.deepEqual(lifecycle, ['load:webgpu', 'run:webgpu', 'dispose:webgpu', 'load:wasm', 'run:wasm']);
  assert.equal(finalMessage(h, 'inference-fallback').result.text, 'Recovered speech.');
});

test('a failed cleanup cannot prevent fallback from a broken GPU recognizer', async () => {
  const h = harness({ gpu: true, makeEngine: ({ options }) => {
    const engine = async () => {
      if (options.device === 'webgpu') throw new Error('GPU device was lost');
      return { text: 'Recovered despite cleanup failure.' };
    };
    engine.dispose = async () => { if (options.device === 'webgpu') throw new Error('GPU teardown failed'); };
    return engine;
  } });
  await h.send({ id: 'cleanup-fallback' });
  assert.deepEqual(h.loads.map(load => load.options.device), ['webgpu', 'wasm']);
  assert.equal(finalMessage(h, 'cleanup-fallback').type, 'result');
  assert.equal(finalMessage(h, 'cleanup-fallback').result.device, 'wasm');
});

test('same-model requests reuse the recognizer while a model change releases the old one', async () => {
  const disposed = [];
  const h = harness({ makeEngine: ({ model }) => {
    const engine = async () => ({ text: `Speech from ${model}.` });
    engine.dispose = async () => { disposed.push(model); };
    return engine;
  } });
  await h.send({ id: 'first' });
  await h.send({ id: 'cached' });
  assert.equal(h.loads.length, 1);
  assert.equal(disposed.length, 0);
  await h.send({ id: 'changed', model: 'onnx-community/whisper-small.en' });
  assert.equal(h.loads.length, 2);
  assert.deepEqual(disposed, ['onnx-community/whisper-base.en']);
  for (const id of ['first', 'cached', 'changed']) {
    assert.equal(finalMessage(h, id).type, 'result');
    assert.equal(h.messages.filter(message => message.id === id && message.type === 'result').length, 1);
    assert.ok(h.messages.some(message => message.id === id && message.type === 'progress'));
  }
});

test('compatible-engine failures or empty recognition return one sanitized error and no result', async () => {
  for (const engine of [async () => { throw new Error('SECRET diagnostic including private path'); }, async () => ({ text: '   ' })]) {
    const h = harness({ makeEngine: () => engine });
    await h.send({ id: 'failed' });
    assert.equal(h.loads.length, 1, 'WASM failure must not create an endless retry loop');
    assert.equal(h.messages.filter(message => message.type === 'error').length, 1);
    assert.equal(h.messages.some(message => message.type === 'result'), false);
    assert.ok(!JSON.stringify(h.messages).includes('SECRET'));
    assert.equal(finalMessage(h, 'failed').id, 'failed');
  }
});

test('preloading warms real installed Whisper generation once and reuses that model for live chunks', async t => {
  const model = Object.assign(Object.create(WhisperForConditionalGeneration.prototype), {
    config: { model_type: 'whisper', max_source_positions: 1500, max_target_positions: 448, max_length: 448, decoder_start_token_id: 50257, eos_token_id: 50256 },
    configs: { generation_config: { is_multilingual: false, no_timestamps_token_id: 50362, max_length: 448 } },
  });
  const calls = [];
  t.mock.method(PreTrainedModel.prototype, 'generate', async function (options) {
    calls.push(options);
    const tokens = [...options.decoder_input_ids.map(BigInt), 10n, 50256n];
    return new Tensor('int64', tokens, [1, tokens.length]);
  });
  const processor = async () => ({ input_features: new Tensor('float32', new Float32Array(80 * 3000), [1, 80, 3000]) });
  processor.feature_extractor = { config: { sampling_rate: 16000, chunk_length: 30, hop_length: 160 } };
  const tokenizer = { _decode_asr: () => ['Synthetic test output.', {}] };
  const engine = new AutomaticSpeechRecognitionPipeline({ task: 'automatic-speech-recognition', model, processor, tokenizer });
  const h = harness({ makeEngine: () => engine });
  await h.send({ id: 'warm', type: 'preload' });
  assert.deepEqual(finalMessage(h, 'warm').result, { ready: true, device: 'wasm' });
  assert.equal(Object.hasOwn(finalMessage(h, 'warm').result, 'text'), false, 'warmup output must never become user speech');
  assert.equal(calls[0].max_new_tokens, 1);
  assert.equal(calls[0].generation_config.return_timestamps, false);
  assert.deepEqual(calls[0].decoder_input_ids, [50257, 50362]);
  await h.send({ id: 'warm-again', type: 'preload' });
  assert.equal(calls.length, 1, 'a warmed recognizer is not warmed on every chunk');
  await h.send({ id: 'live', type: 'chunk', samples: new Float32Array(16000 * 8).fill(0.1) });
  assert.equal(h.loads.length, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].max_new_tokens, 160);
  assert.equal(calls[1].generation_config.return_timestamps, false);
  assert.deepEqual(calls[1].decoder_input_ids, [50257, 50362]);
  assert.equal([...(calls[1].logits_processor || [])].some(item => item instanceof WhisperTimeStampLogitsProcessor), false);
  assert.equal(Object.hasOwn(calls[1], 'chunk_length_s'), false);
  assert.equal(finalMessage(h, 'live').type, 'result');
  await h.send({ id: 'long-live', type: 'chunk', samples: new Float32Array(16000 * 30).fill(0.1) });
  const longest = calls[2];
  assert.equal(longest.max_new_tokens, 446);
  const maxLength = longest.decoder_input_ids.length + longest.generation_config.max_new_tokens;
  assert.equal(maxLength, model.config.max_target_positions);
  const stopping = model._get_stopping_criteria({ ...longest.generation_config, max_length: maxLength });
  assert.deepEqual(stopping([new Array(447).fill(10n)], []), [false]);
  assert.deepEqual(stopping([new Array(448).fill(10n)], []), [true]);
});

test('live chunks use one timestamp-free pass with a duration allowance and retain full-take behavior afterward', async () => {
  const seen = [];
  const h = harness({ makeEngine: () => async (samples, inference) => {
    seen.push({ length: samples.length, inference });
    return { text: 'Speech without timing.' };
  } });
  for (const [duration, cap] of [[0.5, 64], [2, 64], [2.0000625, 65], [8, 160], [9, 176], [30, 446]]) {
    await h.send({ id: 'live', type: 'chunk', samples: new Float32Array(Math.round(duration * 16000)).fill(0.1) });
    assert.equal(finalMessage(h, 'live').type, 'result');
    assert.deepEqual(JSON.parse(JSON.stringify(seen.at(-1).inference)), { return_timestamps: false, max_new_tokens: cap });
    assert.deepEqual(finalMessage(h, 'live').result.chunks, []);
  }
  await h.send({ id: 'full', samples: new Float32Array(16000 * 8).fill(0.1) });
  assert.deepEqual(JSON.parse(JSON.stringify(seen.at(-1).inference)), { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true, max_new_tokens: 447 });
  assert.equal(h.loads.length, 1, 'the live and full-take paths reuse the same loaded model');
});

test('digital silence skips model loading, while no recognized words are allowed only for live chunks', async () => {
  const h = harness({ makeEngine: () => async () => ({ text: ' ', chunks: [{ text: 'Unusable', timestamp: [0, 1] }] }) });
  await h.send({ id: 'silence', type: 'chunk', samples: new Float32Array(8 * 16000) });
  assert.deepEqual(finalMessage(h, 'silence').result, { text: '', chunks: [], device: null });
  assert.equal(h.loads.length, 0);
  await h.send({ id: 'empty-live', type: 'chunk', samples: new Float32Array(8 * 16000).fill(0.1) });
  assert.deepEqual(finalMessage(h, 'empty-live').result, { text: '', chunks: [], device: 'wasm' });
  await h.send({ id: 'empty-take', samples: new Float32Array(8 * 16000).fill(0.1) });
  assert.equal(finalMessage(h, 'empty-take').type, 'error');
});

test('overlapping worker commands are rejected without loading or generating a second model', async () => {
  let finishInference;
  const h = harness({ makeEngine: () => () => new Promise(resolve => { finishInference = resolve; }) });
  const active = h.send({ id: 'active', type: 'chunk', samples: new Float32Array(16000).fill(0.1) });
  await new Promise(resolve => setImmediate(resolve));
  await h.send({ id: 'overlap', type: 'preload' });
  assert.equal(finalMessage(h, 'overlap').type, 'error');
  assert.match(finalMessage(h, 'overlap').message, /Another recording/);
  assert.equal(h.loads.length, 1);
  finishInference({ text: 'Only active generation.' }); await active;
  assert.equal(finalMessage(h, 'active').type, 'result');
  await h.send({ id: 'later', type: 'preload', warmup: false });
  assert.equal(finalMessage(h, 'later').result.ready, true);
  assert.equal(h.loads.length, 1);
});

test('warmup GPU failure retries once on WASM and remembers the compatible engine for live inference', async () => {
  const calls = [];
  const h = harness({ gpu: true, makeEngine: ({ options }) => async (_samples, inference) => {
    calls.push({ device: options.device, tokens: inference.max_new_tokens });
    if (options.device === 'webgpu') throw new Error('GPU warmup failed');
    return { text: 'Warmed speech.' };
  } });
  await h.send({ id: 'warm', type: 'preload' });
  assert.equal(finalMessage(h, 'warm').result.device, 'wasm');
  await h.send({ id: 'live', type: 'chunk', samples: new Float32Array(16000).fill(0.1) });
  assert.equal(finalMessage(h, 'live').result.device, 'wasm');
  assert.deepEqual(calls, [{ device: 'webgpu', tokens: 1 }, { device: 'wasm', tokens: 1 }, { device: 'wasm', tokens: 64 }]);
  assert.equal(h.loads.length, 2);
});

test('malformed PCM and unknown commands are rejected before model or GPU access', async () => {
  const h = harness({ gpu: true });
  for (const samples of [[], new Float32Array(), new Float32Array(480001), new Float32Array([NaN]), new Float32Array([Infinity])]) {
    await h.send({ id: 'invalid', type: 'chunk', samples });
    assert.equal(finalMessage(h, 'invalid').type, 'error');
  }
  await h.send({ id: 'command', type: 'arbitrary' });
  assert.equal(finalMessage(h, 'command').type, 'error');
  assert.equal(h.loads.length, 0); assert.equal(h.adapterCalls(), 0);
});
