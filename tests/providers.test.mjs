import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, requestCoaching } from '../lib/providers.mjs';

const report = { thesis: { summary: 'Expand tutoring access.' }, improvements: ['Give one concrete example.'] };
const json = JSON.stringify(report);
const key = 'private_test_key_123';
const prompt = 'Return JSON coaching for this transcript: Expand tutoring access.';
const fixtures = {
  openai: {
    status: 'completed',
    output: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: '{"private":"reasoning"}' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: json }] },
    ],
  },
  anthropic: {
    stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: '{"private":"reasoning"}' }, { type: 'text', text: json }],
  },
  google: {
    candidates: [{
      finishReason: 'STOP',
      content: { parts: [{ thought: true, text: '{"private":"reasoning"}' }, { text: json }] },
    }],
  },
  huggingface: { choices: [{ finish_reason: 'stop', message: { content: json } }] },
};

function mockResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function options(provider, extra = {}) {
  return {
    provider, apiKey: key, prompt,
    fetchImpl: async () => mockResponse(fixtures[provider]),
    ...extra,
  };
}

test('official provider metadata supplies current defaults and API key setup links', () => {
  assert.deepEqual(Object.keys(PROVIDERS), ['openai', 'anthropic', 'google', 'huggingface']);
  for (const provider of Object.values(PROVIDERS)) {
    assert.ok(provider.label && provider.defaultModel);
    assert.equal(new URL(provider.keyUrl).protocol, 'https:');
  }
  assert.equal(PROVIDERS.openai.defaultModel, 'gpt-6-luna');
  assert.equal(PROVIDERS.anthropic.defaultModel, 'claude-haiku-5-5');
  assert.equal(PROVIDERS.google.defaultModel, 'gemini-3.8-flash');
});

test('OpenAI Responses sends private headers, disables storage, and reads text beyond reasoning items', async () => {
  let request;
  const result = await requestCoaching(options('openai', {
    fetchImpl: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return mockResponse(fixtures.openai);
    },
  }));
  assert.deepEqual(result, report);
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.init.headers.Authorization, `Bearer ${key}`);
  assert.equal(request.body.store, false);
  assert.equal(request.body.input, prompt);
  assert.equal(request.body.reasoning.effort, 'low');
  assert.equal(request.body.temperature, undefined);
  assert.equal(request.init.redirect, 'error');
  assert.ok(request.init.signal instanceof AbortSignal);
  assert.ok(!request.url.includes(key) && !request.init.body.includes(key));
});

test('Claude Messages sends current bearer authentication, API version and optional workspace header', async () => {
  let request;
  const result = await requestCoaching(options('anthropic', {
    workspaceId: 'wrkspc_example',
    fetchImpl: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return mockResponse(fixtures.anthropic);
    },
  }));
  assert.deepEqual(result, report);
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.init.headers.Authorization, `Bearer ${key}`);
  assert.equal(request.init.headers['anthropic-version'], '2023-06-01');
  assert.equal(request.init.headers['anthropic-workspace-id'], 'wrkspc_example');
  assert.equal(request.body.messages[0].content, prompt);
  assert.ok(request.body.max_tokens > 0 && request.body.system);
  await assert.rejects(requestCoaching(options('anthropic', { workspaceId: 'bad\r\nheader' })), /workspace ID/);
});

test('Gemini generateContent authenticates in a header, requests JSON and excludes thought parts', async () => {
  let request;
  const result = await requestCoaching(options('google', {
    fetchImpl: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return mockResponse(fixtures.google);
    },
  }));
  assert.deepEqual(result, report);
  assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(request.init.headers['x-goog-api-key'], key);
  assert.equal(new URL(request.url).search, '');
  assert.equal(request.body.generationConfig.responseMimeType, 'application/json');
  assert.equal(request.body.contents[0].parts[0].text, prompt);
  assert.equal(request.body.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
});

test('HF chat preserves custom models and accepts fenced JSON after a complete thinking preface', async () => {
  let body;
  const result = await requestCoaching(options('huggingface', {
    model: 'Qwen/custom-model:fastest',
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://router.huggingface.co/v1/chat/completions');
      assert.equal(init.headers.Authorization, `Bearer ${key}`);
      body = JSON.parse(init.body);
      return mockResponse({ choices: [{ message: { content: `<think>Internal: {"bad":"not a report"}</think>\n\`\`\`json\n${json}\n\`\`\`` } }] });
    },
  }));
  assert.deepEqual(result, report);
  assert.equal(body.model, 'Qwen/custom-model:fastest');
  assert.equal(body.messages[1].content, prompt);
});

test('custom models do not receive parameters specific to the default model', async () => {
  for (const provider of ['openai', 'google']) {
    await requestCoaching(options(provider, {
      model: 'custom-model',
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        assert.equal(body.reasoning, undefined);
        assert.equal(body.generationConfig?.thinkingConfig, undefined);
        return mockResponse(fixtures[provider]);
      },
    }));
  }
});

