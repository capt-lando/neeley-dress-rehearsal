import { analyzeSpeech, buildAnalysisPrompt, buildCoachingInstructions, coachingCompletion } from './analysis-core.mjs';
import { PROVIDERS, requestCoaching } from './providers.mjs';
import { BARK_MODEL_ID, isBarkModel } from './speech-models.mjs';

const PROVIDER_IDS = ['openai', 'anthropic', 'google', 'deepseek', 'meta'];
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_DURATION = 600;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/;

function failure(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function aborted() {
  return Object.assign(new Error('The operation was canceled.'), { name: 'AbortError' });
}

function checkSignal(signal) {
  if (signal?.aborted) throw aborted();
}

function parseBody(value) {
  let body = value;
  if (typeof body === 'string') {
    if (body.length > 512 * 1024) throw failure('The request is too large.', 413);
    try { body = JSON.parse(body); } catch { throw failure('The request was not valid JSON.'); }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure('Send a JSON object.');
  return body;
}

function analysisInput(body) {
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) throw failure('Add a transcript before analyzing.');
  if (text.length > 60_000) throw failure('Keep your transcript at or below 60,000 characters.', 413);
  const targetScript = typeof body.targetScript === 'string' ? body.targetScript : '';
  const targetTalkingPoints = typeof body.targetTalkingPoints === 'string' ? body.targetTalkingPoints : '';
  if (targetScript.length > 30_000 || targetTalkingPoints.length > 30_000) {
    throw failure('Keep your script and speaking points at or below 30,000 characters each.', 413);
  }
  const plannedIntroduction = typeof body.plannedIntroduction === 'string' ? body.plannedIntroduction : '';
  const plannedTransitions = typeof body.plannedTransitions === 'string' ? body.plannedTransitions : '';
  const instructorRubric = typeof body.instructorRubric === 'string' ? body.instructorRubric : '';
  const rubricFileName = typeof body.rubricFileName === 'string' ? body.rubricFileName : '';
  if (plannedIntroduction.length > 8_000) throw failure('Keep your planned introduction at or below 8,000 characters.', 413);
  if (plannedTransitions.length > 8_000) throw failure('Keep your planned transitions at or below 8,000 characters.', 413);
  if (instructorRubric.length > 40_000) throw failure('Keep your teacher rubric at or below 40,000 characters.', 413);
  if (rubricFileName.length > 255) throw failure('Keep the rubric file name at or below 255 characters.', 413);
  const duration = typeof body.durationSeconds === 'number' ? body.durationSeconds : Number(body.durationSeconds);
  return {
    text, targetScript, targetTalkingPoints, plannedIntroduction, plannedTransitions, instructorRubric, rubricFileName,
    targetMode: ['points', 'script', 'both'].includes(body.targetMode) ? body.targetMode : 'points',
    speakerName: typeof body.speakerName === 'string' ? body.speakerName.trim().slice(0, 100) : '',
    durationSeconds: Number.isFinite(duration) && duration > 0 && duration <= MAX_DURATION + 1 ? duration : null,
    useAI: body.useAI !== false,
  };
}

/**
 * An in-browser replacement for the small local API. Credentials exist only in
 * this closure until removed, disposed, or the page is closed. No persistence.
 * The only remote requests are explicit coaching calls to the selected vendor.
 */
export function createBrowserService({ policyText, transcribe, fetchImpl = globalThis.fetch } = {}) {
  const policy = buildCoachingInstructions(policyText);
  if (typeof transcribe !== 'function') throw new TypeError('Provide a local speech transcription function.');
  let provider = 'openai';
  let speechModel = BARK_MODEL_ID;
  let workspaceId = '';
  let progressHandler = null;
  let disposed = false;
  let transcriptionBusy = false;
  let analysisBusy = false;
  const keys = Object.fromEntries(PROVIDER_IDS.map(id => [id, '']));
  const models = Object.fromEntries(PROVIDER_IDS.map(id => [id, PROVIDERS[id].defaultModel]));
  const controllers = new Set();

  function config() {
    return {
      configured: true, speechConfigured: true, localSpeech: true,
      analysisConfigured: Boolean(keys[provider]), analysisProvider: provider,
      analysisModel: models[provider], transcriptionModel: speechModel,
      transcriptionEndpoint: '', workspaceId,
      providers: PROVIDER_IDS.map(id => ({ id, label: PROVIDERS[id].label, keyUrl: PROVIDERS[id].keyUrl,
        defaultModel: PROVIDERS[id].defaultModel, model: models[id], configured: Boolean(keys[id]) })),
      maxDurationSeconds: MAX_DURATION, maxAudioBytes: MAX_AUDIO_BYTES,
    };
  }

  function saveSettings(body) {
    const nextProvider = body.analysisProvider ?? provider;
    if (typeof nextProvider !== 'string' || !PROVIDER_IDS.includes(nextProvider)) throw failure('Choose a supported AI provider for coaching.');
    if (body.analysisApiKey !== undefined && (typeof body.analysisApiKey !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(body.analysisApiKey.trim()))) {
      throw failure('Paste the complete API key without spaces or line breaks.');
    }
    if (body.analysisModel !== undefined && (typeof body.analysisModel !== 'string' || !MODEL_ID.test(body.analysisModel) || body.analysisModel.includes('..'))) {
      throw failure('Enter a valid model ID for the selected AI provider.');
    }
    if (body.transcriptionModel !== undefined && !isBarkModel(body.transcriptionModel)) {
      throw failure('Choose an available Bark speech model.');
    }
    if (body.workspaceId !== undefined && (typeof body.workspaceId !== 'string' || !/^[A-Za-z0-9_-]{0,120}$/.test(body.workspaceId))) {
      throw failure('Enter a valid Claude workspace ID, or leave it blank.');
    }
    // Nothing is committed until every supplied value has been validated.
    provider = nextProvider;
    if (body.analysisApiKey !== undefined) keys[provider] = body.analysisApiKey.trim();
    if (body.clearAnalysisKey === true) keys[provider] = '';
    if (body.analysisModel !== undefined) models[provider] = body.analysisModel;
    if (body.transcriptionModel !== undefined) speechModel = body.transcriptionModel;
    if (body.workspaceId !== undefined) workspaceId = body.workspaceId;
    return config();
  }

  function progress(value, signal) {
    if (disposed || signal.aborted || !progressHandler) return;
    try { progressHandler(value); } catch { /* A progress display must not break speech processing. */ }
  }

  async function dispatch(path, options, signal) {
    const method = String(options.method || 'GET').toUpperCase();
    if (method === 'GET' && path === '/api/config') return config();
    if (method === 'POST' && path === '/api/settings') return saveSettings(parseBody(options.body));
    if (method === 'POST' && path === '/api/prompt-preview') {
      return { prompt: buildAnalysisPrompt(analysisInput(parseBody(options.body)), policy) };
    }
    if (method === 'POST' && path === '/api/transcribe') {
      if (transcriptionBusy) throw failure('Another recording is being transcribed. Please wait for it to finish.', 409);
      const blob = options.body;
      if (!blob || typeof blob.arrayBuffer !== 'function' || !Number.isFinite(blob.size) || blob.size <= 0) {
        throw failure('Record or upload an audio file first.');
      }
      if (blob.size > MAX_AUDIO_BYTES) throw failure('This recording is too large. Use a rehearsal of up to 10 minutes.', 413);
      transcriptionBusy = true;
      const model = speechModel;
      try {
        const result = await transcribe(blob, { model, signal, onProgress: value => progress(value, signal) });
        checkSignal(signal);
        const text = typeof result?.text === 'string' ? result.text.trim() : '';
        if (!text) throw failure('No speech was detected. Check your microphone and try another take.', 422);
        if (text.length > 60_000) throw failure('The transcript is too long. Use a shorter rehearsal.', 413);
        const durationSeconds = result.durationSeconds;
        if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds < 0.5) {
          throw failure('The recording duration could not be read or the recording is too short. Record at least half a second.');
        }
        if (durationSeconds > MAX_DURATION + 0.1) throw failure('Recordings can be up to 10 minutes.', 413);
        return { text, model, durationSeconds, chunks: Array.isArray(result.chunks) ? result.chunks : [], localSpeech: true };
      } finally { transcriptionBusy = false; }
    }
    if (method === 'POST' && path === '/api/analyze-text') {
      const input = analysisInput(parseBody(options.body));
      // Validate transcript tokens and all target inputs before any vendor call.
      let report = analyzeSpeech(input);
      const selectedProvider = provider;
      const selectedModel = models[selectedProvider];
      const selectedKey = keys[selectedProvider];
      const selectedWorkspace = workspaceId;
      const label = PROVIDERS[selectedProvider].label;
      const warnings = [];
      let missingCoachingCriteria = [];
      let coachingStatus = input.useAI ? 'not_connected' : 'disabled';
      if (input.useAI && selectedKey) {
        if (analysisBusy) throw failure('Another report is being prepared. Please wait for it to finish.', 409);
        const prompt = buildAnalysisPrompt(input, policy);
        analysisBusy = true;
        try {
          const aiFeedback = await requestCoaching({ provider: selectedProvider, apiKey: selectedKey,
            model: selectedModel, prompt, workspaceId: selectedWorkspace,
            fetchImpl, browser: true, signal });
          checkSignal(signal);
          report = analyzeSpeech({ ...input, aiFeedback });
          if (report.analysis.method === 'ai') {
            const completion = coachingCompletion(report.analysis);
            coachingStatus = completion.status;
            missingCoachingCriteria = completion.missingCriteria;
            warnings.push(...completion.warnings);
          } else {
            coachingStatus = 'invalid_response';
            warnings.push(`${label} returned feedback without usable transcript evidence. This report uses local transcript checks; no AI rating was assigned.`);
          }
        } catch (error) {
          if (signal.aborted || error?.name === 'AbortError') throw aborted();
          coachingStatus = 'failed';
          warnings.push(`AI coaching was unavailable. ${error?.status ? error.message : 'The service returned an invalid response.'} This report uses local transcript checks.`);
        } finally { analysisBusy = false; }
      } else if (input.useAI) {
        warnings.push(`Add your ${label} API key through Connect API for AI coaching. This report uses local transcript checks.`);
      }
      checkSignal(signal);
      return { ...report, transcript: input.text, warnings, meta: {
        generatedAt: new Date().toISOString(), durationSeconds: input.durationSeconds,
        targetMode: input.targetMode, targetScript: input.targetScript, targetTalkingPoints: input.targetTalkingPoints,
        plannedIntroduction: input.plannedIntroduction, plannedTransitions: input.plannedTransitions, instructorRubric: input.instructorRubric, rubricFileName: input.rubricFileName,
        speakerName: input.speakerName, analysisProvider: selectedProvider,
        analysisProviderLabel: label, analysisModel: selectedModel, coachingStatus, missingCoachingCriteria, localSpeech: true,
      } };
    }
    throw failure('This app action does not exist.', 404);
  }

  async function request(path, options = {}) {
    if (disposed) throw failure('This session is closed. Reload the page to start again.', 410);
    checkSignal(options.signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    controllers.add(controller);
    try {
      const result = await dispatch(path, options, controller.signal);
      checkSignal(controller.signal);
      return result;
    } finally {
      options.signal?.removeEventListener('abort', abort);
      controllers.delete(controller);
    }
  }

  return {
    request,
    setProgressHandler(handler) { progressHandler = typeof handler === 'function' ? handler : null; },
    dispose() {
      disposed = true;
      controllers.forEach(controller => controller.abort());
      controllers.clear();
      PROVIDER_IDS.forEach(id => { keys[id] = ''; });
      progressHandler = null;
    },
  };
}
