/** Serial, bounded PCM batches for draft local transcription. No browser globals. */
const tokens = text => [...text.matchAll(/[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}]+)*/gu)].map(match => ({
  value: match[0].normalize('NFKC').replace(/’/g, "'").toLowerCase(), start: match.index, end: match.index + match[0].length,
}));

function mergeBoundary(text, previous, incoming, overlapSeconds) {
  const append = addition => addition ? (text ? `${text} ${addition}` : addition) : text;
  if (!previous || !incoming || overlapSeconds <= 0) return append(incoming);
  // Only compare the adjacent chunk boundary, never repetitions inside a chunk.
  // Shared audio permits at most six matching boundary words per second.
  // This is approximate text alignment; it cannot supply word-level timestamps.
  const limit = Math.min(12, Math.ceil(overlapSeconds * 6));
  const before = tokens(previous).slice(-limit), after = tokens(incoming).slice(0, limit);
  for (let length = Math.min(before.length, after.length); length > 0; length--) {
    if (before.slice(-length).every((word, index) => word.value === after[index].value)) {
      const suffix = previous.slice(before[before.length - length].start);
      // Keep the newer punctuation too: '$3.' + '$3,000' must become '$3,000'.
      if (text.endsWith(suffix)) return text.slice(0, -suffix.length) + incoming.slice(after[0].start);
      return append(incoming.slice(after[length - 1].end).replace(/^[\s,.;:!?…—–-]+/u, '').trim());
    }
  }
  // A unique shared phrase can replace a cut-off ending with its newer reading.
  // Never guess from one word or choose between equally strong repeated anchors.
  let anchor, longest = 1, ambiguous = false;
  for (let i = 0; i < before.length; i++) for (let j = 0; j < after.length; j++) {
    if (before.length - i + j > limit) continue;
    let length = 0;
    while (i + length < before.length && j + length < after.length && before[i + length].value === after[j + length].value) length++;
    if (length > longest) { anchor = { i, j }; longest = length; ambiguous = false; }
    else if (length === longest && length > 1) ambiguous = true;
  }
  if (anchor && !ambiguous) {
    const suffix = previous.slice(before[anchor.i].start);
    // Earlier overlap removal may have shortened the previous chunk. Revise only
    // an exact suffix still present in the displayed text, never older content.
    if (text.endsWith(suffix)) return text.slice(0, -suffix.length) + incoming.slice(after[anchor.j].start);
  }
  return append(incoming);
}

function abortError() {
  return Object.assign(new Error('Live transcription was cancelled.'), { name: 'AbortError' });
}

/**
 * transcribe(ownedSamples, metadata) returns text or {text}. Samples retain the
 * constructor's sampleRate; the injected engine may resample/transfer its buffer.
 * Pause by not calling push. finish() resolves {text, durationSeconds}.
 * All accepted audio is kept until processed; maxSeconds bounds the backlog.
 * Optional prepare({signal}) warms the engine without blocking capture.
 * onUpdate runs at chunk/phase boundaries, not on every captured audio frame.
 * Its exceptions cannot interrupt audio processing.
 */
