import test from 'node:test';
import assert from 'node:assert/strict';
import { createBarkEngine, splitBarkWindows, BARK_SAMPLE_RATE, BARK_MAX_WINDOW_SECONDS } from '../lib/bark-engine.mjs';

const blank = 8192;
const config = { blank_token_id: blank, vocab_size: 8193, durations: [0, 1, 2, 3, 4], decoder_hidden_size: 2, num_decoder_layers: 1, max_symbols_per_step: 10 };
const preprocessor = {
  sampling_rate: 16000, feature_size: 128, leading_silence_seconds: 0.25,
  n_fft: 512, hop_length: 160, win_length: 400, preemphasis: 0.97,
};
const tokenizer = { model: { vocab: { '<pad>': 2, '</s>': 3, '\u2581I': 4, '\u2581um': 5, '\u2581agree': 6, '.': 7 } }, added_tokens: [{ id: 3, content: '</s>', special: true }] };
const audio = seconds => new Float32Array(Math.round(BARK_SAMPLE_RATE * seconds)).fill(0.125);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

function harness({ frames = 5, length = frames, sequence = [{ token: 4, duration: 0 }, { token: 6, duration: 1 }, { token: 3, duration: 0 }], encoderRun, decoderRun, joinerRun, realFeatures = false, stateConfig = {}, generation = { eos_token_id: 3 }, separateGraphs = false, leadingSilence = 0.25, tokenizerOverride } = {}) {
  const tensors = [];
  const calls = [];
  const settings = { ...config, ...(separateGraphs ? { encoder_hidden_size: 3 } : {}), ...stateConfig };
  const releases = { encoder: 0, decoder: 0, ...(separateGraphs ? { joiner: 0 } : {}) };
  let featureInput;
  class Tensor {
    constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; this.disposals = 0; tensors.push(this); }
    dispose() { this.disposals++; }
  }
  const make = (type, data, dims) => new Tensor(type, data, dims);
  const logits = (size, best) => { const data = new Float32Array(size).fill(-50); data[best] = 10; return make('float32', data, [1, size]); };
  const hidden = value => make('float32', new Float32Array(settings.num_decoder_layers * settings.decoder_hidden_size).fill(value), [settings.num_decoder_layers, 1, settings.decoder_hidden_size]);
  const encoder = {
    async run(feeds) {
      if (encoderRun) return encoderRun(feeds, make);
      if (separateGraphs) {
        assert.deepEqual(feeds.audio_signal.dims, [1, 128, 2]);
        assert.deepEqual([...feeds.length.data], [2n]);
        const data = Float32Array.from({ length: frames * settings.encoder_hidden_size }, (_, index) => index % frames + Math.floor(index / frames) * 100);
        return { outputs: make('float32', data, [1, settings.encoder_hidden_size, frames]), encoded_lengths: make('int64', BigInt64Array.of(BigInt(length)), [1]) };
      }
      assert.equal(feeds.input_features.type, 'float32');
      assert.deepEqual(feeds.input_features.dims.slice(0, 1), [1]);
      assert.equal(feeds.input_features.dims[2], 128);
      assert.equal(feeds.attention_mask.type, 'int64');
      const data = Float32Array.from({ length: frames * settings.decoder_hidden_size }, (_, index) => Math.floor(index / settings.decoder_hidden_size));
      return { encoder_outputs: make('float32', data, [1, frames, settings.decoder_hidden_size]), encoder_lengths: make('int64', BigInt64Array.of(BigInt(length)), [1]) };
    },
    async release() { releases.encoder++; },
  };
  const decoder = {
    async run(feeds) {
      if (separateGraphs) {
        assert.equal(feeds.targets.type, 'int32');
        assert.equal(feeds.target_length.type, 'int32');
        assert.deepEqual([...feeds.target_length.data], [1]);
        calls.push({ last: Number(feeds.targets.data[0]), h: feeds['states.1'], c: feeds['states.2'], hValue: feeds['states.1'].data[0], cValue: feeds['states.2'].data[0] });
        if (decoderRun) return decoderRun(feeds, { calls, make, logits, hidden });
        const result = { outputs: make('float32', new Float32Array(settings.decoder_hidden_size).fill(calls.length), [1, settings.decoder_hidden_size, 1]), prednet_lengths: make('int32', Int32Array.of(1), [1]), states: hidden(calls.length), 'states.2_out': hidden(calls.length + 100) };
        calls.at(-1).out = result;
        return result;
      }
      calls.push({ last: Number(feeds.input_ids.data[0]), frame: feeds.encoder_outputs.data[0], h: feeds.state_h, c: feeds.state_c,
        hValue: feeds.state_h.data[0], cValue: feeds.state_c.data[0] });
      if (decoderRun) return decoderRun(feeds, { calls, make, logits, hidden });
      const step = sequence[calls.length - 1] || sequence.at(-1);
      const result = { token_logits: logits(8193, step.token), duration_logits: logits(5, step.duration), state_h_out: hidden(calls.length), state_c_out: hidden(calls.length + 100) };
      calls.at(-1).out = result;
      return result;
    },
    async release() { releases.decoder++; },
  };
  const joiner = separateGraphs ? {
    async run(feeds) {
      assert.deepEqual(feeds.encoder_outputs.dims, [1, settings.encoder_hidden_size, 1]);
      assert.deepEqual(feeds.decoder_outputs.dims, [1, settings.decoder_hidden_size, 1]);
      calls.at(-1).frame = feeds.encoder_outputs.data[0];
      calls.at(-1).encoderFrame = [...feeds.encoder_outputs.data];
      if (joinerRun) return joinerRun(feeds, { calls, make, logits, hidden });
      const step = sequence[calls.length - 1] || sequence.at(-1);
      const data = new Float32Array(8198).fill(-50);
      data[step.token] = 10; data[8193 + step.duration] = 10;
      return { outputs: make('float32', data, [1, 1, 1, 8198]) };
    },
    async release() { releases.joiner++; },
  } : undefined;
  const featureExtractor = realFeatures ? undefined : async samples => {
    featureInput = samples;
    return { input_features: make('float32', new Float32Array(2 * 128), [1, 2, 128]), attention_mask: make('int64', BigInt64Array.of(1n, 1n), [1, 2]) };
  };
  const tokensText = '<pad> 2\n</s> 3\n\u2581I 4\n\u2581um 5\n\u2581agree 6\n. 7\n<blk> 8192\n';
  const engine = createBarkEngine({ ort: { Tensor }, encoder, decoder, joiner, config: settings, tokenizer: tokenizerOverride ?? (separateGraphs ? tokensText : tokenizer), preprocessor: { ...preprocessor, leading_silence_seconds: leadingSilence }, generation, featureExtractor });
  return { engine, tensors, calls, releases, encoder, decoder, joiner, get featureInput() { return featureInput; }, assertDisposed() { assert.ok(tensors.length > 0); for (const tensor of tensors) assert.equal(tensor.disposals, 1, `Tensor ${tensor.type} ${tensor.dims} must be disposed once`); } };
}

