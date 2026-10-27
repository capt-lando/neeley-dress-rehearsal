const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const failure = message => new Error(message);

export function browserRecoveryStorage() {
  try { if (globalThis.sessionStorage) return globalThis.sessionStorage; } catch { /* Fail before starting unrecoverable work. */ }
  return { getItem: () => null, removeItem() {}, setItem() { throw failure('Session storage is unavailable.'); } };
}

// Only identifiers are persisted, never audio, text, credentials, or preparation.
export function createPendingRequests(storage, project) {
  const key = userId => `neeley-pending:${project}:${userId}`;
  function read(userId) {
    let value;
    try { value = JSON.parse(storage.getItem(key(userId)) || 'null'); } catch { return null; }
    if (!value || value.userId !== userId || !UUID.test(value.requestId || '') || !UUID.test(value.recordingId || '') ||
        !['live', 'transcribe', 'coach'].includes(value.kind) || !Number.isFinite(value.createdAt) ||
        !['active', 'saving', 'saved', 'cancelling'].includes(value.phase)) return null;
    return value;
  }
  function save(value) {
    const previous = read(value.userId);
    if (previous && previous.requestId !== value.requestId) throw failure('Recover the previous request before starting another one. Use Retry recovery below.');
    const clean = { userId: value.userId, requestId: value.requestId, recordingId: value.recordingId,
      kind: value.kind, createdAt: value.createdAt, phase: value.phase || 'active' };
    try { storage.setItem(key(value.userId), JSON.stringify(clean)); }
    catch { throw failure('Your browser cannot save the recovery information needed for cloud processing. Allow session storage, then try again.'); }
    return clean;
  }
  function clear(value) {
    if (read(value.userId)?.requestId !== value.requestId) return;
    try { storage.removeItem(key(value.userId)); } catch { /* A completed marker is safe to reconcile again. */ }
  }
  return { read, save, clear };
}

export function recoveryDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason || new DOMException('Stopped waiting.', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function recoverPendingRequest(marker, { request, openRecording, recoverLiveDraft, signal, onProgress = () => {}, wait = recoveryDelay, attempts = 305, now = () => Date.now() }) {
  if (marker.kind === 'live') {
    onProgress('Canceling the recording interrupted by refresh…');
    const session = await request(`/live-sessions/${marker.recordingId}/cancel`, {
      method: 'POST', body: { requestId: marker.requestId }, signal,
    });
    if (session.recordingId !== marker.recordingId || session.cancelled !== true ||
        !['cancelled', 'completed', 'failed'].includes(session.status) || typeof session.audioSaved !== 'boolean') {
      throw failure('Cancellation could not be confirmed. Retry recovery.');
    }
    if (marker.phase === 'cancelling') return { state: 'cancelled', record: null, message: 'Your cancellation was confirmed. You can start a new take. Your saved rehearsals are unchanged.' };
    const record = session.audioSaved ? await openRecording(marker.recordingId, { signal }) : await recoverLiveDraft?.() || null;
    return { state: 'cancelled', record, message: record ? 'The saved portion of your interrupted recording was restored. The microphone is stopped; you can review it or choose Analyze when ready.' : 'The interrupted recording was canceled. You can start a new take. Audio that was not saved before refresh cannot be restored.' };
  }
  if (marker.phase === 'cancelling') {
    onProgress('Confirming that your previous request stopped…');
    const result = await request(`/requests/${marker.requestId}/cancel`, {
      method: 'POST', body: { recordingId: marker.recordingId }, signal,
    });
    if (result.requestId !== marker.requestId || result.recordingId !== marker.recordingId || result.cancelled !== true ||
        !['cancelled', 'completed', 'failed'].includes(result.state)) throw failure('Cancellation could not be confirmed. Retry recovery.');
    return { state: 'cancelled', record: null, message: 'Your cancellation was confirmed. You can start a new take. Your saved rehearsals are unchanged.' };
  }
  onProgress(marker.kind === 'coach' ? 'Reconnecting to your coaching request…' : 'Reconnecting to your transcription request…');
  let transientFailures = 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    signal?.throwIfAborted();
    let job;
    try { job = await request(`/requests/${marker.requestId}`, { signal }); transientFailures = 0; }
    catch (error) {
      if (error.status === 404) {
        if (now() - marker.createdAt > 600000) return { state: 'expired', record: await openRecording(marker.recordingId, { signal }),
          message: 'The previous request did not start. Your recording was restored and is ready to retry.' };
      } else if (!signal?.aborted && (error instanceof TypeError || error.status >= 500 || error.status === 429) && ++transientFailures <= 3) {
        onProgress('Reconnecting after a temporary connection problem…');
      } else throw error;
    }
    if (job) {
      if (job.requestId !== marker.requestId || job.recordingId !== marker.recordingId || job.kind !== marker.kind ||
          !['reserved', 'completed', 'failed', 'expired', 'cancelled'].includes(job.state)) throw failure('The recovered request could not be verified.');
      if (job.state !== 'reserved') {
        const record = await openRecording(marker.recordingId, { signal });
        if (job.state === 'completed') {
          if (!job.result || typeof job.result !== 'object') throw failure('The completed result could not be recovered.');
          if (marker.kind === 'transcribe') { record.transcript = job.result.text; record.report = null; }
          else { record.transcript = job.result.transcript || record.transcript; record.report = job.result; }
        }
        return { state: job.state, record, message: job.state === 'completed'
          ? marker.kind === 'coach' ? 'Your completed coaching and recording were restored.' : 'Your transcript and recording were restored. Choose Analyze when you are ready for coaching.'
          : 'The previous request stopped. Your recording was restored; you can retry transcription or coaching.' };
      }
      onProgress(marker.kind === 'coach' ? 'Your coaching is still processing. Waiting for the same request…' : 'Your transcript is still processing. Waiting for the same request…');
    }
    if (attempt + 1 < attempts) await wait(2000, signal);
  }
  throw failure('Your request has not finished yet. Retry recovery to reconnect; this will not submit another processing request.');
}