export function createLiveTranscription({
  sampleRate, transcribe, prepare, onUpdate = () => {}, chunkSeconds = 8, overlapSeconds = 2, maxSeconds = 600,
} = {}) {
  if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 192_000) throw new RangeError('Use a valid PCM sample rate.');
  if (typeof transcribe !== 'function' || typeof onUpdate !== 'function' || prepare !== undefined && typeof prepare !== 'function') throw new TypeError('Provide valid transcription, preparation and update callbacks.');
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0 || maxSeconds > 600 ||
      !Number.isFinite(chunkSeconds) || chunkSeconds <= 0 || chunkSeconds > maxSeconds ||
      !Number.isFinite(overlapSeconds) || overlapSeconds < 0 || overlapSeconds >= chunkSeconds) {
    throw new RangeError('Use positive chunk and recording limits, with overlap shorter than a chunk.');
  }
  const chunkSize = Math.max(1, Math.round(chunkSeconds * sampleRate));
  const overlapSize = Math.round(overlapSeconds * sampleRate);
  const maxSamples = Math.floor(maxSeconds * sampleRate);
  const controller = new AbortController();
  let buffer = new Float32Array(chunkSize), buffered = 0, tail = new Float32Array(0);
  let queue = [], head = 0, current = null, pumping = false, scheduled = false;
  let audioSamples = 0, queuedSamples = 0, completedSamples = 0, nextIndex = 0;
  let text = '', previousChunkText = '', ending = false, finished = false, cancelled = false, failure = null, prepared = !prepare;
  let finishPromise, resolveFinish, rejectFinish;

  function getState() {
    const ready = queue.length - head + (current ? 1 : 0);
    return {
      text, audioSeconds: audioSamples / sampleRate, completedSeconds: completedSamples / sampleRate,
      pendingChunks: ready + (buffered ? 1 : 0), pendingSeconds: (audioSamples - completedSamples) / sampleRate,
      catchingUp: !failure && !cancelled && (ready > 1 || ending && !finished && audioSamples > completedSamples),
      preparing: !prepared && !failure && !cancelled,
      finishing: ending && !finished && !failure && !cancelled, finished, error: failure, cancelled,
    };
  }
  function emit() { try { onUpdate(getState()); } catch { /* Observer failures do not invalidate captured audio. */ } }
  function releaseQueuedAudio() {
    queue = []; head = 0; current = null; buffer = null; buffered = 0; tail = new Float32Array(0);
  }
  function settle() {
    if (!finishPromise) return;
    if (cancelled || failure) {
      rejectFinish(cancelled ? abortError() : failure);
    } else if (prepared && ending && !current && head === queue.length && !buffered) {
      if (!finished) { finished = true; releaseQueuedAudio(); emit(); }
      resolveFinish({ text, durationSeconds: audioSamples / sampleRate });
    }
  }
  function fail(error) {
    if (cancelled || failure) return;
    failure = error instanceof Error ? error : new Error('Live transcription failed. Try transcribing the complete recording.');
    controller.abort(); releaseQueuedAudio(); emit(); settle();
  }
  function enqueue(final) {
    if (!buffered) return;
    const overlap = tail.length;
    const samples = overlap ? new Float32Array(overlap + buffered) : buffer.subarray(0, buffered);
    if (overlap) { samples.set(tail); samples.set(buffer.subarray(0, buffered), overlap); }
    // Keep an independent tail because an engine may transfer the job buffer.
    tail = samples.slice(Math.max(0, samples.length - overlapSize));
    const start = queuedSamples - overlap;
    queuedSamples += buffered;
    queue.push({ samples, endSample: queuedSamples, metadata: {
      sampleRate, signal: controller.signal, index: nextIndex++, startSeconds: start / sampleRate,
      endSeconds: queuedSamples / sampleRate, overlapSeconds: overlap / sampleRate, isFinal: final,
    } });
    buffer = final ? null : new Float32Array(chunkSize); buffered = 0;
  }
  async function pump() {
    scheduled = false;
    if (pumping || cancelled || failure || finished) return;
    pumping = true;
    try {
      await ready;
      while (head < queue.length && !cancelled && !failure) {
        const job = queue[head]; queue[head++] = null; current = job;
        emit();
        if (cancelled || failure) break;
        const result = await transcribe(job.samples, job.metadata);
        if (cancelled || failure) break;
        const incoming = typeof result === 'string' ? result.trim() : typeof result?.text === 'string' ? result.text.trim() : null;
        if (incoming === null) throw new TypeError('The speech engine returned an invalid live transcript.');
        text = mergeBoundary(text, previousChunkText, incoming, job.metadata.overlapSeconds);
        previousChunkText = incoming; // A silent chunk breaks the textual overlap chain.
        completedSamples = job.endSample; current = null;
        if (head === queue.length) { queue = []; head = 0; }
        emit();
      }
    } catch (error) { fail(error); }
    finally { pumping = false; settle(); }
  }
  function schedule() {
    if (scheduled || pumping || cancelled || failure || finished) return;
    scheduled = true; queueMicrotask(pump);
  }
  function push(samples) {
    if (cancelled) throw abortError();
    if (failure) throw failure;
    if (ending || finished) throw new Error('This live transcription session has already stopped.');
    if (!(samples instanceof Float32Array)) throw new TypeError('Provide mono Float32Array PCM samples.');
    if (audioSamples + samples.length > maxSamples) {
      const error = Object.assign(new RangeError('Live transcription accepts at most ten minutes of recorded audio.'), { code: 'LIVE_AUDIO_LIMIT' });
      fail(error); throw error;
    }
    let offset = 0;
    const previousJobs = nextIndex;
    while (offset < samples.length) {
      const length = Math.min(chunkSize - buffered, samples.length - offset);
      buffer.set(samples.subarray(offset, offset + length), buffered);
      buffered += length; offset += length; audioSamples += length;
      if (buffered === chunkSize) enqueue(false);
    }
    if (nextIndex !== previousJobs) { emit(); schedule(); }
    return samples.length;
  }
  function finish() {
    if (finishPromise) return finishPromise;
    ending = true;
    finishPromise = new Promise((resolve, reject) => { resolveFinish = resolve; rejectFinish = reject; });
    if (!failure && !cancelled) { enqueue(true); emit(); schedule(); }
    settle();
    return finishPromise;
  }
  function cancel() {
    if (cancelled || finished) return false;
    cancelled = true; controller.abort(); releaseQueuedAudio(); emit(); settle();
    return true;
  }
  // Observe preparation failures immediately without creating an unhandled
  // rejection when recording has not yet stopped or produced a complete chunk.
  const ready = prepare ? Promise.resolve().then(() => {
    if (!cancelled) return prepare({ signal: controller.signal });
  }).then(() => {
    if (cancelled || failure) return;
    prepared = true; emit(); settle();
  }).catch(fail) : Promise.resolve();
  return { push, finish, cancel, getState };
}