test('preprocessing prepends exactly 0.25 seconds without modifying or detaching source audio', async () => {
  const h = harness();
  const samples = audio(0.1);
  const copy = samples.slice();
  assert.deepEqual(await h.engine.transcribe(samples), { text: 'I agree', chunks: [] });
  assert.equal(h.featureInput.length, samples.length + 4000);
  assert.ok(h.featureInput.subarray(0, 4000).every(value => value === 0));
  assert.deepEqual(h.featureInput.subarray(4000), copy);
  assert.deepEqual(samples, copy);
  h.assertDisposed();
});

test('installed ParakeetFeatureExtractor supplies the expected features and masks without model loading', async () => {
  let features;
  const h = harness({ realFeatures: true, encoderRun(feeds, make) {
    features = feeds;
    assert.deepEqual(feeds.input_features.dims, [1, 36, 128]);
    assert.deepEqual(feeds.attention_mask.dims, [1, 36]);
    assert.ok(feeds.input_features.data.every(Number.isFinite));
    assert.equal(feeds.attention_mask.data[34], 1n);
    assert.equal(feeds.attention_mask.data[35], 0n);
    return { encoder_outputs: make('float32', new Float32Array(2), [1, 1, 2]), encoder_lengths: make('int64', BigInt64Array.of(1n), [1]) };
  }, sequence: [{ token: 3, duration: 0 }] });
  assert.deepEqual(await h.engine.transcribe(audio(0.1)), { text: '', chunks: [] });
  assert.ok(features);
  h.assertDisposed();
});

