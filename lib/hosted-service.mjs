import { buildAnalysisPrompt, buildCoachingInstructions } from './analysis-core.mjs';
import { createHostedLiveSession } from './hosted-live.mjs';
import { browserRecoveryStorage, createPendingRequests, recoverPendingRequest } from './hosted-recovery.mjs';
import { createHostedDraftStore } from './hosted-drafts.mjs';

const MAX_BYTES = 20 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const PROGRESS_STAGES = {
  '/transcribe': ['accepted', 'audio_validated', 'speech_requested', 'transcript_received', 'saved'],
  '/analyze-text': ['accepted', 'coach_requested', 'feedback_received', 'feedback_validated', 'saved'],
};

async function readChatResponse(response, signal) {
  const reader = response.body?.getReader();
  if (!reader) throw fail('The coach returned an unreadable reply. Retry to recover this message.', 502);
  let text = '', bytes = 0, rejectAbort;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort(signal.reason || new DOMException('The operation was canceled.', 'AbortError'));
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { value, done } = await Promise.race([reader.read(), aborted]);
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 32768) throw fail('The coach returned an oversized reply. Retry to recover this message.', 502);
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    try { return JSON.parse(text); } catch { throw fail('The coach returned an unreadable reply. Retry to recover this message.', 502); }
  } finally {
    signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); reader.releaseLock();
  }
}

async function readProgress(response, path, onProgress, signal) {
  const reader = response.body?.getReader();
  if (!reader) throw fail('The cloud progress connection ended before a result arrived. Retry to recover this request.', 502);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '', bytes = 0, frames = 0, stage = 0, cached = false, terminal;
  const invalid = () => fail('The cloud progress response was incomplete or unreadable. Retry to recover this request.', 502);
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort(signal.reason || new DOMException('The operation was canceled.', 'AbortError'));
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { value, done } = await Promise.race([reader.read(), aborted]);
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw invalid();
      pending += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (++frames > 16 || terminal) throw invalid();
        let event; try { event = JSON.parse(line); } catch { throw invalid(); }
        if (!event || typeof event !== 'object' || Array.isArray(event)) throw invalid();
        if (event.type === 'progress') {
          if (Object.keys(event).some(key => !['type', 'stage'].includes(key))) throw invalid();
          if (!stage && event.stage === 'cached_result') { cached = true; stage++; }
          else if (!cached && event.stage === PROGRESS_STAGES[path]?.[stage]) stage++;
          else throw invalid();
          try { onProgress(event); } catch { /* A display callback cannot fail the saved job. */ }
        } else if (event.type === 'result') {
          if ((!cached && stage !== PROGRESS_STAGES[path]?.length) || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) throw invalid();
          terminal = event;
        } else if (event.type === 'error') {
          if (typeof event.error !== 'string' || event.error.length > 500 || !Number.isInteger(event.status) || event.status < 400 || event.status > 599 ||
              (event.jobState !== undefined && !['failed', 'cancelled', 'not_started'].includes(event.jobState))) throw invalid();
          terminal = event;
        } else throw invalid();
      }
    }
    pending += decoder.decode();
    if (pending || !terminal) throw invalid();
    if (terminal.type === 'error') {
      const error = fail(terminal.error, terminal.status);
      if (terminal.jobState) error.jobState = terminal.jobState;
      throw error;
    }
    return terminal.data;
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof TypeError) throw invalid();
    throw error;
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}

export function readHostedConfig(env = {}) {
  const url = String(env.VITE_SUPABASE_URL || '').trim();
  const publishableKey = String(env.VITE_SUPABASE_PUBLISHABLE_KEY || '').trim();
  if (!url && !publishableKey) return null;
  let parsed;
  try { parsed = new URL(url); } catch { throw fail('The hosted app configuration is incomplete. Contact the pilot organizer.'); }
  if ((!['localhost', '127.0.0.1'].includes(parsed.hostname) && parsed.protocol !== 'https:') ||
      !['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/' ||
      !/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)) {
    throw fail('Use a Supabase project URL and public publishable key for this website. Never put a secret key in the website configuration.');
  }
  return { url: parsed.origin, publishableKey };
}

