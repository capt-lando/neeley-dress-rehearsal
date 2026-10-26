import { buildAnalysisPrompt, buildCoachingInstructions } from './analysis-core.mjs';

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
  async function remote(path, { method = 'GET', body, signal } = {}) {
    const generation = accountGeneration;
    const session = await identity(generation, signal);
    if (!session?.access_token) throw fail('Sign in with Google or Microsoft to use cloud coaching and your private recordings.', 401);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    active.add(controller);
    try {
      guard(generation, signal);
      const response = await fetchImpl(`${base}${path}`, {
        method, headers: { apikey: configuration.publishableKey, Authorization: `Bearer ${session.access_token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal,
      });
      const result = await response.json().catch(() => null);
      guard(generation, controller.signal);
      if (!response.ok) throw fail(typeof result?.error === 'string' ? result.error.slice(0, 500) : typeof result?.error?.message === 'string' ? result.error.message.slice(0, 500) : response.status === 401 ? 'Your sign-in expired. Sign in again.' : 'The cloud service could not complete this request. Please try again.', response.status);
      if (!result || typeof result !== 'object') throw fail('The cloud service returned an unreadable response.', 502);
      return result;
    } finally { signal?.removeEventListener('abort', abort); active.delete(controller); }
  }
  const signedOutConfig = () => ({ hosted: true, configured: true, localSpeech: false, liveTranscription: false,
    speechConfigured: false, analysisConfigured: false, auth: { signedIn: false }, retention: 'private',
    transcriptionModel: 'bark-3.0-plus', analysisProvider: 'hosted', analysisProviderLabel: 'Neeley AI coach', analysisModel: '', providers: [],
    maxDurationSeconds: 600, maxAudioBytes: MAX_BYTES });

  async function uploadAudio(blob, signal) {
    const generation = accountGeneration;
    guard(generation, signal);
    if (!blob || typeof blob.arrayBuffer !== 'function' || !blob.size || blob.size > MAX_BYTES) throw fail('Choose a recording of up to 10 minutes and 20 MB.', 413);
    const session = await identity(generation, signal);
    if (!session) throw fail('Sign in before saving this recording to your private account.', 401);
    const saved = uploads.get(blob);
    if (saved?.userId === session.user.id && !deleted.has(saved.id)) return saved.id;
    const bytes = new DataView(await blob.slice(0, 44).arrayBuffer());
    guard(generation, signal);
    const ascii = (start, count) => String.fromCharCode(...new Uint8Array(bytes.buffer, start, count));
    if (bytes.byteLength < 44 || ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE' || ascii(12, 4) !== 'fmt ' ||
        bytes.getUint16(20, true) !== 1 || bytes.getUint16(22, true) !== 1 || bytes.getUint32(24, true) !== 16000 || bytes.getUint16(34, true) !== 16 || ascii(36, 4) !== 'data' ||
        bytes.getUint32(40, true) !== blob.size - 44) throw fail('Prepare this recording in the app before uploading it.');
    const durationSeconds = (blob.size - 44) / 32000;
    if (durationSeconds < 0.5 || durationSeconds > 600) throw fail('Use a recording between half a second and 10 minutes.');
    guard(generation, signal);
    const id = uuid();
    const metadata = await remote('/recordings', { method: 'POST', signal, body: { id, title: 'My rehearsal', durationSeconds, sizeBytes: blob.size } });
    guard(generation, signal);
    if (metadata.id !== id || metadata.bucket !== 'recordings' || metadata.storagePath !== `${session.user.id}/${id}/audio.wav`) throw fail('The cloud upload location was not valid.', 502);
    progress?.('Saving this recording privately to your account…');
    guard(generation, signal);
    const { error } = await client.storage.from('recordings').upload(metadata.storagePath, blob, { contentType: 'audio/wav', upsert: false });
    guard(generation);
    if (error) {
      await remote(`/recordings/${id}`, { method: 'DELETE' }).catch(() => {});
      throw fail('The recording could not be saved. Your audio is still in this tab. Please try again.');
    }
    uploads.set(blob, { id, userId: session.user.id });
    recordingSaved?.(blob, id);
    signal?.throwIfAborted();
    return id;
  }

  async function dispatch(path, options = {}) {
    if (path === '/api/config') {
      if (!(await identity())) return signedOutConfig();
      return { ...signedOutConfig(), ...await remote('/config', options), hosted: true, localSpeech: false, liveTranscription: false };
    }
    if (path === '/api/prompt-preview') return { prompt: buildAnalysisPrompt(jsonBody(options.body), policy) };
    if (path === '/api/transcribe') {
      const recordingId = await uploadAudio(options.body, options.signal);
      progress?.('Transcribing your complete recording in the cloud…');
      if (!transcriptRequests.has(recordingId)) transcriptRequests.set(recordingId, uuid());
      try { return await remote('/transcribe', { method: 'POST', signal: options.signal, body: { recordingId, requestId: transcriptRequests.get(recordingId) } }); }
      catch (error) {
        if (error.status === 502 || error.status === 409 && error.message.includes('already failed')) transcriptRequests.delete(recordingId);
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
        if (analysisRequest === attempt && (error.status === 502 || error.status === 409 && error.message.includes('already failed'))) analysisRequest = null;
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