test('blank advances at least one frame while retaining last token and prediction state', async () => {
  const h = harness({ sequence: [{ token: 4, duration: 0 }, { token: blank, duration: 0 }, { token: 6, duration: 2 }, { token: 3, duration: 0 }] });
  assert.equal((await h.engine.transcribe(audio(0.1))).text, 'I agree');
  assert.deepEqual(h.calls.map(call => [call.frame, call.last, call.hValue, call.cValue]), [[0, blank, 0, 0], [0, 4, 1, 101], [1, 4, 1, 101], [3, 6, 3, 103]]);
  assert.equal(h.calls[2].h, h.calls[1].h);
  assert.equal(h.calls[1].out.state_h_out.disposals, 1, 'the ignored blank state is released');
  h.assertDisposed();
});

test('zero-duration nonblank tokens update state and preserve repetitions, fillers, and punctuation', async () => {
  const h = harness({ sequence: [{ token: 4, duration: 0 }, { token: 4, duration: 0 }, { token: 5, duration: 0 }, { token: 6, duration: 0 }, { token: 7, duration: 1 }, { token: 3, duration: 0 }] });
  assert.equal((await h.engine.transcribe(audio(0.1))).text, 'I I um agree.');
  assert.deepEqual(h.calls.slice(0, 5).map(call => call.frame), [0, 0, 0, 0, 0]);
  assert.deepEqual(h.calls.map(call => call.hValue), [0, 1, 2, 3, 4, 5]);
  h.assertDisposed();
});

test('duration indices map to 0–4 and valid encoder length limits decoding', async () => {
  const h = harness({ frames: 12, length: 7, sequence: [{ token: 4, duration: 4 }, { token: blank, duration: 3 }, { token: 6, duration: 1 }] });
  assert.equal((await h.engine.transcribe(audio(0.1))).text, 'I');
  assert.deepEqual(h.calls.map(call => call.frame), [0, 4]);
  h.assertDisposed();
});

test('EOS ends decoding immediately and special tokens do not appear in text', async () => {
  const h = harness({ sequence: [{ token: 2, duration: 0 }, { token: 4, duration: 0 }, { token: 3, duration: 0 }, { token: 6, duration: 1 }] });
  assert.equal((await h.engine.transcribe(audio(0.1))).text, 'I');
  assert.equal(h.calls.length, 3);
  h.assertDisposed();
});

test('nonadvancing inference fails at the reference step limit instead of returning a truncated transcript', async () => {
  const h = harness({ frames: 2, sequence: [{ token: 4, duration: 0 }] });
  await assert.rejects(h.engine.transcribe(audio(0.1)), { code: 'BARK_DECODE_LIMIT' });
  assert.equal(h.calls.length, 19);
  h.assertDisposed();
});

test('empty, oversized, non-Float32, nonfinite, and nonnormalized audio fail before feature extraction', async () => {
  for (const samples of [new Float32Array(), new Float32Array(480001), new Float64Array(4), [0.1], new Float32Array([NaN]), new Float32Array([Infinity]), new Float32Array([1.1])]) {
    const h = harness();
    await assert.rejects(h.engine.transcribe(samples), RangeError);
    assert.equal(h.featureInput, undefined);
    assert.equal(h.calls.length, 0);
    assert.equal(h.tensors.length, 0);
  }
});

test('empty recognition from valid audio returns empty text and releases resources', async () => {
  const h = harness({ frames: 2, sequence: [{ token: blank, duration: 1 }] });
  assert.deepEqual(await h.engine.transcribe(new Float32Array(1600)), { text: '', chunks: [] });
  assert.equal(h.calls.length, 2);
  h.assertDisposed();
});

test('encoder length outside available frames fails before decoder use and disposes its outputs', async () => {
  for (const length of [-1, 6]) {
    const h = harness({ frames: 5, length });
    await assert.rejects(h.engine.transcribe(audio(0.1)), /encoded audio length/);
    assert.equal(h.calls.length, 0);
    h.assertDisposed();
  }
});

