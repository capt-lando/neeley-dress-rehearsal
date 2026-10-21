import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, inspectWav } from '../server.mjs';

function wav(seconds = 1) {
  const length = Math.round(seconds * 16000) * 2;
  const bytes = Buffer.alloc(44 + length);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(36 + length, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(length, 40);
  return bytes;
}

async function app(t, options = {}) {
  const server = createApp(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    get: path => fetch(url + path),
    post: (path, body, headers = {}) => fetch(url + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: Buffer.isBuffer(body) ? body : JSON.stringify(body),
    }),
  };
}

test('WAV validation derives real duration and rejects malformed audio', () => {
  assert.equal(inspectWav(wav(2)).durationSeconds, 2);
  assert.throws(() => inspectWav(Buffer.from('bad audio')), /WAV/);
  const badRate = wav();
  badRate.writeUInt32LE(44100, 24);
  assert.throws(() => inspectWav(badRate), /16 kHz/);
  assert.throws(() => inspectWav(wav().subarray(0, 60)), /incomplete/);
  assert.throws(() => inspectWav(wav(601)), /10 minutes/);
});

test('API settings never expose the token and reject unsafe destinations', async t => {
  const client = await app(t);
  assert.equal((await (await client.get('/api/config')).json()).configured, false);
  const response = await client.post('/api/settings', { token: 'hf_TestToken123' });
  const config = await response.json();
  assert.equal(config.configured, true);
  assert.ok(!JSON.stringify(config).includes('TestToken123'));
  assert.equal((await client.post('/api/settings', { transcriptionEndpoint: 'http://127.0.0.1/private' })).status, 400);
  assert.equal((await client.post('/api/settings', { transcriptionEndpoint: 'https://evil.example/' })).status, 400);
  assert.equal((await client.post('/api/settings', { transcriptionModel: '../escape' })).status, 400);
  assert.equal((await client.post('/api/settings', { token: '' })).status, 200);
  assert.equal((await (await client.get('/api/config')).json()).configured, false);
});

test('cross-site pages cannot change settings or read local API with their origin', async t => {
  const client = await app(t);
  const response = await client.post('/api/settings', { token: 'hf_Attack' }, { Origin: 'https://elsewhere.example' });
  assert.equal(response.status, 403);
  assert.equal((await (await client.get('/api/config')).json()).configured, false);
});

test('coaching keys stay isolated by provider and are never returned to the browser', async t => {
  const client = await app(t);
  const first = await (await client.post('/api/settings', {
    analysisProvider: 'openai', analysisApiKey: 'sk-openaiPrivateExample', token: 'hf_SpeechPrivateExample',
  })).json();
  assert.equal(first.analysisProvider, 'openai');
  assert.equal(first.analysisConfigured, true);
  assert.equal(first.speechConfigured, true);
  assert.ok(!JSON.stringify(first).includes('PrivateExample'));
  const second = await (await client.post('/api/settings', { analysisProvider: 'anthropic', analysisApiKey: 'sk-ant-PrivateExample' })).json();
  assert.equal(second.analysisProvider, 'anthropic');
  assert.equal(second.providers.find(provider => provider.id === 'openai').configured, true);
  assert.equal(second.providers.find(provider => provider.id === 'anthropic').configured, true);
  const cleared = await (await client.post('/api/settings', { clearAnalysisKey: true })).json();
  assert.equal(cleared.analysisConfigured, false);
  assert.equal(cleared.speechConfigured, true);
  assert.equal(cleared.providers.find(provider => provider.id === 'openai').configured, true);
  const restored = await (await client.post('/api/settings', { analysisProvider: 'openai' })).json();
  assert.equal(restored.analysisConfigured, true);
  assert.equal((await client.post('/api/settings', { analysisProvider: '__proto__' })).status, 400);
  assert.equal((await client.post('/api/settings', { analysisProvider: 'google', analysisApiKey: 'invalid\nheader' })).status, 400);
  assert.equal((await (await client.get('/api/config')).json()).analysisProvider, 'openai', 'invalid request must not change provider');
});

