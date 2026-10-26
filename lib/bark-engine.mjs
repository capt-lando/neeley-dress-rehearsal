/*! @license
 * Bark 3.0 browser inference adapter.
 * Greedy TDT and quiet-window rules adapted from slicc-ortllama:
 * Copyright 2025 ai-ecoverse. Licensed under the Apache License, Version 2.0.
 * https://github.com/ai-ecoverse/slicc-ortllama/blob/main/src/parakeet/model.js
 * https://www.apache.org/licenses/LICENSE-2.0
 * Modified for Neeley Dress Rehearsal: injected sessions, Transformers.js feature
 * extraction, strict input/output checks, bounded decoding, and tensor cleanup.
 * The separate Bark model weights have their own attribution/license requirements.
 */
import { ParakeetFeatureExtractor } from '@huggingface/transformers';

export const BARK_SAMPLE_RATE = 16_000;
export const BARK_MAX_WINDOW_SECONDS = 30;
const BLANK_TOKEN = 8192;

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : Object.assign(new Error('Transcription stopped.'), { name: 'AbortError' });
}
function checkSignal(signal) { if (signal?.aborted) throw abortError(signal); }
function audioCheck(samples, maxSeconds) {
  if (!(samples instanceof Float32Array) || !samples.length || samples.length > BARK_SAMPLE_RATE * maxSeconds) {
    throw new RangeError(`Provide mono 16 kHz Float32 audio of up to ${maxSeconds} seconds.`);
  }
  for (const sample of samples) if (!Number.isFinite(sample) || Math.abs(sample) > 1) throw new RangeError('Audio samples must be finite values between -1 and 1.');
}
function dimensions(tensor, expected, label) {
  if (!tensor || !Array.isArray(tensor.dims) || tensor.dims.length !== expected.length || expected.some((size, index) => size !== null && tensor.dims[index] !== size)) {
    throw new Error(`Bark returned invalid ${label} dimensions.`);
  }
}
function tensorData(tensor, label, type) {
  if (tensor?.type !== type) throw new Error(`Bark returned an unsupported ${label} type; expected ${type}.`);
  const data = tensor.data;
  if (!ArrayBuffer.isView(data)) throw new Error(`Bark returned invalid ${label} data.`);
  return data;
}
function maximumIndex(values, expected, label) {
  if (values.length !== expected) throw new Error(`Bark returned invalid ${label} length.`);
  let best = -1;
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (Number.isNaN(value) || value === Infinity) throw new Error(`Bark returned invalid ${label}.`);
    if (Number.isFinite(value) && (best < 0 || value > values[best])) best = index;
  }
  if (best < 0) throw new Error(`Bark returned no usable ${label}.`);
  return best;
}
function vocabulary(tokenizer) {
  // sherpa-onnx exports store one SentencePiece token and numeric ID per line.
  if (typeof tokenizer === 'string') {
    const pieces = [];
    for (const line of tokenizer.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const match = /^(\S+) (\d+)$/.exec(line);
      if (!match || Number(match[2]) > BLANK_TOKEN || pieces[Number(match[2])] !== undefined) throw new TypeError('Provide a valid Bark tokens.txt vocabulary.');
      pieces[Number(match[2])] = match[1];
    }
    if (pieces[BLANK_TOKEN] !== '<blk>') throw new TypeError('The Bark vocabulary is missing its blank token.');
    return pieces;
  }
  const vocab = tokenizer?.model?.vocab;
  if (!vocab || typeof vocab !== 'object' || Array.isArray(vocab)) throw new TypeError('Provide the Bark tokenizer.json vocabulary.');
  const pieces = [];
  for (const [piece, id] of Object.entries(vocab)) {
    if (!Number.isSafeInteger(id) || id < 0 || id > BLANK_TOKEN) throw new TypeError('The Bark vocabulary contains an invalid token ID.');
    pieces[id] = piece;
  }
  for (const added of tokenizer.added_tokens || []) {
    if (!Number.isSafeInteger(added.id) || added.id < 0 || typeof added.content !== 'string') throw new TypeError('The Bark tokenizer contains an invalid added token.');
    pieces[added.id] = added.content;
  }
  return pieces;
}