test('invalid decoder logits fail with no transcript and release all outputs', async () => {
  const h = harness({ decoderRun(_feeds, { make, hidden }) {
    return { token_logits: make('float32', new Float32Array(8193).fill(NaN), [1, 8193]), duration_logits: make('float32', new Float32Array(5), [1, 5]), state_h_out: hidden(1), state_c_out: hidden(2) };
  } });
  await assert.rejects(h.engine.transcribe(audio(0.1)), /invalid token logits/);
  h.assertDisposed();
});

test('decoder rejection releases pending inputs, retained states, features, and encoder outputs', async () => {
  const h = harness({ decoderRun() { throw new Error('Decoder failure'); } });
  await assert.rejects(h.engine.transcribe(audio(0.1)), /Decoder failure/);
  h.assertDisposed();
});

test('abort before preprocessing performs no work; abort after a decoder reply discards that reply', async () => {
  const before = harness();
  const canceled = new AbortController(); canceled.abort();
  await assert.rejects(before.engine.transcribe(audio(0.1), { signal: canceled.signal }), { name: 'AbortError' });
  assert.equal(before.tensors.length, 0);
  const controller = new AbortController();
  const h = harness({ decoderRun(_feeds, { logits, hidden }) {
    controller.abort();
    return { token_logits: logits(8193, 4), duration_logits: logits(5, 0), state_h_out: hidden(1), state_c_out: hidden(2) };
  } });
  await assert.rejects(h.engine.transcribe(audio(0.1), { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(h.calls.length, 1);
  h.assertDisposed();
});

test('engine serializes ownership, waits for an active inference before release, and releases once', async () => {
  const gate = deferred();
  const h = harness({ async decoderRun(_feeds, { logits, hidden }) {
    await gate.promise;
    return { token_logits: logits(8193, 3), duration_logits: logits(5, 0), state_h_out: hidden(1), state_c_out: hidden(2) };
  } });
  const pending = h.engine.transcribe(audio(0.1));
  await Promise.resolve(); await Promise.resolve();
  await assert.rejects(h.engine.transcribe(audio(0.1)), /still running/);
  const releasing = h.engine.release();
  assert.equal(h.engine.release(), releasing);
  assert.deepEqual(h.releases, { encoder: 0, decoder: 0 });
  gate.resolve();
  await pending; await releasing;
  assert.deepEqual(h.releases, { encoder: 1, decoder: 1 });
  await assert.rejects(h.engine.transcribe(audio(0.1)), /released/);
  h.assertDisposed();
});

test('release attempts both sessions even when the first disposal throws synchronously', async () => {
  const h = harness();
  h.encoder.release = () => { h.releases.encoder++; throw new Error('Encoder release failed'); };
  await assert.rejects(h.engine.release(), /Encoder release failed/);
  assert.deepEqual(h.releases, { encoder: 1, decoder: 1 });
});

test('three-graph Plus uses channel-first acoustic frames and preserves blank states and repeated tokens', async () => {
  const h = harness({ separateGraphs: true, sequence: [{ token: 4, duration: 0 }, { token: blank, duration: 0 }, { token: 4, duration: 0 }, { token: 5, duration: 2 }, { token: 6, duration: 1 }, { token: 3, duration: 0 }] });
  assert.equal((await h.engine.transcribe(audio(0.1))).text, 'I I um agree');
  assert.equal(h.featureInput.length, 5600);
  assert.deepEqual(h.calls.map(call => [call.frame, call.last, call.hValue]), [[0, blank, 0], [0, 4, 1], [1, 4, 1], [1, 4, 3], [3, 5, 4], [4, 6, 5]]);
  assert.deepEqual(h.calls[4].encoderFrame, [3, 103, 203]);
  assert.equal(h.calls[2].h, h.calls[1].h);
  h.assertDisposed();
  await h.engine.release();
  assert.deepEqual(h.releases, { encoder: 1, decoder: 1, joiner: 1 });
});

test('three-graph Clean adds no leading silence and transposes actual feature data using valid frame length', async () => {
  const h = harness({ separateGraphs: true, leadingSilence: 0, realFeatures: true, encoderRun(feeds, make) {
    assert.deepEqual(feeds.audio_signal.dims, [1, 128, 11]);
    assert.deepEqual([...feeds.length.data], [10n]);
    assert.ok(feeds.audio_signal.data.every(Number.isFinite));
    for (let channel = 0; channel < 128; channel++) assert.equal(feeds.audio_signal.data[channel * 11 + 10], 0);
    return { outputs: make('float32', new Float32Array(3), [1, 3, 1]), encoded_lengths: make('int64', BigInt64Array.of(1n), [1]) };
  }, sequence: [{ token: 3, duration: 0 }] });
  assert.deepEqual(await h.engine.transcribe(audio(0.1)), { text: '', chunks: [] });
  h.assertDisposed();
  const synthetic = harness({ separateGraphs: true, leadingSilence: 0 });
  const source = audio(0.1);
  await synthetic.engine.transcribe(source);
  assert.deepEqual(synthetic.featureInput, source);
  synthetic.assertDisposed();
});

test('three-graph joiner errors and malformed logits dispose predictor states and all feeds', async () => {
  for (const joinerRun of [() => { throw new Error('Joiner failed'); }, (_feeds, { make }) => ({ outputs: make('float32', new Float32Array(8197), [1, 1, 1, 8198]) })]) {
    const h = harness({ separateGraphs: true, joinerRun });
    await assert.rejects(h.engine.transcribe(audio(0.1)), /Joiner failed|joiner logits length/);
    h.assertDisposed();
  }
});

test('three-graph nonadvancing decoding is bounded and canceled joiner replies are discarded', async () => {
  const h = harness({ separateGraphs: true, frames: 2, sequence: [{ token: 4, duration: 0 }] });
  await assert.rejects(h.engine.transcribe(audio(0.1)), { code: 'BARK_DECODE_LIMIT' });
  assert.equal(h.calls.length, 19);
  h.assertDisposed();
  const controller = new AbortController();
  const canceled = harness({ separateGraphs: true, joinerRun(_feeds, { make }) {
    controller.abort();
    return { outputs: make('float32', new Float32Array(8198), [1, 1, 1, 8198]) };
  } });
  await assert.rejects(canceled.engine.transcribe(audio(0.1), { signal: controller.signal }), { name: 'AbortError' });
  canceled.assertDisposed();
});

test('three-graph release attempts every session and tokens.txt rejects duplicate or missing blank IDs', async () => {
  const h = harness({ separateGraphs: true });
  h.decoder.release = () => { h.releases.decoder++; throw new Error('Decoder release failed'); };
  await assert.rejects(h.engine.release(), /Decoder release failed/);
  assert.deepEqual(h.releases, { encoder: 1, decoder: 1, joiner: 1 });
  assert.throws(() => harness({ separateGraphs: true, tokenizerOverride: 'a 4\nb 4\n<blk> 8192' }), /tokens.txt/);
  assert.throws(() => harness({ separateGraphs: true, tokenizerOverride: 'a 4' }), /blank token/);
});

test('full recordings split at quiet points with complete, disjoint, <=30-second coverage', () => {
  assert.equal(BARK_SAMPLE_RATE, 16000);
  assert.equal(BARK_MAX_WINDOW_SECONDS, 30);
  const samples = audio(65);
  samples.fill(0, 25 * BARK_SAMPLE_RATE, 25.02 * BARK_SAMPLE_RATE);
  const windows = splitBarkWindows(samples);
  assert.equal(windows[0][0], 0);
  assert.equal(windows[0][1], 25.01 * BARK_SAMPLE_RATE);
  assert.equal(windows.at(-1)[1], samples.length);
  for (let index = 0; index < windows.length; index++) {
    const [from, to] = windows[index];
    assert.ok(to > from);
    assert.ok(to - from <= 30 * BARK_SAMPLE_RATE);
    if (index) assert.equal(from, windows[index - 1][1]);
  }
  assert.equal(windows.reduce((sum, [from, to]) => sum + to - from, 0), samples.length);
});

test('window helper preserves exact-length recordings and validates options/audio', () => {
  assert.deepEqual(splitBarkWindows(audio(30)), [[0, 480000]]);
  assert.deepEqual(splitBarkWindows(audio(31), { searchSeconds: 0 }), [[0, 480000], [480000, 496000]]);
  assert.throws(() => splitBarkWindows(new Float32Array()), RangeError);
  assert.throws(() => splitBarkWindows(audio(1), { maxSeconds: 31 }), RangeError);
  assert.throws(() => splitBarkWindows(audio(1), { searchSeconds: -1 }), RangeError);
});
