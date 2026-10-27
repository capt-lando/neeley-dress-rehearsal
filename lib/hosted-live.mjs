import { createLiveTranscription } from './live-transcription.mjs';

// One bounded cloud session owns every chunk and the final saved recording.
export function createHostedLiveSession({ sampleRate, encodeAudio, onUpdate, onProgress,
  recordingId, requestId, request, saveAudio, validateStart }) {
  if (typeof encodeAudio !== 'function') throw new TypeError('Provide the recording WAV encoder.');
  const path = `/live-sessions/${recordingId}`;
  let started = false, cancelled = false, abandoned = false, completed = false, startPromise, cancellation, finishPromise;
  const send = (suffix, options) => request(path + suffix, options);
  const keepTake = () => { if (abandoned) throw Object.assign(new Error('This rehearsal was discarded.'), { name: 'AbortError' }); };
  const queue = createLiveTranscription({
    sampleRate, chunkSeconds: 10, overlapSeconds: 0, maxSeconds: 600, onUpdate,
    prepare: async ({ signal }) => {
      onProgress?.('Starting cloud transcription… Your audio is being recorded.');
      if (cancelled) return;
      // Let creation settle before cancellation deletes its reservation. Aborting
      // this POST could let DELETE arrive before the server creates the session.
      startPromise = request('/live-sessions', { method: 'POST',
        body: { recordingId, requestId, title: 'My rehearsal' } });
      const session = await startPromise;
      validateStart(session);
      started = true;
      if (cancelled) return;
      await send('/prepare', { method: 'POST', signal });
      onProgress?.('Cloud transcription ready.');
    },
    transcribe: async (samples, metadata) => {
      const audio = encodeAudio(samples, sampleRate);
      // A sub-sample final tail at 44.1/48 kHz can round to no 16 kHz audio.
      // The complete WAV also omits it, so do not invent a padded extra sample.
      if (metadata.isFinal && audio.size === 44) return { text: '' };
      const response = await send(`/chunks/${metadata.index}`, { method: 'POST', signal: metadata.signal,
        body: audio, headers: metadata.isFinal ? { 'X-Rehearsal-Final': 'true' } : {} });
      if (response.recordingId !== recordingId || response.sequence !== metadata.index ||
          response.nextSequence !== metadata.index + 1 || typeof response.text !== 'string') {
        throw new Error('The cloud returned an unexpected transcript segment. Your recording is still available.');
      }
      return response;
    },
  });
  function cancel() {
    if (cancelled || completed) return false;
    cancelled = true;
    queue.cancel();
    // The known ID is safe even if the start response was lost. Never use a new ID to retry work.
    cancellation = startPromise?.catch(() => {}).then(() => send('/cancel', { method: 'POST', body: { requestId } })).catch(() => {});
    return true;
  }
  return {
    push: queue.push, getState: queue.getState, cancel,
    abandon() {
      if (abandoned || completed) return false;
      abandoned = true;
      cancel();
      return true;
    },
    finish(blob) {
      if (finishPromise) return finishPromise;
      finishPromise = (async () => {
        keepTake();
        let failure;
        try { await queue.finish(); } catch (error) { failure = error; }
        await startPromise?.catch(() => {});
        keepTake();
        if (!started) throw failure || new Error('The live session could not start. Retry the saved recording.');
        await cancellation;
        keepTake();
        // Even a canceled/failed transcript can retain the complete take for an explicit retry.
        const audio = await saveAudio(blob);
        keepTake();
        const result = await send('/finish', { method: 'POST', body: audio });
        keepTake();
        if (result.recordingId !== recordingId || typeof result.text !== 'string') throw new Error('The saved transcript could not be confirmed.');
        completed = true;
        if (failure || result.complete !== true) return { ...result, complete: false };
        return result;
      })();
      return finishPromise;
    },
  };
}