/** Disjoint sample ranges, cut at a quiet 20 ms region before the 30 second limit. */
export function splitBarkWindows(samples, { maxSeconds = BARK_MAX_WINDOW_SECONDS, searchSeconds = 10 } = {}) {
  audioCheck(samples, 600);
  if (!Number.isFinite(maxSeconds) || maxSeconds < 0.02 || maxSeconds > BARK_MAX_WINDOW_SECONDS ||
      !Number.isFinite(searchSeconds) || searchSeconds < 0 || searchSeconds > maxSeconds) {
    throw new RangeError('Use a window of up to 30 seconds with a shorter quiet-point search.');
  }
  const size = Math.floor(maxSeconds * BARK_SAMPLE_RATE);
  const search = Math.floor(searchSeconds * BARK_SAMPLE_RATE);
  const quiet = Math.min(size, Math.round(0.02 * BARK_SAMPLE_RATE));
  const stride = Math.max(1, Math.floor(quiet / 2));
  const windows = [];
  let start = 0;
  while (samples.length - start > size) {
    let end = start + size;
    let lowestEnergy = Infinity;
    for (let at = Math.max(start, end - search); at + quiet <= start + size; at += stride) {
      let energy = 0;
      for (let index = at; index < at + quiet; index++) energy += samples[index] * samples[index];
      if (energy < lowestEnergy) { lowestEnergy = energy; end = at + stride; }
    }
    windows.push([start, end]);
    start = end;
  }
  windows.push([start, samples.length]);
  return windows;
}

/**
 * No model retrieval or runtime initialization occurs here. Sessions must expose
 * CPU float32 outputs (q4f16 encoder graph boundaries are float32; decoder is fp32).
 * Supplying joiner selects the three-graph NeMo/sherpa TDT export. For that layout,
 * config.encoder_hidden_size is 1024 and tokenizer may be the raw tokens.txt text.
 * Its Plus model uses 0.25 s leading silence; its Clean model uses zero.
 * transcribe handles one <=30 s window. Call splitBarkWindows for longer audio,
 * decode each range, then join their text without removing repeated words.
 */
