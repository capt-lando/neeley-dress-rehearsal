const STREAM_RATE = 24_000;
const FRAME_SAMPLES = 4_800; // At most 200 ms; microphone frames are sent as soon as they arrive.
const QUEUED_SAMPLE_LIMIT = STREAM_RATE * 30;
const SOCKET_BUFFER_LIMIT = STREAM_RATE; // Half a second of PCM16 in the browser's send buffer.
const SEGMENT_SAMPLE_LIMIT = STREAM_RATE * 100;
const abortError = () => Object.assign(new Error('Live transcription was cancelled.'), { name: 'AbortError' });

/** Authenticated, bounded PCM streaming. The complete recording is saved separately. */
export function createHostedLiveSession({ sampleRate, onUpdate, onProgress, recordingId, requestId,
  request, saveAudio, validateStart, getConnection, WebSocketImpl = globalThis.WebSocket,
  signal, timers = globalThis, checkpoint, checkpointFlush, onCheckpointError } = {}) {
  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) throw new RangeError('Use a valid microphone sample rate.');
  if ([request, saveAudio, validateStart, getConnection, WebSocketImpl].some(callback => typeof callback !== 'function')) {
    throw new TypeError('Provide the authenticated live connection and recording callbacks.');
  }
  const path = '/live-sessions/' + recordingId, controller = new AbortController();
  let started = false, initializing = true, connecting = false, cancelled = false, abandoned = false, completed = false;
  let ending = false, drained = false, failure = null, text = '', committedText = '';
  let sourceSamples = 0, outputSamples = 0, lastSourceSample = 0, committedSamples = 0, segmentIndex = 0;
  let queue = [], queueHead = 0, queuedSamples = 0, current = null;
  let startPromise, cancellation, finishPromise, resolveDrain, rejectDrain, progressTimer;
  let checkpointError = null, checkpointPending = [];
  const checkpointOperations = new Set();
  const send = (suffix, options) => request(path + suffix, options);
  const keepTake = () => { if (abandoned) throw abortError(); };
  const later = (callback, milliseconds) => {
    const timer = timers.setTimeout(callback, milliseconds);
    timer?.unref?.();
    return timer;
  };
  const clear = timer => { if (timer !== undefined) timers.clearTimeout(timer); };
  const alive = connection => current === connection && !cancelled && !failure && !completed;

  function getState() {
    const received = committedSamples + (current?.acceptedSamples || 0);
    const pendingSeconds = Math.max(0, sourceSamples / sampleRate - received / STREAM_RATE);
    return {
      text, audioSeconds: sourceSamples / sampleRate, completedSeconds: received / STREAM_RATE,
      pendingChunks: queue.length - queueHead + (current?.sentSamples > current?.acceptedSamples ? 1 : 0),
      pendingSeconds, catchingUp: !failure && !cancelled && (pendingSeconds > 2 || ending && !drained && pendingSeconds > 0),
      preparing: !failure && !cancelled && (initializing || connecting || Boolean(current && !current.ready)),
      finishing: ending && !drained && !failure && !cancelled, finished: drained, error: failure, cancelled, checkpointError,
    };
  }
  function emit() {
    clear(progressTimer); progressTimer = undefined;
    try { onUpdate?.(getState()); } catch { /* UI observers cannot interrupt capture. */ }
  }
  function emitProgress() {
    if (progressTimer === undefined) progressTimer = later(() => { progressTimer = undefined; emit(); }, 250);
  }
  function progress(message) { try { onProgress?.(message); } catch { /* Optional observer. */ } }
  function checkpointFailed(error) {
    if (checkpointError) return;
    checkpointError = error instanceof Error ? error : new Error('Refresh recovery could not save the latest audio.');
    checkpointPending = [];
    try { onCheckpointError?.(checkpointError); } catch { /* Recovery warnings do not stop live audio. */ }
    if (!onCheckpointError) progress('Refresh recovery is unavailable. Keep this page open until the recording is saved.');
  }
  function checkpointFrame(bytes) {
    if (typeof checkpoint !== 'function' || checkpointError || abandoned) return;
    if (!started) { checkpointPending.push(bytes); return; }
    try {
      const result = checkpoint(bytes);
      if (result && typeof result.then === 'function') {
        const operation = Promise.resolve(result).catch(checkpointFailed).finally(() => checkpointOperations.delete(operation));
        checkpointOperations.add(operation);
      }
    } catch (error) { checkpointFailed(error); }
  }
  function activateCheckpoints() {
    const pending = checkpointPending; checkpointPending = [];
    for (const bytes of pending) checkpointFrame(bytes);
  }
  async function flushCheckpoints() {
    if (!started || abandoned || typeof checkpointFlush !== 'function') return;
    try { await Promise.all([...checkpointOperations]); await checkpointFlush(); }
    catch (error) { checkpointFailed(error); }
  }
  function detach(connection) {
    clear(connection.openTimer); clear(connection.rotateTimer); clear(connection.drainTimer); clear(connection.pumpTimer);
    for (const [type, listener] of Object.entries(connection.listeners)) connection.socket.removeEventListener(type, listener);
    if (current === connection) current = null;
  }
  function closeConnection(cancelProvider = false) {
    if (!current) return;
    const connection = current;
    detach(connection);
    try {
      if (cancelProvider && connection.socket.readyState === 1) connection.socket.send(JSON.stringify({ type: 'cancel' }));
      connection.socket.close(1000, cancelProvider ? 'Recording cancelled' : 'Segment complete');
    } catch { /* The durable cancellation also releases the server session. */ }
  }
  function requestCancellation() {
    if (!cancellation && startPromise) {
      // Creation must settle first: an aborted POST could commit after its cancellation.
      cancellation = startPromise.catch(() => {}).then(() => send('/cancel', { method: 'POST', body: { requestId } })).catch(() => {});
    }
  }
  function releaseAudio() { queue = []; queueHead = 0; queuedSamples = 0; }
  function settle() {
    if (!resolveDrain) return;
    if (failure || cancelled) rejectDrain(failure || abortError());
    else if (ending && started && !initializing && !connecting && !current && queuedSamples === 0) {
      drained = true; emit(); resolveDrain();
    }
  }
  function fail(error) {
    if (failure || cancelled || completed) return;
    failure = error instanceof Error ? error : new Error('Live transcription failed. Retry the complete recording.');
    controller.abort(); signal?.removeEventListener('abort', externalAbort);
    closeConnection(true); releaseAudio(); requestCancellation(); emit(); settle();
  }
  function cancel() {
    if (cancelled || completed) return false;
    cancelled = true; controller.abort(); signal?.removeEventListener('abort', externalAbort);
    closeConnection(true); releaseAudio(); requestCancellation(); void flushCheckpoints(); emit(); settle();
    return true;
  }
  function abandon() {
    if (abandoned || completed) return false;
    abandoned = true; checkpointPending = []; cancel(); return true;
  }
  function externalAbort() { abandon(); }

  function finishSegment(connection) {
    if (!alive(connection) || !connection.ready || connection.finishSent) return;
    connection.finishSent = true;
    clear(connection.rotateTimer); clear(connection.pumpTimer); connection.pumpTimer = undefined;
    try {
      // WebSocket preserves ordering: the commit follows every already-sent PCM frame.
      connection.socket.send(JSON.stringify({ type: 'finish' }));
      connection.drainTimer = later(() => fail(new Error('The live transcript did not finish in time. Retry the complete recording.')), 20_000);
    } catch (error) { fail(error); }
  }
  function pump() {
    if (cancelled || failure || drained) return;
    if (!current) { if (queuedSamples) void openSegment(); settle(); return; }
    const connection = current;
    if (!connection.ready || connection.finishSent) return;
    try {
      while (queuedSamples && alive(connection) && !connection.finishSent) {
        const frame = queue[queueHead], available = connection.maxSamples - connection.sentSamples;
        if (available === 0) { finishSegment(connection); break; }
        const length = Math.min(frame.samples - frame.offset, available);
        if (connection.socket.bufferedAmount + length * 2 > SOCKET_BUFFER_LIMIT) {
          if (connection.pumpTimer === undefined) connection.pumpTimer = later(() => { connection.pumpTimer = undefined; pump(); }, 25);
          break;
        }
        const bytes = frame.bytes.slice(frame.offset * 2, (frame.offset + length) * 2);
        connection.socket.send(bytes);
        connection.sentSamples += length; frame.offset += length; queuedSamples -= length;
        if (frame.offset === frame.samples) { queue[queueHead++] = null; }
        if (queueHead === queue.length) { queue = []; queueHead = 0; }
        if (connection.sentSamples === connection.maxSamples) finishSegment(connection);
      }
      if (ending && queuedSamples === 0) finishSegment(connection);
    } catch (error) { fail(error); }
  }

  function validText(value) { return typeof value === 'string' && value.length <= 500_000; }
  function receive(connection, event) {
    if (!alive(connection)) return;
    try {
      if (typeof event.data !== 'string' || event.data.length > 1_000_000) throw new Error('The live service returned an invalid response.');
      const message = JSON.parse(event.data);
      if (!message || typeof message !== 'object') throw new Error('The live service returned an invalid response.');
      if (message.type === 'error') throw new Error(typeof message.message === 'string' ? message.message : 'Live transcription failed. Retry the complete recording.');
      if (message.type === 'ready') {
        if (connection.ready || message.segmentIndex !== segmentIndex || message.sampleRate !== STREAM_RATE ||
            !Number.isSafeInteger(message.maxSamples) || message.maxSamples < 1 || message.maxSamples > STREAM_RATE * 110 ||
            message.transcript !== committedText) throw new Error('The live service returned an unexpected recording session.');
        clear(connection.openTimer); connection.ready = true;
        connection.maxSamples = Math.min(message.maxSamples, SEGMENT_SAMPLE_LIMIT);
        text = message.transcript; progress('Live transcription ready.'); emit(); pump();
      } else if (message.type === 'audio_ack') {
        if (!connection.ready || !Number.isSafeInteger(message.samples) || message.samples < connection.acceptedSamples ||
            message.samples > connection.sentSamples) throw new Error('The live service did not confirm the recorded audio correctly.');
        connection.acceptedSamples = message.samples; emitProgress(); pump();
      } else if (message.type === 'transcript') {
        if (!connection.ready || !validText(message.text)) throw new Error('The live service returned an invalid transcript.');
        text = message.text; emit();
      } else if (message.type === 'segment_complete') {
        if (!connection.finishSent || !validText(message.transcript) || message.nextSequence !== segmentIndex + 1 ||
            message.samples !== connection.sentSamples || message.consumedSamples !== committedSamples + connection.sentSamples) {
          throw new Error('The live service could not confirm all of this recording. Retry the complete recording.');
        }
        committedSamples = message.consumedSamples; committedText = text = message.transcript;
        segmentIndex = message.nextSequence;
        closeConnection(); emit(); pump(); settle();
      } else throw new Error('The live service returned an unexpected response.');
    } catch (error) { fail(error); }
  }
  function connectionDetails() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (callback, value) => {
        if (settled) return;
        settled = true; clear(timer); controller.signal.removeEventListener('abort', abort);
        callback(value);
      };
      const abort = () => done(reject, abortError());
      const timer = later(() => done(reject, new Error('Sign-in could not be confirmed in time. Your recording is still available.')), 15_000);
      controller.signal.addEventListener('abort', abort, { once: true });
      if (controller.signal.aborted) { abort(); return; }
      Promise.resolve().then(() => getConnection({ signal: controller.signal }))
        .then(value => done(resolve, value), error => done(reject, error));
    });
  }
  async function openSegment(force = false) {
    if (!started || current || connecting || cancelled || failure || drained || !force && !queuedSamples) return;
    connecting = true; emit();
    try {
      const credentials = await connectionDetails();
      if (cancelled || failure || controller.signal.aborted) return;
      const url = new URL(credentials?.url);
      if ((url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
          typeof credentials.token !== 'string' || !credentials.token) throw new Error('The live service connection is not configured.');
      const socket = new WebSocketImpl(url.href);
      const connection = { socket, ready: false, finishSent: false, authenticated: false, sentSamples: 0, acceptedSamples: 0,
        maxSamples: 0, listeners: {}, openTimer: undefined, rotateTimer: undefined, drainTimer: undefined, pumpTimer: undefined };
      current = connection;
      connection.listeners.open = () => {
        if (!alive(connection) || connection.authenticated) return;
        connection.authenticated = true;
        try { socket.send(JSON.stringify({ type: 'start', token: credentials.token, recordingId, requestId, segmentIndex })); }
        catch (error) { fail(error); }
      };
      connection.listeners.message = event => receive(connection, event);
      connection.listeners.close = () => { if (alive(connection)) fail(new Error('The live connection closed before the transcript was saved. Retry the complete recording.')); };
      connection.listeners.error = () => { if (alive(connection)) fail(new Error('The live connection was interrupted. Retry the complete recording.')); };
      for (const [type, listener] of Object.entries(connection.listeners)) socket.addEventListener(type, listener);
      connection.openTimer = later(() => fail(new Error('The live connection did not start in time. Your recording is still available.')), 15_000);
      // Also rotate during pauses: the hosted gateway has a bounded wall-clock lifetime.
      connection.rotateTimer = later(() => finishSegment(connection), 95_000);
      if (socket.readyState === 1) connection.listeners.open();
    } catch (error) { fail(error); }
    finally { connecting = false; settle(); }
  }

  function enqueue(samples, stream) {
    if (!samples.length) return;
    const bytes = new ArrayBuffer(samples.length * 2), view = new DataView(bytes);
    for (let index = 0; index < samples.length; index++) {
      const value = Number.isFinite(samples[index]) ? Math.max(-1, Math.min(1, samples[index])) : 0;
      view.setInt16(index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
    }
    checkpointFrame(bytes);
    if (stream) { queue.push({ bytes, samples: samples.length, offset: 0 }); queuedSamples += samples.length; }
  }
  function checkBacklog(targetSamples) {
    const accepted = committedSamples + (current?.acceptedSamples || 0);
    if (targetSamples - accepted > QUEUED_SAMPLE_LIMIT) {
      const error = Object.assign(new Error('The live connection fell behind. Your complete recording is available to retry.'), { code: 'LIVE_BACKLOG_LIMIT' });
      fail(error); throw error;
    }
  }
  function resample(samples, final = false, stream = true) {
    const previousCount = sourceSamples, total = previousCount + samples.length;
    const target = Math.round(total * STREAM_RATE / sampleRate);
    if (stream) checkBacklog(target);
    let frame = new Float32Array(FRAME_SAMPLES), length = 0;
    const at = index => index < previousCount ? lastSourceSample : samples[Math.min(index, total - 1) - previousCount];
    while (outputSamples < target) {
      const position = outputSamples * sampleRate / STREAM_RATE;
      const left = Math.floor(position), fraction = position - left;
      if (!final && (left >= total || fraction > 0 && left + 1 >= total)) break;
      const a = at(Math.min(left, total - 1)), b = fraction ? at(Math.min(left + 1, total - 1)) : a;
      frame[length++] = a + (b - a) * fraction; outputSamples++;
      if (length === FRAME_SAMPLES) { enqueue(frame, stream); frame = new Float32Array(FRAME_SAMPLES); length = 0; }
    }
    if (length) enqueue(frame.subarray(0, length), stream);
    if (samples.length) lastSourceSample = samples[samples.length - 1];
    sourceSamples = total;
  }
  function push(samples) {
    if (cancelled) throw abortError();
    if (failure) throw failure;
    if (ending || completed) throw new Error('This live recording has already stopped.');
    if (!(samples instanceof Float32Array)) throw new TypeError('Provide mono Float32Array microphone samples.');
    if (sourceSamples + samples.length > sampleRate * 600) {
      const error = Object.assign(new RangeError('Live transcription accepts at most ten minutes of recorded audio.'), { code: 'LIVE_AUDIO_LIMIT' });
      fail(error); throw error;
    }
    try { resample(samples); }
    catch (error) {
      // This frame is already captured by the recorder. Preserve it when the
      // network backlog fails before the resampler advances its source count.
      if (error?.code === 'LIVE_BACKLOG_LIMIT' && typeof checkpoint === 'function' && !abandoned) resample(samples, false, false);
      throw error;
    }
    pump(); emitProgress(); return samples.length;
  }
  function captureRemaining(samples) {
    if (abandoned || ending || completed) throw abortError();
    if (!failure && !cancelled) return push(samples);
    if (!(samples instanceof Float32Array)) throw new TypeError('Provide mono Float32Array microphone samples.');
    if (sourceSamples + samples.length > sampleRate * 600) throw Object.assign(new RangeError('Live transcription accepts at most ten minutes of recorded audio.'), { code: 'LIVE_AUDIO_LIMIT' });
    resample(samples, false, false); return samples.length;
  }

  const startup = Promise.resolve().then(async () => {
    if (cancelled || failure) return;
    progress('Connecting live transcription… Your audio is being recorded.');
    startPromise = request('/live-sessions', { method: 'POST', body: { recordingId, requestId, title: 'My rehearsal' } });
    const session = await startPromise;
    validateStart(session); started = true;
    activateCheckpoints();
    if (cancelled) void flushCheckpoints();
    if (!cancelled && !failure) await openSegment(true);
  }).catch(error => {
    if (!started && !abandoned && typeof checkpoint === 'function') {
      checkpointFailed(new Error('Refresh recovery could not start. Keep this page open until the recording is saved.'));
    }
    fail(error);
  }).finally(() => { initializing = false; settle(); });

  if (signal?.aborted) abandon();
  else signal?.addEventListener('abort', externalAbort, { once: true });

  return {
    push, captureRemaining, getState, cancel, abandon,
    finish(blob) {
      if (finishPromise) return finishPromise;
      finishPromise = (async () => {
        keepTake();
        ending = true;
        const drain = new Promise((resolve, reject) => { resolveDrain = resolve; rejectDrain = reject; });
        try {
          if (!failure && !cancelled) { resample(new Float32Array(0), true); emit(); pump(); }
          else if (typeof checkpoint === 'function' && !abandoned) resample(new Float32Array(0), true, false);
        } catch (error) {
          fail(error);
          if (error?.code === 'LIVE_BACKLOG_LIMIT' && typeof checkpoint === 'function' && !abandoned) resample(new Float32Array(0), true, false);
        }
        const checkpointing = flushCheckpoints();
        settle();
        try { await drain; } catch { /* Preserve the recording after a failed or cancelled stream. */ }
        await startup;
        await checkpointing;
        await flushCheckpoints();
        keepTake();
        if (!started) throw failure || (cancelled ? abortError() : new Error('The live session could not start. Retry the saved recording.'));
        await cancellation;
        keepTake();
        // A failed transcript can still retain the take for an explicit complete-audio retry.
        const audio = await saveAudio(blob);
        keepTake();
        const result = await send('/finish', { method: 'POST', body: audio });
        keepTake();
        if (result.recordingId !== recordingId || typeof result.text !== 'string') throw new Error('The saved transcript could not be confirmed.');
        completed = true; signal?.removeEventListener('abort', externalAbort); clear(progressTimer);
        if (failure || cancelled || result.complete !== true) return { ...result, complete: false };
        text = result.text; emit(); return result;
      })();
      return finishPromise;
    },
  };
}