test('prompt preview includes actual input and makes no external request', async t => {
  let calls = 0;
  const client = await app(t, { env: { OPENAI_API_KEY: 'sk-privateNeverInPrompt' }, fetchImpl: async () => { calls++; throw new Error(); } });
  const response = await client.post('/api/prompt-preview', {
    text: 'Hello, I am Jordan. We should support tutoring.',
    targetScript: 'Support tutoring.\nExplain the budget.',
    targetMode: 'script', speakerName: 'Jordan', durationSeconds: 42,
  });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.match(data.prompt, /"targetMode":"script"/);
  assert.match(data.prompt, /"durationSeconds":42/);
  assert.match(data.prompt, /Explain the budget/);
  assert.match(data.prompt, /We should support tutoring/);
  assert.ok(!data.prompt.includes('privateNeverInPrompt'));
  assert.equal(calls, 0);
  assert.equal((await client.post('/api/prompt-preview', { text: '' })).status, 400);
});

test('recorded WAV is sent to the configured speech API with private authorization', async t => {
  let recorded;
  const client = await app(t, {
    env: { HF_TOKEN: 'hf_PrivateToken' },
    fetchImpl: async (url, options) => {
      recorded = { url, options };
      return new Response(JSON.stringify({ text: "Hello, I'm Jordan. Um, our thesis is clear.", chunks: [] }), { status: 200 });
    },
  });
  const response = await client.post('/api/transcribe', wav(3), { 'Content-Type': 'audio/wav' });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.durationSeconds, 3);
  assert.match(data.text, /Jordan/);
  assert.equal(recorded.url, 'https://router.huggingface.co/deepinfra/v1/openai/audio/transcriptions');
  assert.equal(recorded.options.headers.Authorization, 'Bearer hf_PrivateToken');
  assert.equal(recorded.options.headers['Content-Type'], undefined, 'fetch must add the multipart boundary');
  assert.equal(recorded.options.body.get('model'), 'nvidia/Nemotron-3.5-ASR-Streaming-Multilingual-0.6b');
  assert.equal(recorded.options.body.get('file').size, wav(3).length);
  assert.ok(!JSON.stringify(data).includes('PrivateToken'));
});

test('transcription explains missing credentials, provider errors, and empty speech', async t => {
  const missing = await app(t);
  assert.equal((await missing.post('/api/transcribe', wav(), { 'Content-Type': 'audio/wav' })).status, 401);
  for (const [providerStatus, expected] of [[401, 401], [402, 402], [429, 429], [503, 502]]) {
    const client = await app(t, { env: { HF_TOKEN: 'hf_Test' }, fetchImpl: async () => new Response('{}', { status: providerStatus }) });
    const response = await client.post('/api/transcribe', wav(), { 'Content-Type': 'audio/wav' });
    assert.equal(response.status, expected);
    assert.ok((await response.json()).error);
  }
  const empty = await app(t, { env: { HF_TOKEN: 'hf_Test' }, fetchImpl: async () => new Response('{"text":""}') });
  assert.equal((await empty.post('/api/transcribe', wav(), { 'Content-Type': 'audio/wav' })).status, 422);
});

test('local transcript analysis yields the three requested sections without remote calls', async t => {
  let calls = 0;
  const client = await app(t, { fetchImpl: async () => { calls++; throw new Error('Unexpected'); } });
  const response = await client.post('/api/analyze-text', {
    text: "Hi, I'm Alex. Um, we should expand the tutoring program because it improves access. In conclusion, fund more tutors.",
    targetScript: 'Expand the tutoring program\nDiscuss new library hours',
    durationSeconds: 30,
    useAI: false,
  });
  const data = await response.json();
  assert.equal(response.status, 200);
  for (const section of ['wordStats', 'blunders', 'analysis']) assert.ok(data[section]);
  assert.equal(data.meta.durationSeconds, 30);
  assert.equal(calls, 0);
  assert.equal((await client.post('/api/analyze-text', { text: ' ' })).status, 400);
});

test('coaching failure preserves useful local report and explains fallback', async t => {
  const client = await app(t, {
    env: { HF_TOKEN: 'hf_Test' },
    fetchImpl: async () => new Response('{"error":"busy"}', { status: 503 }),
  });
  const response = await client.post('/api/analyze-text', { text: 'Hello, my name is Alex. We should improve student access.', useAI: true });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.ok(data.wordStats);
  assert.ok(data.analysis);
  assert.match(data.warnings[0], /AI coaching was unavailable/);
});