test('provider authentication failures are actionable, sanitized, and never trigger another provider', async () => {
  for (const provider of Object.keys(PROVIDERS)) {
    let calls = 0;
    await assert.rejects(requestCoaching(options(provider, {
      fetchImpl: async () => {
        calls++;
        return mockResponse({ error: `Request with ${key} and ${prompt} failed` }, 401);
      },
    })), error => {
      assert.equal(error.status, 401);
      assert.match(error.message, /API key/);
      assert.ok(error.message.includes(PROVIDERS[provider].label));
      assert.ok(!error.message.includes(key) && !error.message.includes(prompt));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('billing, limits, missing models and service failures keep secrets out of errors', async () => {
  for (const [status, expected] of [[402, 402], [429, 429], [404, 502], [503, 502]]) {
    await assert.rejects(requestCoaching(options('openai', {
      fetchImpl: async () => mockResponse({ error: key }, status),
    })), error => error.status === expected && !error.message.includes(key));
  }
  await assert.rejects(requestCoaching(options('anthropic', {
    fetchImpl: async () => mockResponse({}, 400),
  })), /workspace ID/);
});

test('network and timeouts are sanitized even if the underlying exception contains credentials', async () => {
  for (const [name, expected] of [['TypeError', 502], ['TimeoutError', 504], ['AbortError', 504]]) {
    await assert.rejects(requestCoaching(options('google', {
      fetchImpl: async () => { throw Object.assign(new Error(`Failed secret ${key}`), { name }); },
    })), error => error.status === expected && !error.message.includes(key));
  }
});

test('refusals, truncated outputs and thinking-only responses never become coaching reports', async () => {
  const rejected = [
    ['openai', { status: 'incomplete', output: fixtures.openai.output }],
    ['openai', { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No' }] }] }],
    ['openai', { output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: json }] }] }],
    ['anthropic', { stop_reason: 'max_tokens', content: [{ type: 'text', text: json }] }],
    ['anthropic', { stop_reason: 'refusal', content: [{ type: 'text', text: json }] }],
    ['google', { promptFeedback: { blockReason: 'SAFETY' }, candidates: fixtures.google.candidates }],
    ['google', { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: json }] } }] }],
    ['google', { candidates: [{ content: { parts: [{ thought: true, text: json }] } }] }],
    ['huggingface', { choices: [{ finish_reason: 'length', message: { content: json } }] }],
    ['huggingface', { choices: [{ message: { content: `<think>${json}` } }] }],
  ];
  for (const [provider, body] of rejected) {
    await assert.rejects(requestCoaching(options(provider, {
      fetchImpl: async () => mockResponse(body),
    })), error => error.status === 502);
  }
});

test('malformed transport JSON, missing text, and non-object reports fail cleanly', async () => {
  await assert.rejects(requestCoaching(options('openai', {
    fetchImpl: async () => new Response('<html>private response</html>'),
  })), /unreadable response/);
  for (const text of ['null', '[]', '{}', '"hello"', 'not JSON', '[{"summary":"wrong root"}]']) {
    await assert.rejects(requestCoaching(options('huggingface', {
      fetchImpl: async () => mockResponse({ choices: [{ message: { content: text } }] }),
    })), error => error.status === 502);
  }
});

test('invalid provider, missing key, unsafe model and invalid inputs never send a request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('Should never run'); };
  for (const extra of [
    { provider: 'other' }, { provider: '__proto__' }, { apiKey: '' },
    { apiKey: 'invalid\r\nheader' }, { model: 'https://evil.example/path' },
    { model: '../path' }, { prompt: '' }, { prompt: null },
  ]) {
    await assert.rejects(requestCoaching(options('openai', { ...extra, fetchImpl })));
  }
  assert.equal(calls, 0);
});

test('complete coaching prompts up to 512 KiB are sent intact, including Unicode', async () => {
  const limit = 512 * 1024;
  for (const largePrompt of ['x'.repeat(limit), 'é'.repeat(limit / 2)]) {
    let sent;
    await requestCoaching(options('openai', {
      prompt: largePrompt,
      fetchImpl: async (_url, init) => {
        sent = JSON.parse(init.body).input;
        return mockResponse(fixtures.openai);
      },
    }));
    assert.equal(sent, largePrompt);
    assert.equal(new TextEncoder().encode(sent).byteLength, limit);
  }
});

test('combined prompts above the UTF-8 byte limit fail explicitly before any request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('Oversize prompts must not reach a provider'); };
  for (const largePrompt of ['x'.repeat(512 * 1024 + 1), 'é'.repeat(256 * 1024 + 1)]) {
    await assert.rejects(requestCoaching(options('openai', { prompt: largePrompt, fetchImpl })), error => {
      assert.equal(error.status, 413);
      assert.match(error.message, /combined coaching context is too large/);
      return true;
    });
  }
  assert.equal(calls, 0);
});