export function createBarkEngine({ ort, encoder, decoder, joiner, config, tokenizer, preprocessor, generation = {}, featureExtractor } = {}) {
  if (typeof ort?.Tensor !== 'function' || typeof encoder?.run !== 'function' || typeof decoder?.run !== 'function') throw new TypeError('Provide ONNX Runtime and both Bark sessions.');
  const separateGraphs = joiner !== undefined;
  if (separateGraphs && typeof joiner?.run !== 'function') throw new TypeError('Provide the Bark joiner session.');
  const { decoder_hidden_size: hidden, num_decoder_layers: layers, max_symbols_per_step: maxSymbols = 10 } = config || {};
  const encoderHidden = separateGraphs ? config?.encoder_hidden_size : hidden;
  if (config?.blank_token_id !== BLANK_TOKEN || config?.vocab_size !== BLANK_TOKEN + 1 ||
      JSON.stringify(config?.durations) !== '[0,1,2,3,4]' ||
      !Number.isSafeInteger(hidden) || hidden < 1 || !Number.isSafeInteger(encoderHidden) || encoderHidden < 1 || !Number.isSafeInteger(layers) || layers < 1 ||
      !Number.isSafeInteger(maxSymbols) || maxSymbols < 1 || maxSymbols > 100) throw new TypeError('Provide compatible Bark 3.0 TDT configuration.');
  if (preprocessor?.sampling_rate !== BARK_SAMPLE_RATE || preprocessor?.feature_size !== 128 ||
      ![0.25, ...(separateGraphs ? [0] : [])].includes(preprocessor?.leading_silence_seconds)) throw new TypeError('Bark requires 16 kHz, 128-feature preprocessing with the model\'s leading silence setting.');
  const leadingSamples = BARK_SAMPLE_RATE * preprocessor.leading_silence_seconds;
  const eos = new Set([generation.eos_token_id ?? 3].flat());
  if ([...eos].some(id => !Number.isSafeInteger(id) || id < 0 || id >= BLANK_TOKEN)) throw new TypeError('Provide valid Bark end-of-sequence token IDs.');
  const pieces = vocabulary(tokenizer);
  const extract = featureExtractor || new ParakeetFeatureExtractor({ ...preprocessor });
  if (typeof extract !== 'function') throw new TypeError('Provide a callable Bark feature extractor.');
  let active;
  let released = false;
  let releasePromise;

  async function infer(samples, { signal, onProgress } = {}) {
    audioCheck(samples, BARK_MAX_WINDOW_SECONDS);
    checkSignal(signal);
    const owned = new Set();
    const own = tensor => { if (tensor && typeof tensor.dispose === 'function') owned.add(tensor); return tensor; };
    const dispose = (...tensors) => {
      for (const tensor of new Set(tensors)) {
        if (!owned.delete(tensor)) continue;
        try { tensor.dispose(); } catch { /* Cleanup failures must not mask the original inference error. */ }
      }
    };
    const notify = percent => { try { onProgress?.(`Transcribing Bark on this device… ${percent}%`); } catch {} };
    try {
      const padded = new Float32Array(leadingSamples + samples.length);
      padded.set(samples, leadingSamples);
      const extracted = await extract(padded);
      own(extracted?.input_features); own(extracted?.attention_mask);
      checkSignal(signal);
      dimensions(extracted?.input_features, [1, null, 128], 'input features');
      const frames = extracted.input_features.dims[1];
      if (!Number.isSafeInteger(frames) || frames < 1) throw new Error('Bark received an invalid feature count.');
      dimensions(extracted.attention_mask, [1, frames], 'attention mask');
      const features = tensorData(extracted.input_features, 'input features', 'float32');
      const attention = tensorData(extracted.attention_mask, 'attention mask', 'int64');
      if (features.length !== frames * 128 || attention.length !== frames) throw new Error('Bark received invalid feature data.');
      let input, mask, encoderFeeds;
      if (separateGraphs) {
        const transposed = new Float32Array(features.length);
        for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < 128; channel++) transposed[channel * frames + frame] = features[frame * 128 + channel];
        let validFrames = 0n;
        let padding = false;
        for (const value of attention) {
          if (value === 0n) padding = true;
          else if (value === 1n && !padding) validFrames++;
          else throw new Error('Bark received an invalid attention mask.');
        }
        input = own(new ort.Tensor('float32', transposed, [1, 128, frames]));
        mask = own(new ort.Tensor('int64', BigInt64Array.of(validFrames), [1]));
        encoderFeeds = { audio_signal: input, length: mask };
      } else {
        input = own(new ort.Tensor('float32', features, [1, frames, 128]));
        mask = own(new ort.Tensor('int64', attention, [1, frames]));
        encoderFeeds = { input_features: input, attention_mask: mask };
      }
      notify(0);
      const encoded = await encoder.run(encoderFeeds);
      for (const value of Object.values(encoded || {})) own(value);
      dispose(input, mask, extracted.input_features, extracted.attention_mask);
      checkSignal(signal);
      const encoderOutput = separateGraphs ? encoded?.outputs : encoded?.encoder_outputs;
      const encoderLengths = separateGraphs ? encoded?.encoded_lengths : encoded?.encoder_lengths;
      dimensions(encoderOutput, separateGraphs ? [1, encoderHidden, null] : [1, null, encoderHidden], 'encoder output');
      dimensions(encoderLengths, [1], 'encoder lengths');
      const encodedFrames = encoderOutput.dims[separateGraphs ? 2 : 1];
      const encodedData = tensorData(encoderOutput, 'encoder output', 'float32');
      const length = Number(tensorData(encoderLengths, 'encoder lengths', 'int64')[0]);
      if (!Number.isSafeInteger(encodedFrames) || encodedFrames < 1 || encodedData.length !== encodedFrames * encoderHidden ||
          !Number.isSafeInteger(length) || length < 0 || length > encodedFrames) throw new Error('Bark returned an invalid encoded audio length.');
      let h = own(new ort.Tensor('float32', new Float32Array(layers * hidden), [layers, 1, hidden]));
      let c = own(new ort.Tensor('float32', new Float32Array(layers * hidden), [layers, 1, hidden]));
      let previous = BLANK_TOKEN;
      let frame = 0;
      let steps = 0;
      let finished = false;
      let progress = 0;
      const ids = [];
      // Match the export's generate() bound, including blank steps and excluding its start token.
      const limit = maxSymbols * encodedFrames - 1;
      while (frame < length && steps < limit) {
        checkSignal(signal);
        let embedding, inputIds, targetLength, out, tokenLogits, durationLogits;
        if (separateGraphs) {
          const frameData = new Float32Array(encoderHidden);
          for (let channel = 0; channel < encoderHidden; channel++) frameData[channel] = encodedData[channel * encodedFrames + frame];
          embedding = own(new ort.Tensor('float32', frameData, [1, encoderHidden, 1]));
          inputIds = own(new ort.Tensor('int32', Int32Array.of(previous), [1, 1]));
          targetLength = own(new ort.Tensor('int32', Int32Array.of(1), [1]));
          out = await decoder.run({ targets: inputIds, target_length: targetLength, 'states.1': h, 'states.2': c });
        } else {
          embedding = own(new ort.Tensor('float32', encodedData.subarray(frame * hidden, (frame + 1) * hidden), [1, 1, hidden]));
          inputIds = own(new ort.Tensor('int64', BigInt64Array.of(BigInt(previous)), [1, 1]));
          out = await decoder.run({ encoder_outputs: embedding, input_ids: inputIds, state_h: h, state_c: c });
        }
        for (const value of Object.values(out || {})) own(value);
        checkSignal(signal);
        const nextH = separateGraphs ? out?.states : out?.state_h_out;
        const nextC = separateGraphs ? out?.['states.2_out'] : out?.state_c_out;
        dimensions(nextH, [layers, 1, hidden], 'decoder hidden state');
        dimensions(nextC, [layers, 1, hidden], 'decoder cell state');
        if (nextH.type !== 'float32' || nextC.type !== 'float32') throw new Error('Bark returned invalid decoder state types.');
        let joined;
        if (separateGraphs) {
          dimensions(out.outputs, [1, hidden, 1], 'prediction output');
          tensorData(out.outputs, 'prediction output', 'float32');
          joined = await joiner.run({ encoder_outputs: embedding, decoder_outputs: out.outputs });
          for (const value of Object.values(joined || {})) own(value);
          checkSignal(signal);
          dimensions(joined?.outputs, [1, 1, 1, config.vocab_size + config.durations.length], 'joiner output');
          const logits = tensorData(joined.outputs, 'joiner logits', 'float32');
          if (logits.length !== config.vocab_size + config.durations.length) throw new Error('Bark returned invalid joiner logits length.');
          tokenLogits = logits.subarray(0, config.vocab_size);
          durationLogits = logits.subarray(config.vocab_size);
        } else {
          tokenLogits = tensorData(out?.token_logits, 'token logits', 'float32');
          durationLogits = tensorData(out?.duration_logits, 'duration logits', 'float32');
        }
        dispose(embedding, inputIds, targetLength);
        const token = maximumIndex(tokenLogits, config.vocab_size, 'token logits');
        const duration = config.durations[maximumIndex(durationLogits, config.durations.length, 'duration logits')];
        if (token !== BLANK_TOKEN) {
          const oldH = h, oldC = c;
          h = nextH; c = nextC; previous = token;
          for (const tensor of [oldH, oldC]) if (tensor !== h && tensor !== c) dispose(tensor);
          ids.push(token);
        }
        for (const tensor of Object.values(out)) if (tensor !== h && tensor !== c) dispose(tensor);
        if (joined) for (const tensor of Object.values(joined)) if (tensor !== h && tensor !== c) dispose(tensor);
        frame += token === BLANK_TOKEN ? Math.max(duration, 1) : duration;
        steps++;
        const percent = Math.min(100, Math.floor(frame / length * 100));
        if (percent >= progress + 5) { progress = percent; notify(percent); }
        if (eos.has(token)) { finished = true; break; }
      }
      if (!finished && frame < length) throw Object.assign(new Error('Bark decoding stopped because it was not advancing. Try a shorter recording.'), { code: 'BARK_DECODE_LIMIT' });
      const text = ids.filter(id => !eos.has(id)).map(id => {
        const piece = pieces[id];
        if (typeof piece !== 'string') throw new Error('Bark returned a token missing from its vocabulary.');
        return piece.startsWith('<') && piece.endsWith('>') ? '' : piece;
      }).join('').replaceAll('\u2581', ' ').trim();
      return { text, chunks: [] };
    } finally { dispose(...owned); }
  }

  return {
    async transcribe(samples, options = {}) {
      if (released) throw new Error('This Bark speech engine has been released.');
      if (active) throw new Error('Another Bark transcription is still running.');
      const job = infer(samples, options);
      active = job;
      try { return await job; } finally { if (active === job) active = null; }
    },
    release() {
      if (!releasePromise) {
        released = true;
        releasePromise = (async () => {
          try { await active; } catch { /* Release after failed inference as well. */ }
          const results = await Promise.allSettled([encoder, decoder, ...(separateGraphs ? [joiner] : [])].map(session => Promise.resolve().then(() => session.release?.())));
          const failed = results.find(result => result.status === 'rejected');
          if (failed) throw failed.reason;
        })();
      }
      return releasePromise;
    },
  };
}