test('successful coaching yields grounded ratings and semantic speaking point coverage', async t => {
  const transcript = 'Hello, I am Alex. We should expand tutoring. For example, attendance rose 20 percent. First, fund training. Students, this helps you. In conclusion, invest in tutors.';
  const evidence = ['We should expand tutoring.', 'For example, attendance rose 20 percent.', 'First, fund training.', 'Students, this helps you.', 'In conclusion, invest in tutors.'];
  const ai = {
    thesis: { summary: 'Expand the tutoring program.', clarity: 'A direct recommendation.', evidence: [evidence[0]] },
    strengths: [{ text: 'The recommendation is explicit.', evidence: [evidence[0]] }],
    improvements: ['Explain how the attendance result was measured.'],
    rhetoric: [{ text: 'The closing repeats the action.', evidence: [evidence[4]] }],
    rubric: ['claim', 'evidence', 'structure', 'audience', 'conclusion'].map((criterion, index) => ({ criterion, score: 4, reason: 'Clearly signposted in the excerpt.', evidence: [evidence[index]] })),
    targetCoverage: [{ id: 'point-1', status: 'covered', evidence: [evidence[0]] }],
  };
  let called = false;
  const client = await app(t, {
    env: { HF_TOKEN: 'hf_Test' },
    fetchImpl: async (url, options) => {
      called = true;
      assert.equal(url, 'https://router.huggingface.co/v1/chat/completions');
      const payload = JSON.parse(options.body);
      assert.equal(payload.model, 'Qwen/Qwen3-4B-Instruct-2507');
      assert.ok(payload.messages[1].content.includes(transcript));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(ai) } }] }));
    },
  });
  const response = await client.post('/api/analyze-text', { text: transcript, targetScript: 'Recommend more tutoring resources', durationSeconds: 35 });
  const report = await response.json();
  assert.equal(response.status, 200);
  assert.equal(called, true);
  assert.equal(report.analysis.method, 'ai');
  assert.equal(report.analysis.overallRating, 80);
  assert.equal(report.blunders.targetCoverage[0].confidence, 'ai');
  assert.equal(report.blunders.targetCoverage[0].status, 'covered');
  assert.equal(report.warnings.length, 0);
});

test('alternate Whisper model retains raw audio format', async t => {
  let payload;
  const client = await app(t, {
    env: { HF_TOKEN: 'hf_Test', HF_TRANSCRIPTION_MODEL: 'openai/whisper-large-v3-turbo' },
    fetchImpl: async (url, options) => {
      payload = { url, options };
      return new Response('{"text":"This is my presentation."}');
    },
  });
  assert.equal((await client.post('/api/transcribe', wav(), { 'Content-Type': 'audio/wav' })).status, 200);
  assert.equal(payload.url, 'https://router.huggingface.co/hf-inference/models/openai/whisper-large-v3-turbo');
  assert.equal(payload.options.headers['Content-Type'], 'audio/wav');
  assert.equal(payload.options.body.length, wav().length);
});

test('selected provider handles the real analysis request instead of Hugging Face', async t => {
  for (const provider of ['openai', 'anthropic', 'google']) {
    let requestedUrl;
    const feedback = {
      thesis: { summary: 'Invest in tutoring.', clarity: 'An explicit request.', evidence: ['We should invest in tutoring.'] },
      improvements: ['Add a specific supporting example.'],
    };
    const client = await app(t, {
      fetchImpl: async (url) => {
        requestedUrl = url;
        const content = JSON.stringify(feedback);
        const body = provider === 'openai'
          ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: content }] }] }
          : provider === 'anthropic'
            ? { content: [{ type: 'text', text: content }], stop_reason: 'end_turn' }
            : { candidates: [{ content: { parts: [{ text: content }] }, finishReason: 'STOP' }] };
        return new Response(JSON.stringify(body));
      },
    });
    await client.post('/api/settings', { analysisProvider: provider, analysisApiKey: `${provider}-testKey` });
    const response = await client.post('/api/analyze-text', { text: 'We should invest in tutoring.', useAI: true });
    const report = await response.json();
    assert.equal(response.status, 200);
    assert.equal(report.analysis.method, 'ai');
    assert.equal(report.meta.analysisProvider, provider);
    assert.equal(report.analysis.thesis.summary, 'Invest in tutoring.');
    const host = new URL(requestedUrl).hostname;
    assert.equal(host, { openai: 'api.openai.com', anthropic: 'api.anthropic.com', google: 'generativelanguage.googleapis.com' }[provider]);
  }
});

test('static serving exposes only public files and applies microphone policy', async t => {
  const client = await app(t);
  for (const path of ['/.env', '/server.mjs', '/README.md']) assert.equal((await client.get(path)).status, 404);
  const config = await client.get('/api/config');
  assert.equal(config.headers.get('permissions-policy'), 'microphone=(self)');
  assert.match(config.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});
