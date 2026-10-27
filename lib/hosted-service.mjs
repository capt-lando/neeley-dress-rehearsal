import { buildAnalysisPrompt, buildCoachingInstructions } from './analysis-core.mjs';
import { createHostedLiveSession } from './hosted-live.mjs';

const MAX_BYTES = 20 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

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
export function createHostedService({ client, url, publishableKey, policyText, fetchImpl = globalThis.fetch, uuid = () => crypto.randomUUID() }) {
  const configuration = readHostedConfig({ VITE_SUPABASE_URL: url, VITE_SUPABASE_PUBLISHABLE_KEY: publishableKey });
  const base = `${configuration.url}/functions/v1/rehearsal-api`;
  const policy = buildCoachingInstructions(policyText);
  const uploads = new WeakMap();
  const uploadAttempts = new WeakMap();
  const deleted = new Set();
  const transcriptRequests = new Map();
  const active = new Set();
  let progress;
  let recordingSaved;
  let disposed = false;
  let accountGeneration = 0;
  let currentUser = '';
  let authInitialized = false;
  let analysisRequest = null;

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
  async function remote(path, { method = 'GET', body, signal, headers = {} } = {}) {
    const generation = accountGeneration;
    const session = await identity(generation, signal);
    if (!session?.access_token) throw fail('Sign in with Google or Microsoft to use cloud coaching and your private recordings.', 401);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    active.add(controller);
    try {
      guard(generation, signal);
      const binary = body instanceof Blob;
      const response = await fetchImpl(`${base}${path}`, {
        method, headers: { ...headers, apikey: configuration.publishableKey, Authorization: `Bearer ${session.access_token}`, ...(body ? { 'Content-Type': binary ? 'audio/wav' : 'application/json' } : {}) },
        ...(body ? { body: binary ? body : JSON.stringify(body) } : {}), signal: controller.signal,
      });
      const result = await response.json().catch(() => null);
      guard(generation, controller.signal);
      if (!response.ok) {
        const error = fail(typeof result?.error === 'string' ? result.error.slice(0, 500) : typeof result?.error?.message === 'string' ? result.error.message.slice(0, 500) : response.status === 401 ? 'Your sign-in expired. Sign in again.' : 'The cloud service could not complete this request. Please try again.', response.status);
        if (result?.jobState === 'failed') error.jobState = 'failed';
        throw error;
      }
      if (!result || typeof result !== 'object') throw fail('The cloud service returned an unreadable response.', 502);
      return result;
    } finally { signal?.removeEventListener('abort', abort); active.delete(controller); }
  }
  const signedOutConfig = () => ({ hosted: true, configured: true, localSpeech: false, liveTranscription: false,
    speechConfigured: false, analysisConfigured: false, auth: { signedIn: false }, retention: 'private',
    transcriptionModel: 'bark-3.0-plus', analysisProvider: 'hosted', analysisProviderLabel: 'Neeley AI coach', analysisModel: '', providers: [],
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
    if (path === '/api/config') {
      if (!(await identity())) return signedOutConfig();
      return { ...signedOutConfig(), ...await remote('/config', options), hosted: true, localSpeech: false };
    }
    if (path === '/api/prompt-preview') return { prompt: buildAnalysisPrompt(jsonBody(options.body), policy) };
    if (path === '/api/transcribe') {
      const recordingId = await uploadAudio(options.body, options.signal);
      progress?.('Transcribing your complete recording in the cloud…');
      if (!transcriptRequests.has(recordingId)) transcriptRequests.set(recordingId, uuid());
      try { return await remote('/transcribe', { method: 'POST', signal: options.signal, body: { recordingId, requestId: transcriptRequests.get(recordingId) } }); }
      catch (error) {
        if (error.jobState === 'failed') transcriptRequests.delete(recordingId);
        throw error;
      }
    }
    if (path === '/api/analyze-text') {
      const body = jsonBody(options.body);
      if (!UUID.test(body.recordingId || '')) throw fail('Save and transcribe this recording before requesting coaching.');
      const signature = JSON.stringify(body);
      if (analysisRequest?.signature !== signature) analysisRequest = { signature, id: uuid() };
      const attempt = analysisRequest;
      try { return await remote('/analyze-text', { method: 'POST', signal: options.signal, body: { ...body, requestId: attempt.id } }); }
      catch (error) {
        if (analysisRequest === attempt && error.jobState === 'failed') analysisRequest = null;
        throw error;
      }
    }
    if (path === '/api/events') return remote('/events', { method: 'POST', body: jsonBody(options.body), signal: options.signal });
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

  return {
    hosted: true, request,
    startLiveSession(options) {
      const generation = accountGeneration, recordingId = uuid(), requestId = uuid();
      let ownerId, uploadPromise;
      return createHostedLiveSession({ ...options, recordingId, requestId,
        request: async (path, settings) => {
          guard(generation, settings?.signal);
          const result = await remote(path, settings);
          guard(generation, settings?.signal);
          return result;
        },
        validateStart(session) {
          if (!currentUser || session.recordingId !== recordingId || session.bucket !== 'recordings' ||
              session.storagePath !== `${currentUser}/${recordingId}/audio.wav`) throw fail('The live recording location was not valid.', 502);
          ownerId = currentUser;
        },
        async saveAudio(blob) {
          guard(generation);
          if (!blob || typeof blob.arrayBuffer !== 'function' || !blob.size || blob.size > MAX_BYTES) throw fail('Choose a recording of up to 10 minutes and 20 MB.', 413);
          if (!uploadPromise) {
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
    async signOut() { const { error } = await client.auth.signOut(); if (error) throw fail('Sign-out could not finish. Please try again.'); },
    onAuthChange(listener) {
      const { data } = client.auth.onAuthStateChange((_event, session) => {
        const userId = session?.user?.id || '';
        if (authInitialized && userId !== currentUser) { accountGeneration++; active.forEach(controller => controller.abort()); transcriptRequests.clear(); analysisRequest = null; }
        currentUser = userId; authInitialized = true;
        // Avoid invoking Supabase methods while its auth callback holds the session lock.
        setTimeout(() => { if (!disposed) listener(userId ? { id: userId } : null); }, 0);
      });
      return () => data.subscription.unsubscribe();
    },
    async openRecording(id, { signal } = {}) {
      if (!UUID.test(id)) throw fail('Choose a saved recording.');
      const generation = accountGeneration;
      const detail = await remote(`/recordings/${id}`, { signal });
      guard(generation, signal);
      const audioURL = new URL(detail.audioUrl);
      if (audioURL.origin !== configuration.url || !audioURL.pathname.startsWith('/storage/v1/object/sign/recordings/')) throw fail('The saved audio link was not valid.', 502);
      const response = await fetchImpl(audioURL.href, { signal });
      guard(generation, signal);
      if (!response.ok) throw fail('The saved audio could not be opened. Try again for a fresh link.');
      const blob = await response.blob();
      guard(generation, signal);
      if (!blob.size || blob.size > MAX_BYTES) throw fail('This saved recording is too large or empty.', 413);
      const session = await identity(generation, signal);
      if (!session) throw fail('Sign in again to open your recording.', 401);
      uploads.set(blob, { id, userId: session.user.id });
      return { ...detail.recording, blob };
    },
    setProgressHandler(handler) { progress = typeof handler === 'function' ? handler : null; },
    setRecordingSavedHandler(handler) { recordingSaved = typeof handler === 'function' ? handler : null; },
    dispose() { disposed = true; active.forEach(controller => controller.abort()); active.clear(); transcriptRequests.clear(); analysisRequest = null; progress = null; recordingSaved = null; },
  };
}
