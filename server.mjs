import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { analyzeSpeech, buildAnalysisPrompt } from './lib/analysis.mjs';
import { PROVIDERS, requestCoaching } from './lib/providers.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_DURATION = 600;
const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*(?::[a-zA-Z0-9_.-]+)?$/;
const DEFAULT_SPEECH_MODEL = 'nvidia/nemotron-3.5-asr-streaming-0.6b';
const ANALYSIS_MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/;
const DEEPINFRA_SPEECH_MODELS = new Map([
  ['nvidia/nemotron-3.5-asr-streaming-0.6b', 'nvidia/Nemotron-3.5-ASR-Streaming-Multilingual-0.6b'],
  ['Qwen/Qwen3-ASR-0.6B', 'Qwen/Qwen3-ASR-0.6B'],
]);

function readEnvironment() {
  const env = { ...process.env };
  const path = resolve(ROOT, '.env');
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match && env[match[1]] === undefined) {
        env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
      }
    }
  }
  return env;
}

function failure(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function validateEndpoint(value) {
  if (!value) return '';
  let url;
  try { url = new URL(value); } catch { throw failure('Enter a valid Hugging Face endpoint URL.'); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.endpoints.huggingface.cloud') ||
      url.username || url.password || url.port || url.search || url.hash) {
    throw failure('Custom endpoints must use HTTPS on a Hugging Face Inference Endpoint (*.endpoints.huggingface.cloud).');
  }
  return url.href;
}

async function readBody(req, maxBytes) {
  const claimed = Number(req.headers['content-length']);
  if (claimed > maxBytes) throw failure('This request is too large. Record up to 10 minutes.', 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw failure('This request is too large. Record up to 10 minutes.', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) {
    throw failure('Send this request as JSON.', 415);
  }
  try {
    const value = JSON.parse((await readBody(req, 256 * 1024)).toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch (error) {
    if (error.status) throw error;
    throw failure('The request was not valid JSON.');
  }
}

export function inspectWav(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' ||
      buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw failure('Upload or record a WAV file. The app converts recordings automatically.');
  }
  let format, dataBytes = 0;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (offset + 8 + size > buffer.length) throw failure('This audio file appears incomplete.');
    if (id === 'fmt ') {
      if (size < 16) throw failure('This audio format is incomplete.');
      format = {
        encoding: buffer.readUInt16LE(offset + 8),
        channels: buffer.readUInt16LE(offset + 10),
        sampleRate: buffer.readUInt32LE(offset + 12),
        byteRate: buffer.readUInt32LE(offset + 16),
        blockAlign: buffer.readUInt16LE(offset + 20),
        bits: buffer.readUInt16LE(offset + 22),
      };
    }
    if (id === 'data') dataBytes += size;
    offset += 8 + size + (size % 2);
  }
  if (!format || format.encoding !== 1 || format.channels !== 1 || format.sampleRate !== 16000 ||
      format.bits !== 16 || format.byteRate !== 32000 || format.blockAlign !== 2 || dataBytes % 2) {
    throw failure('Use 16 kHz, mono, 16-bit PCM WAV audio. Re-import the file through the app to convert it.');
  }
  const durationSeconds = dataBytes / 32000;
  if (durationSeconds < 0.5) throw failure('Record at least half a second before analyzing.');
  if (durationSeconds > MAX_DURATION + 0.1) throw failure('Recordings can be up to 10 minutes.', 413);
  return { durationSeconds };
}

function validateInput(body) {
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) throw failure('Add a transcript before analyzing.');
  if (text.length > 60000) throw failure('The transcript is too long. Use a rehearsal of up to 10 minutes.', 413);
  const targetScript = typeof body.targetScript === 'string' ? body.targetScript.trim() : '';
  if (targetScript.length > 30000) throw failure('Keep your target script under 30,000 characters.', 413);
  const durationSeconds = Number(body.durationSeconds);
  return {
    text,
    targetScript,
    targetMode: body.targetMode === 'script' ? 'script' : 'points',
    speakerName: typeof body.speakerName === 'string' ? body.speakerName.trim().slice(0, 100) : '',
    durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 && durationSeconds <= 601 ? durationSeconds : null,
    useAI: body.useAI !== false,
  };
}

function providerError(status, kind) {
  if (status === 401 || status === 403) return failure('Hugging Face could not authorize this request. Check your token and Inference Providers permission in API settings.', 401);
  if (status === 402) return failure('Hugging Face requires available inference credits or billing for this request.', 402);
  if (status === 429) return failure('Hugging Face is busy or your request limit was reached. Wait a moment and try again.', 429);
  if (status === 404 || status === 410) return failure(`This ${kind} model is not currently available from the configured provider. Check the model in API settings.`, 502);
  if (status === 413) return failure('The provider cannot process this audio length. Try a shorter rehearsal.', 413);
  return failure(`The ${kind} service is unavailable right now (provider status ${status}). Try again shortly.`, 502);
}

export function createApp({ env = {}, fetchImpl = globalThis.fetch } = {}) {
  let token = env.HF_TOKEN || env.HUGGING_FACE_HUB_TOKEN || '';
  let transcriptionModel = env.HF_TRANSCRIPTION_MODEL || DEFAULT_SPEECH_MODEL;
  const analysisKeys = {
    openai: env.OPENAI_API_KEY || '',
    anthropic: env.ANTHROPIC_API_KEY || '',
    google: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '',
  };
  let analysisProvider = env.ANALYSIS_PROVIDER || (analysisKeys.openai ? 'openai' : analysisKeys.anthropic ? 'anthropic' : analysisKeys.google ? 'google' : token ? 'huggingface' : 'openai');
  if (!Object.hasOwn(PROVIDERS, analysisProvider)) throw failure('Choose OpenAI, Anthropic, Google, or Hugging Face as ANALYSIS_PROVIDER.');
  const analysisModels = {
    openai: env.OPENAI_MODEL || PROVIDERS.openai.defaultModel,
    anthropic: env.ANTHROPIC_MODEL || PROVIDERS.anthropic.defaultModel,
    google: env.GEMINI_MODEL || PROVIDERS.google.defaultModel,
    huggingface: env.HF_ANALYSIS_MODEL || PROVIDERS.huggingface.defaultModel,
  };
  let anthropicWorkspaceId = env.ANTHROPIC_WORKSPACE_ID || '';
  let transcriptionEndpoint = validateEndpoint(env.HF_TRANSCRIPTION_ENDPOINT || '');
  let transcriptionBusy = false;
  let analysisBusy = false;
  const keyFor = provider => provider === 'huggingface' ? token : analysisKeys[provider];

  const config = () => ({
    configured: Boolean(token),
    speechConfigured: Boolean(token),
    analysisConfigured: Boolean(keyFor(analysisProvider)),
    analysisProvider,
    transcriptionModel,
    analysisModel: analysisModels[analysisProvider],
    workspaceId: anthropicWorkspaceId,
    providers: Object.entries(PROVIDERS).map(([id, provider]) => ({
      id, label: provider.label, keyUrl: provider.keyUrl,
      defaultModel: provider.defaultModel, model: analysisModels[id], configured: Boolean(keyFor(id)),
    })),
    transcriptionEndpoint,
    maxDurationSeconds: MAX_DURATION,
    maxAudioBytes: MAX_AUDIO_BYTES,
  });

  async function upstream(url, body, contentType, timeoutMs = 150000) {
    const requestToken = token;
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${requestToken}`, ...(contentType ? { 'Content-Type': contentType } : {}) },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        throw failure('The API took too long. Try again with a shorter rehearsal.', 504);
      }
      throw failure('Could not reach Hugging Face. Check your internet connection and try again.', 502);
    }
    return response;
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Permissions-Policy', 'microphone=(self)');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    function json(value, status = 200) {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    }
    try {
      const host = req.headers.host || '';
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) throw failure('This app is available only on your local computer.', 403);
      const origin = req.headers.origin;
      if (origin && origin !== `http://${host}`) throw failure('This request must come from the local app.', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw failure('This request must come from the local app.', 403);
      const url = new URL(req.url, `http://${host}`);
      const path = url.pathname;

      if (req.method === 'GET' && path === '/api/config') return json(config());

      if (req.method === 'POST' && path === '/api/settings') {
        const body = await readJson(req);
        const nextProvider = body.analysisProvider ?? analysisProvider;
        if (typeof nextProvider !== 'string' || !Object.hasOwn(PROVIDERS, nextProvider)) throw failure('Choose ChatGPT, Claude, or Gemini for coaching.');
        if (body.transcriptionModel !== undefined && (typeof body.transcriptionModel !== 'string' || !MODEL_PATTERN.test(body.transcriptionModel))) {
          throw failure('Use a Hugging Face speech model ID in the form organization/model-name.');
        }
        const modelPattern = nextProvider === 'huggingface' ? MODEL_PATTERN : ANALYSIS_MODEL_PATTERN;
        if (body.analysisModel !== undefined && (typeof body.analysisModel !== 'string' || !modelPattern.test(body.analysisModel))) {
          throw failure('Enter a valid model ID for your selected AI provider, or use its default model.');
        }
        if (body.transcriptionModel?.includes(':')) throw failure('Use the speech model ID without a provider suffix.');
        if (body.token !== undefined && (typeof body.token !== 'string' || body.token.length > 1024 ||
            (body.token.trim() && !/^hf_[a-zA-Z0-9]+$/.test(body.token.trim())))) {
          throw failure('Enter a Hugging Face access token beginning with hf_.');
        }
        if (body.analysisApiKey !== undefined && (typeof body.analysisApiKey !== 'string' ||
            !/^[\x21-\x7e]{1,4096}$/.test(body.analysisApiKey.trim()))) {
          throw failure('Paste the complete API key without spaces or line breaks.');
        }
        if (nextProvider === 'huggingface' && body.analysisApiKey !== undefined && !/^hf_[a-zA-Z0-9]+$/.test(body.analysisApiKey.trim())) {
          throw failure('Enter a Hugging Face access token beginning with hf_.');
        }
        if (body.workspaceId !== undefined && (typeof body.workspaceId !== 'string' || !/^[a-zA-Z0-9_-]{0,120}$/.test(body.workspaceId))) {
          throw failure('Enter a valid Claude workspace ID, or leave it blank.');
        }
        const endpoint = body.transcriptionEndpoint === undefined ? transcriptionEndpoint : validateEndpoint(body.transcriptionEndpoint);
        // Validate every field before changing credentials or the selected provider.
        if (body.token !== undefined) token = body.token.trim();
        if (body.transcriptionModel) transcriptionModel = body.transcriptionModel;
        analysisProvider = nextProvider;
        if (body.analysisApiKey !== undefined) {
          if (nextProvider === 'huggingface') token = body.analysisApiKey.trim();
          else analysisKeys[nextProvider] = body.analysisApiKey.trim();
        }
        if (body.clearAnalysisKey === true) {
          if (nextProvider === 'huggingface') token = '';
          else analysisKeys[nextProvider] = '';
        }
        if (body.analysisModel) analysisModels[nextProvider] = body.analysisModel;
        if (body.workspaceId !== undefined) anthropicWorkspaceId = body.workspaceId;
        transcriptionEndpoint = endpoint;
        return json(config());
      }

      if (req.method === 'POST' && path === '/api/prompt-preview') {
        const input = validateInput(await readJson(req));
        return json({ prompt: buildAnalysisPrompt(input) });
      }

      if (req.method === 'POST' && path === '/api/transcribe') {
        if (!token) throw failure('Connect your Hugging Face token in API settings to transcribe audio.', 401);
        if (transcriptionBusy) throw failure('Another recording is being transcribed. Please wait for it to finish.', 409);
        if (!req.headers['content-type']?.startsWith('audio/wav')) throw failure('Send audio as a WAV file.', 415);
        transcriptionBusy = true;
        try {
          const audio = await readBody(req, MAX_AUDIO_BYTES);
          const { durationSeconds } = inspectWav(audio);
          const model = transcriptionModel;
          let endpoint = transcriptionEndpoint || `https://router.huggingface.co/hf-inference/models/${model}`;
          let payload = audio;
          let contentType = 'audio/wav';
          if (!transcriptionEndpoint && DEEPINFRA_SPEECH_MODELS.has(model)) {
            endpoint = 'https://router.huggingface.co/deepinfra/v1/openai/audio/transcriptions';
            payload = new FormData();
            payload.append('file', new Blob([audio], { type: 'audio/wav' }), 'rehearsal.wav');
            payload.append('model', DEEPINFRA_SPEECH_MODELS.get(model));
            payload.append('language', 'en');
            contentType = undefined;
          }
          const response = await upstream(endpoint, payload, contentType);
          if (!response.ok) throw providerError(response.status, 'transcription');
          let result;
          try { result = await response.json(); } catch { throw failure('The speech service returned an unreadable response.', 502); }
          const text = typeof result.text === 'string' ? result.text.trim() : '';
          if (!text) throw failure('No speech was detected. Check your selected microphone and try again.', 422);
          if (text.length > 60000) throw failure('The provider returned an unexpectedly long transcript.', 502);
          return json({ text, model, durationSeconds, chunks: Array.isArray(result.chunks) ? result.chunks : [] });
        } finally { transcriptionBusy = false; }
      }

      if (req.method === 'POST' && path === '/api/analyze-text') {
        const input = validateInput(await readJson(req));
        const warnings = [];
        let aiFeedback;
        const selectedProvider = analysisProvider;
        const selectedModel = analysisModels[selectedProvider];
        const selectedKey = keyFor(selectedProvider);
        const selectedLabel = PROVIDERS[selectedProvider].label;
        if (input.useAI && selectedKey) {
          if (analysisBusy) throw failure('Another report is being prepared. Please wait for it to finish.', 409);
          analysisBusy = true;
          try {
            aiFeedback = await requestCoaching({
              provider: selectedProvider,
              apiKey: selectedKey,
              model: selectedModel,
              prompt: buildAnalysisPrompt(input),
              workspaceId: anthropicWorkspaceId,
              fetchImpl,
            });
          } catch (error) {
            warnings.push(`AI coaching was unavailable. ${error.status ? error.message : 'The service returned an invalid response.'} The report below uses local transcript checks.`);
          } finally { analysisBusy = false; }
        } else if (input.useAI) {
          warnings.push(`Add your ${selectedLabel} API key through Connect API for AI coaching. This report uses local transcript checks.`);
        }
        const report = analyzeSpeech({ ...input, aiFeedback });
        return json({
          ...report,
          transcript: input.text,
          warnings,
          meta: {
            generatedAt: new Date().toISOString(), durationSeconds: input.durationSeconds,
            targetMode: input.targetMode, speakerName: input.speakerName,
            analysisProvider: selectedProvider, analysisProviderLabel: selectedLabel, analysisModel: selectedModel,
          },
        });
      }

      if (path.startsWith('/api/')) return json({ error: 'This API route does not exist.' }, 404);
      if (req.method !== 'GET' && req.method !== 'HEAD') return json({ error: 'Method not supported.' }, 405);
      const files = new Map([
        ['/', 'index.html'], ['/index.html', 'index.html'], ['/styles.css', 'styles.css'],
        ['/app.js', 'app.js'], ['/favicon.svg', 'favicon.svg'],
      ]);
      const file = files.get(path);
      if (!file) return json({ error: 'Page not found.' }, 404);
      let content;
      try { content = await readFile(resolve(ROOT, 'public', file)); }
      catch { return json({ error: 'This page is not available yet.' }, 404); }
      const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
      res.writeHead(200, { 'Content-Type': `${types[extname(file)]}; charset=utf-8` });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      const status = error.status || (error.code === 'EMPTY_TRANSCRIPT' ? 400 : 500);
      json({ error: status !== 500 ? error.message : 'Something went wrong. Please try again.' }, status);
    }
  });
  server.requestTimeout = 180000;
  server.headersTimeout = 20000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const env = readEnvironment();
  const port = Number(env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT must be a number between 1 and 65535.');
    process.exit(1);
  }
  const server = createApp({ env });
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Open http://127.0.0.1:${port} or choose another PORT in .env.` : 'Could not start the local server.');
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Dress Rehearsal is ready at http://127.0.0.1:${port}`);
    console.log('Keep this window open while practicing. Press Ctrl+C to stop.');
    if (process.argv.includes('--open')) {
      const url = `http://127.0.0.1:${port}`;
      const command = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
      const browser = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
      browser.on('error', () => console.log(`Open ${url} in your browser to practice.`));
      browser.unref();
    }
  });
}