function jsonBody(body) {
  if (typeof body === 'string') {
    if (body.length > 512 * 1024) throw fail('The request is too large.', 413);
    try { body = JSON.parse(body); } catch { throw fail('The request was not valid JSON.'); }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('Send a JSON object.');
  return body;
}

/** Authenticated transport only. AI credentials and model choices belong to the server. */
export function createHostedService({ client, url, publishableKey, policyText, fetchImpl = globalThis.fetch, uuid = () => crypto.randomUUID(), recoveryStorage = browserRecoveryStorage(), draftStoreFactory = globalThis.indexedDB ? createHostedDraftStore : null }) {
  const configuration = readHostedConfig({ VITE_SUPABASE_URL: url, VITE_SUPABASE_PUBLISHABLE_KEY: publishableKey });
  const base = `${configuration.url}/functions/v1/rehearsal-api`;
  const policy = buildCoachingInstructions(policyText);
  const uploads = new WeakMap();
  const uploadAttempts = new WeakMap();
  const deleted = new Set();
  const transcriptRequests = new Map();
  const active = new Set();
  const activeRequests = new Set();
  const pendingRequests = createPendingRequests(recoveryStorage, configuration.url);
  let progress;
  let recordingSaved;
  let disposed = false;
  let accountGeneration = 0;
  let currentUser = '';
  let authInitialized = false;
  let analysisRequest = null;
  let workGeneration = 0, cancelling = false, cancelPromise = null;
  const liveConnections = new Set();
  const draftStores = new Set();
  const draftStarts = new Set();
  const draftIdentity = marker => ({ ownerId: marker.userId, recordingId: marker.recordingId, requestId: marker.requestId });
  function newDraftStore(onWarning) {
    if (!draftStoreFactory) return null;
    const store = draftStoreFactory({ project: configuration.url, onWarning });
    draftStores.add(store); return store;
  }
  function closeDraft(store) { if (!store) return; store.close(); draftStores.delete(store); }
  function closeDrafts() { for (const store of draftStores) closeDraft(store); }
  async function removeDraft(marker) {
    const store = newDraftStore();
    try { await store?.remove(draftIdentity(marker)); } finally { closeDraft(store); }
  }

  async function beginRequest(recordingId, requestId, kind, signal, expectedWork = workGeneration) {
    const generation = accountGeneration;
    const session = await identity(generation, signal);
    if (cancelling || expectedWork !== workGeneration) throw new DOMException('This request was canceled.', 'AbortError');
    if (!session) throw fail('Sign in before processing your recording.', 401);
    const previous = pendingRequests.read(session.user.id);
    const marker = pendingRequests.save({ userId: session.user.id, recordingId, requestId, kind,
      createdAt: previous?.requestId === requestId ? previous.createdAt : Date.now(), phase: 'active' });
    activeRequests.add(requestId);
    return marker;
  }

  async function settleLiveRetry(recordingId, signal, expectedWork) {
    const generation = accountGeneration, session = await identity(generation, signal);
    if (!session || cancelling || expectedWork !== workGeneration) throw new DOMException('This request was canceled.', 'AbortError');
    const marker = pendingRequests.read(session.user.id);
    if (marker?.kind !== 'live' || marker.recordingId !== recordingId) return;
    if (activeRequests.has(marker.requestId)) throw fail('Stop the live recording before transcribing the complete take.', 409);
    const result = await remote(`/live-sessions/${recordingId}/cancel`, { method: 'POST', signal, body: { requestId: marker.requestId } });
    guard(generation, signal);
    if (cancelling || expectedWork !== workGeneration) throw new DOMException('This request was canceled.', 'AbortError');
    if (result.recordingId !== recordingId || result.cancelled !== true || !['cancelled', 'failed', 'completed'].includes(result.status)) throw fail('The previous live request could not be stopped. Retry recovery.', 502);
    pendingRequests.clear(marker);
    closeDrafts();
    await removeDraft(marker).catch(() => {});
  }

  function guard(generation, signal) {
    if (disposed) throw fail('This session is closed. Reload the app.', 410);
    signal?.throwIfAborted();
    if (generation !== accountGeneration) throw fail('Your account changed. Sign in again to continue.', 401);
  }
  async function identity(generation = accountGeneration, signal) {
    guard(generation, signal);
    const { data, error } = await client.auth.getSession();
    guard(generation, signal);
    if (error) throw fail('Your sign-in could not be checked. Sign in again.', 401);
    const session = data?.session || null;
    const userId = session?.user?.id || '';
    if (authInitialized && userId !== currentUser) throw fail('Your account changed. Sign in again to continue.', 401);
    if (!authInitialized) { currentUser = userId; authInitialized = true; }
    return session;
  }
  async function remote(path, { method = 'GET', body, signal, headers = {}, onProgress } = {}) {
    const generation = accountGeneration;
    const session = await identity(generation, signal);
    if (!session?.access_token) throw fail('Sign in with Google or Microsoft to use cloud coaching and your private recordings.', 401);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    active.add(controller);
    const streaming = typeof onProgress === 'function' && Object.hasOwn(PROGRESS_STAGES, path);
    const timer = streaming || path === '/coach-chat' ? setTimeout(() => controller.abort(new DOMException('Cloud processing timed out. Retry to recover this request.', 'TimeoutError')), path === '/coach-chat' ? 60000 : 180000) : null;
    try {
      guard(generation, signal);
      const binary = body instanceof Blob;
      const response = await fetchImpl(`${base}${path}`, {
        method, headers: { ...headers, ...(streaming ? { Accept: 'application/x-ndjson' } : {}), apikey: configuration.publishableKey, Authorization: `Bearer ${session.access_token}`, ...(body ? { 'Content-Type': binary ? 'audio/wav' : 'application/json' } : {}) },
        ...(body ? { body: binary ? body : JSON.stringify(body) } : {}), signal: controller.signal,
      });
      const result = response.ok && streaming && response.headers.get('content-type')?.split(';')[0] === 'application/x-ndjson'
        ? await readProgress(response, path, event => { guard(generation, controller.signal); onProgress(event); }, controller.signal)
        : path === '/coach-chat' ? await readChatResponse(response, controller.signal) : await response.json().catch(() => null);
      guard(generation, controller.signal);
      if (!response.ok) {
        const error = fail(typeof result?.error === 'string' ? result.error.slice(0, 500) : typeof result?.error?.message === 'string' ? result.error.message.slice(0, 500) : response.status === 401 ? 'Your sign-in expired. Sign in again.' : 'The cloud service could not complete this request. Please try again.', response.status);
        if (['failed', 'cancelled', 'not_started'].includes(result?.jobState)) error.jobState = result.jobState;
        throw error;
      }
      if (!result || typeof result !== 'object') throw fail('The cloud service returned an unreadable response.', 502);
      return result;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); active.delete(controller); }
  }
  const signedOutConfig = () => ({ hosted: true, configured: true, localSpeech: false, liveTranscription: false,
    speechConfigured: false, analysisConfigured: false, auth: { signedIn: false }, retention: 'private',
    transcriptionModel: 'gpt-live-transcribe', analysisProvider: 'hosted', analysisProviderLabel: 'Neeley AI coach', analysisModel: '', providers: [],
    maxDurationSeconds: 600, maxAudioBytes: MAX_BYTES });

  async function audioMetadata(blob, generation, signal) {
    if (!blob || typeof blob.arrayBuffer !== 'function' || !blob.size || blob.size > MAX_BYTES) throw fail('Choose a recording of up to 10 minutes and 20 MB.', 413);
    const bytes = new DataView(await blob.slice(0, 44).arrayBuffer());
    guard(generation, signal);
    const ascii = (start, count) => String.fromCharCode(...new Uint8Array(bytes.buffer, start, count));
    if (bytes.byteLength < 44 || ascii(0, 4) !== 'RIFF' || bytes.getUint32(4, true) !== blob.size - 8 || ascii(8, 4) !== 'WAVE' || ascii(12, 4) !== 'fmt ' || bytes.getUint32(16, true) !== 16 ||
        bytes.getUint16(20, true) !== 1 || bytes.getUint16(22, true) !== 1 || bytes.getUint32(24, true) !== 16000 || bytes.getUint32(28, true) !== 32000 || bytes.getUint16(32, true) !== 2 || bytes.getUint16(34, true) !== 16 || ascii(36, 4) !== 'data' ||
        (blob.size - 44) % 2 ||
        bytes.getUint32(40, true) !== blob.size - 44) throw fail('Prepare this recording in the app before uploading it.');
    const durationSeconds = (blob.size - 44) / 32000;
    if (durationSeconds < 0.5 || durationSeconds > 600) throw fail('Use a recording between half a second and 10 minutes.');
    return { durationSeconds, sizeBytes: blob.size };
  }

  async function storeAudio(attempt, blob, signal) {
    const { id, userId, generation } = attempt;
    const expected = await audioMetadata(blob, generation, signal);
    if (!attempt.reserved) {
      const metadata = await remote('/recordings', { method: 'POST', signal, body: { id, title: 'My rehearsal', ...expected } });
      guard(generation, signal);
      if (metadata.id !== id || metadata.bucket !== 'recordings' || metadata.storagePath !== `${userId}/${id}/audio.wav`) throw fail('The cloud upload location was not valid.', 502);
      attempt.reserved = true;
    }
    progress?.('Saving this recording privately to your account…');
    guard(generation, signal);
    let stored;
    try { stored = await remote(`/recordings/${id}/audio`, { method: 'POST', body: blob, signal }); }
    catch (error) {
      // Only definite format rejection proves no bytes were stored. An uncertain
      // upload reuses this ID on retry instead of deleting a potentially saved take.
      if ([400, 413, 415].includes(error.status) && generation === accountGeneration && !disposed && !signal?.aborted) {
        try { await remote(`/recordings/${id}`, { method: 'DELETE' }); uploadAttempts.delete(blob); }
        catch { /* Empty reservations expire if cleanup cannot complete. */ }
      }
      throw error;
    }
    guard(generation, signal);
    if (stored.id !== id || stored.stored !== true || stored.sizeBytes !== expected.sizeBytes ||
        typeof stored.durationSeconds !== 'number' || !Number.isFinite(stored.durationSeconds) || Math.abs(stored.durationSeconds - expected.durationSeconds) > 0.000001) throw fail('The cloud could not confirm the saved recording.', 502);
    uploads.set(blob, { id, userId });
    recordingSaved?.(blob, id);
    return expected;
  }

  async function uploadAudio(blob, signal) {
    const generation = accountGeneration;
    guard(generation, signal);
    if (!blob || typeof blob.arrayBuffer !== 'function' || !blob.size || blob.size > MAX_BYTES) throw fail('Choose a recording of up to 10 minutes and 20 MB.', 413);
    const session = await identity(generation, signal);
    if (!session) throw fail('Sign in before saving this recording to your private account.', 401);
    const saved = uploads.get(blob);
    if (saved?.userId === session.user.id && !deleted.has(saved.id)) return saved.id;
    let attempt = uploadAttempts.get(blob);
    if (!attempt || attempt.generation !== generation || attempt.userId !== session.user.id || deleted.has(attempt.id)) {
      attempt = { id: uuid(), userId: session.user.id, generation, reserved: false };
      uploadAttempts.set(blob, attempt);
    }
    if (!attempt.promise) attempt.promise = storeAudio(attempt, blob, signal).finally(() => { attempt.promise = null; });
    await attempt.promise;
    guard(generation, signal);
    return attempt.id;
  }

  async function dispatch(path, options = {}) {
    const expectedWork = workGeneration;
    if (path === '/api/config') {
      if (!(await identity())) return signedOutConfig();
      return { ...signedOutConfig(), ...await remote('/config', options), hosted: true, localSpeech: false };
    }
    if (path === '/api/prompt-preview') return { prompt: buildAnalysisPrompt(jsonBody(options.body), policy) };
    if (path === '/api/coach-chat') {
      const body = jsonBody(options.body);
      if (options.method !== 'POST' || !UUID.test(body.requestId || '')) throw fail('Send a chat message with a valid request ID.');
      const result = await remote('/coach-chat', { method: 'POST', body, signal: options.signal });
      if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).some(key => !['requestId', 'model', 'reply'].includes(key)) ||
          result.requestId !== body.requestId || result.model !== 'gpt-6-luna' || typeof result.reply !== 'string' || !result.reply.trim() || result.reply.length > 4000) {
        throw fail('The coach returned an unreadable reply. Retry to recover this message.', 502);
      }
      return result;
    }
    if (path === '/api/transcribe') {
      const recordingId = await uploadAudio(options.body, options.signal);
      await settleLiveRetry(recordingId, options.signal, expectedWork);
      progress?.('Transcribing your complete recording in the cloud…');
      if (!transcriptRequests.has(recordingId)) transcriptRequests.set(recordingId, uuid());
      const marker = await beginRequest(recordingId, transcriptRequests.get(recordingId), 'transcribe', options.signal, expectedWork);
      try {
        const result = await remote('/transcribe', { method: 'POST', signal: options.signal, onProgress: options.onProgress, body: { recordingId, requestId: marker.requestId } });
        pendingRequests.clear(marker); return result;
      }
      catch (error) {
        if (['failed', 'cancelled', 'not_started'].includes(error.jobState)) { transcriptRequests.delete(recordingId); pendingRequests.clear(marker); }
        throw error;
      } finally { activeRequests.delete(marker.requestId); }
    }
    if (path === '/api/analyze-text') {
      const body = jsonBody(options.body);
      if (!UUID.test(body.recordingId || '')) throw fail('Save and transcribe this recording before requesting coaching.');
      const signature = JSON.stringify(body);
      if (analysisRequest?.signature !== signature) analysisRequest = { signature, id: uuid() };
      const attempt = analysisRequest;
      const marker = await beginRequest(body.recordingId, attempt.id, 'coach', options.signal, expectedWork);
      try {
        const result = await remote('/analyze-text', { method: 'POST', signal: options.signal, onProgress: options.onProgress, body: { ...body, requestId: attempt.id } });
        // Keep IDs only while the outcome is uncertain. A later explicit Update
        // feedback must regenerate coaching even when the transcript is unchanged.
        if (analysisRequest === attempt) analysisRequest = null;
        pendingRequests.clear(marker); return result;
      }
      catch (error) {
        if (['failed', 'cancelled', 'not_started'].includes(error.jobState)) { if (analysisRequest === attempt) analysisRequest = null; pendingRequests.clear(marker); }
        throw error;
      } finally { activeRequests.delete(marker.requestId); }
    }
    if (path === '/api/events') return remote('/events', { method: 'POST', body: jsonBody(options.body), signal: options.signal });
    if (/^\/api\/requests\/[0-9a-f-]{36}$/.test(path) && (!options.method || options.method === 'GET')) return remote(path.slice(4), options);
    if (/^\/api\/recordings(?:\/[0-9a-f-]{36})?$/.test(path)) {
      const result = await remote(path.slice(4), options);
      if (options.method === 'DELETE') deleted.add(path.split('/').pop());
      return result;
    }
    throw fail('This cloud app action does not exist.', 404);
  }

  async function request(path, options = {}) {
    const generation = accountGeneration;
    guard(generation, options.signal);
    const result = await dispatch(path, options);
    guard(generation, options.signal);
    return result;
  }

  const service = {
    hosted: true, request,
    cancelCurrentRequest({ signal } = {}) {
      if (cancelPromise) return cancelPromise;
      const generation = accountGeneration;
      cancelling = true; workGeneration++;
      active.forEach(controller => controller.abort());
      liveConnections.forEach(controller => controller.abort());
      closeDrafts();
      cancelPromise = (async () => {
        const session = await identity(generation, signal);
        const marker = session && pendingRequests.read(session.user.id);
        if (!marker) return { cancelled: true };
        pendingRequests.save({ ...marker, phase: 'cancelling' });
        const path = marker.kind === 'live' ? `/live-sessions/${marker.recordingId}/cancel` : `/requests/${marker.requestId}/cancel`;
        const result = await remote(path, { method: 'POST', signal,
          body: marker.kind === 'live' ? { requestId: marker.requestId } : { recordingId: marker.recordingId } });
        guard(generation, signal);
        if (result.recordingId !== marker.recordingId || result.cancelled !== true ||
            marker.kind !== 'live' && (result.requestId !== marker.requestId || !['cancelled', 'completed', 'failed'].includes(result.state))) {
          throw fail('Cancellation could not be confirmed. Your recording is still here; try again.', 502);
        }
        pendingRequests.clear(marker); activeRequests.delete(marker.requestId);
        if (marker.kind === 'live') {
          await Promise.allSettled([...draftStarts]);
          await removeDraft(marker).catch(() => {});
        }
        transcriptRequests.delete(marker.recordingId); analysisRequest = null;
        return result;
      })().finally(() => { cancelling = false; cancelPromise = null; });
      return cancelPromise;
    },
    async getPendingRequest() {
      const session = await identity();
      const marker = session && pendingRequests.read(session.user.id);
      return marker && !activeRequests.has(marker.requestId) ? marker : null;
    },
    async recoverPending(marker, { signal, onProgress, wait, attempts } = {}) {
      const generation = accountGeneration;
      const session = await identity(generation, signal);
      if (!session || session.user.id !== marker?.userId || pendingRequests.read(session.user.id)?.requestId !== marker.requestId) throw fail('This request belongs to a different account or session.', 401);
      if (activeRequests.has(marker.requestId)) throw fail('This request is already being handled in this tab.', 409);
      activeRequests.add(marker.requestId);
      const controller = new AbortController();
      active.add(controller);
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => controller.abort(new DOMException('Recovery could not reconnect before its deadline. Retry recovery to check the request.', 'TimeoutError')), 660000);
      try {
        const result = await recoverPendingRequest(marker, {
          signal: controller.signal, onProgress, wait, attempts,
          request: (path, options) => { guard(generation, options.signal); return remote(path, options); },
          openRecording: (id, options) => { guard(generation, options.signal); return service.openRecording(id, options); },
          async recoverLiveDraft() {
            const store = newDraftStore();
            if (!store) return null;
            try {
              let key;
              try { key = await remote(`/live-sessions/${marker.recordingId}/draft-key/${marker.requestId}`, { signal: controller.signal }); }
              catch (error) { if (error.status === 404) return null; throw error; }
              guard(generation, controller.signal);
              if (key.recordingId !== marker.recordingId || key.requestId !== marker.requestId || typeof key.draftKey !== 'string') throw fail('The interrupted recording could not be verified.', 502);
              const draft = await store.load(draftIdentity(marker), key.draftKey);
              guard(generation, controller.signal);
              if (!draft) return null;
              if (Number.isFinite(draft.durationSeconds) && draft.durationSeconds < 0.5) {
                await store.remove(draftIdentity(marker));
                guard(generation, controller.signal);
                return null;
              }
              onProgress?.('Restoring the saved portion of your interrupted recording…');
              const attempt = { id: marker.recordingId, userId: session.user.id, generation, reserved: true };
              uploadAttempts.set(draft.blob, attempt);
              const audio = await storeAudio(attempt, draft.blob, controller.signal);
              guard(generation, controller.signal);
              const result = await remote(`/live-sessions/${marker.recordingId}/finish`, { method: 'POST', body: audio, signal: controller.signal });
              guard(generation, controller.signal);
              if (result.recordingId !== marker.recordingId || typeof result.text !== 'string') throw fail('The recovered recording could not be confirmed.', 502);
              const record = await service.openRecording(marker.recordingId, { signal: controller.signal });
              guard(generation, controller.signal);
              if (result.complete !== true) { record.transcript = ''; record.report = null; }
              await store.remove(draftIdentity(marker));
              guard(generation, controller.signal);
              return record;
            } finally { closeDraft(store); }
          },
        });
        guard(generation, controller.signal);
        pendingRequests.clear(marker);
        // Recovery has confirmed a terminal result, just like a direct response.
        if (marker.kind === 'coach' && analysisRequest?.id === marker.requestId) analysisRequest = null;
        if (marker.kind === 'live') await removeDraft(marker).catch(() => {});
        guard(generation, controller.signal);
        return result;
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); active.delete(controller); activeRequests.delete(marker.requestId); }
    },
    startLiveSession(options = {}) {
      const generation = accountGeneration, recordingId = uuid(), requestId = uuid();
      const expectedWork = workGeneration;
      let ownerId, uploadPromise, marker;
      const warnRecovery = () => options.onRecoveryWarning?.('Refresh recovery is unavailable for this take. Keep this tab open until you press Stop, or download the recording.');
      let draft = newDraftStore(warnRecovery);
      const validateLocation = session => {
        if (!currentUser || session.recordingId !== recordingId || session.bucket !== 'recordings' || session.storagePath !== `${currentUser}/${recordingId}/audio.wav`) throw fail('The live recording location was not valid.', 502);
        ownerId = currentUser;
      };
      const liveController = new AbortController();
      liveConnections.add(liveController);
      return createHostedLiveSession({ ...options, recordingId, requestId,
        signal: liveController.signal,
        checkpoint: bytes => draft?.append(bytes),
        checkpointFlush: () => draft?.flush(),
        onCheckpointError: warnRecovery,
        async getConnection({ signal } = {}) {
          liveController.signal.throwIfAborted();
          const session = await identity(generation, signal);
          guard(generation, liveController.signal);
          if (!session?.access_token || cancelling || expectedWork !== workGeneration) throw fail('Sign in again to resume live transcription.', 401);
          return { url: `${base.replace(/^http/, 'ws')}/live-stream`, token: session.access_token };
        },
        request: async (path, settings) => {
          guard(generation, settings?.signal);
          if (path === '/live-sessions') marker = await beginRequest(recordingId, requestId, 'live', settings?.signal, expectedWork);
          let result;
          try { result = await remote(path, settings); }
          catch (error) { if (path === '/live-sessions' || path.endsWith('/finish') || path.endsWith('/cancel')) activeRequests.delete(requestId); throw error; }
          guard(generation, settings?.signal);
          if (path === '/live-sessions') {
            validateLocation(result);
            const startingDraft = draft;
            let beginning;
            try {
              if (startingDraft) {
                beginning = Promise.resolve(startingDraft.begin(draftIdentity(marker), result.draftKey));
                draftStarts.add(beginning); await beginning;
              } else warnRecovery();
            } catch { closeDraft(startingDraft); draft = null; if (!liveController.signal.aborted && generation === accountGeneration) warnRecovery(); }
            finally { if (beginning) draftStarts.delete(beginning); }
            if (disposed || liveController.signal.aborted || generation !== accountGeneration || expectedWork !== workGeneration) {
              closeDraft(startingDraft); draft = null;
              await removeDraft(marker).catch(() => {});
              guard(generation, liveController.signal);
              throw new DOMException('This recording was canceled.', 'AbortError');
            }
            guard(generation, settings?.signal);
          }
          if (path.endsWith('/cancel') && (result.recordingId !== recordingId || result.cancelled !== true)) throw fail('Cancellation could not be confirmed. Retry recovery.', 502);
          if (path.endsWith('/cancel') || path.endsWith('/finish')) {
            liveConnections.delete(liveController);
            if (marker && path.endsWith('/finish') && result.recordingId === recordingId && typeof result.text === 'string') {
              await draft?.remove(draftIdentity(marker)).catch(() => {}); closeDraft(draft); draft = null;
              pendingRequests.clear(marker);
            }
            activeRequests.delete(requestId);
          }
          return result;
        },
        validateStart: validateLocation,
        async saveAudio(blob) {
          guard(generation);
          if (!blob || typeof blob.arrayBuffer !== 'function' || !blob.size || blob.size > MAX_BYTES) throw fail('Choose a recording of up to 10 minutes and 20 MB.', 413);
          if (!uploadPromise) {
            if (marker) marker = pendingRequests.save({ ...marker, phase: 'saving' });
            activeRequests.add(requestId);
            const attempt = { id: recordingId, userId: ownerId, generation, reserved: true };
            uploadAttempts.set(blob, attempt);
            uploadPromise = attempt.promise = storeAudio(attempt, blob).finally(() => { attempt.promise = null; });
          }
          return uploadPromise;
        },
      });
    },
    async getIdentity() { const session = await identity(); return session ? { id: session.user.id } : null; },
    async signIn(provider, redirectTo) {
      if (!['google', 'azure'].includes(provider)) throw fail('Choose Google or Microsoft.');
      const redirect = new URL(redirectTo);
      if (redirect.search || redirect.hash) throw fail('Use the app home page to sign in.');
      const { error } = await client.auth.signInWithOAuth({ provider, options: { redirectTo: redirect.href, ...(provider === 'azure' ? { scopes: 'email' } : {}) } });
      if (error) throw fail('Sign-in could not start. Contact the pilot organizer if it continues.');
    },
    async signOut() {
      const user = currentUser;
      const { error } = await client.auth.signOut();
      if (error) throw fail('Sign-out could not finish. Please try again.');
      if (user) { const store = newDraftStore(); try { await store?.clearOwner(user); } finally { closeDraft(store); } }
    },
    onAuthChange(listener) {
      const { data } = client.auth.onAuthStateChange((_event, session) => {
        const userId = session?.user?.id || '';
        if (authInitialized && userId !== currentUser) { accountGeneration++; active.forEach(controller => controller.abort()); liveConnections.forEach(controller => controller.abort()); liveConnections.clear(); closeDrafts(); activeRequests.clear(); transcriptRequests.clear(); analysisRequest = null; }
        currentUser = userId; authInitialized = true;
        // Avoid invoking Supabase methods while its auth callback holds the session lock.
        setTimeout(() => { if (!disposed) listener(userId ? { id: userId } : null); }, 0);
      });
      return () => data.subscription.unsubscribe();
    },
    async openRecording(id, { signal } = {}) {
      if (!UUID.test(id)) throw fail('Choose a saved recording.');
      const generation = accountGeneration;
      const controller = new AbortController(), abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      active.add(controller);
      try {
        guard(generation, signal);
        id = id.toLowerCase();
        const detail = await remote(`/recordings/${id}`, { signal: controller.signal });
        const session = await identity(generation, controller.signal);
        if (!session) throw fail('Sign in again to open your recording.', 401);
        let audioURL;
        try { audioURL = new URL(detail.audioUrl); } catch { throw fail('The saved audio link was not valid.', 502); }
        if (detail.recording?.id !== id || audioURL.origin !== configuration.url || audioURL.username || audioURL.password || audioURL.hash ||
            audioURL.pathname !== `/storage/v1/object/sign/recordings/${session.user.id}/${id}/audio.wav`) throw fail('The saved audio link was not valid.', 502);
        const response = await fetchImpl(audioURL.href, { signal: controller.signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' });
        guard(generation, controller.signal);
        if (!response.ok) throw fail('The saved audio could not be opened. Try again for a fresh link.');
        const blob = await response.blob();
        guard(generation, controller.signal);
        if (!blob.size || blob.size > MAX_BYTES) throw fail('This saved recording is too large or empty.', 413);
        await identity(generation, controller.signal);
        uploads.set(blob, { id, userId: session.user.id });
        return { ...detail.recording, blob };
      } finally { signal?.removeEventListener('abort', abort); active.delete(controller); }
    },
    setProgressHandler(handler) { progress = typeof handler === 'function' ? handler : null; },
    setRecordingSavedHandler(handler) { recordingSaved = typeof handler === 'function' ? handler : null; },
    dispose() { disposed = true; active.forEach(controller => controller.abort()); liveConnections.forEach(controller => controller.abort()); liveConnections.clear(); closeDrafts(); active.clear(); activeRequests.clear(); transcriptRequests.clear(); analysisRequest = null; progress = null; recordingSaved = null; },
  };
  return service;
}
