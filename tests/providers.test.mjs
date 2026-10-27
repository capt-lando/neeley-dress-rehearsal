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
  deepseek: { choices: [{ finish_reason: 'stop', message: { content: json, reasoning_content: '{"private":"reasoning"}' } }] },
  meta: {
    stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: '{"private":"reasoning"}' }, { type: 'redacted_thinking', data: 'private' }, { type: 'text', text: json }],
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
  assert.deepEqual(Object.keys(PROVIDERS), ['openai', 'anthropic', 'google', 'deepseek', 'meta', 'huggingface']);
  for (const provider of Object.values(PROVIDERS)) {
    assert.ok(provider.label && provider.defaultModel);
    assert.equal(new URL(provider.keyUrl).protocol, 'https:');
  }
  assert.equal(PROVIDERS.openai.defaultModel, 'gpt-6-luna');
  assert.equal(PROVIDERS.anthropic.defaultModel, 'claude-haiku-5-5');
  assert.equal(PROVIDERS.google.defaultModel, 'gemini-3.8-flash');
  assert.equal(PROVIDERS.deepseek.defaultModel, 'deepseek-flash');
  assert.equal(PROVIDERS.deepseek.keyUrl, 'https://platform.deepseek.com/api_keys');
  assert.equal(PROVIDERS.meta.defaultModel, 'muse-spark-1.3');
  assert.equal(PROVIDERS.meta.keyUrl, 'https://dev.meta.ai/api-keys');
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

test('OpenAI token accounting keeps only numeric usage counters, including reasoning and cached input', async () => {
  let usage;
  const result = await requestCoaching(options('openai', {
    onUsage: value => { usage = value; },
    fetchImpl: async () => mockResponse({ ...fixtures.openai, usage: {
      input_tokens: 1200, input_tokens_details: { cached_tokens: 1000, secret: key },
      output_tokens: 800, output_tokens_details: { reasoning_tokens: 300 }, total_tokens: 2000,
      private: prompt,
    } }),
  }));
  assert.deepEqual(result, report);
  assert.deepEqual(usage, { inputTokens: 1200, cachedInputTokens: 1000, outputTokens: 800, reasoningTokens: 300, totalTokens: 2000 });
  await requestCoaching(options('openai', {
    onUsage: () => assert.fail('Invalid counters must not be recorded'),
    fetchImpl: async () => mockResponse({ ...fixtures.openai, usage: { input_tokens: key, output_tokens: -1, total_tokens: 1.5 } }),
  }));
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

test('Meta Messages authenticates only to Meta and omits Claude-specific or unsupported parameters', async () => {
  let request;
  const result = await requestCoaching(options('meta', {
    browser: true, workspaceId: 'claude_workspace',
    fetchImpl: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return mockResponse(fixtures.meta);
    },
  }));
  assert.deepEqual(result, report);
  assert.equal(request.url, 'https://api.meta.ai/v1/messages');
  assert.deepEqual(request.init.headers, { 'Content-Type': 'application/json', 'x-api-key': key });
  assert.equal(request.body.model, 'muse-spark-1.3');
  assert.equal(request.body.max_tokens, 8192);
  assert.match(request.body.system, /JSON object/);
  assert.deepEqual(request.body.messages, [{ role: 'user', content: prompt }]);
  assert.deepEqual(Object.keys(request.body).sort(), ['max_tokens', 'messages', 'model', 'system']);
  assert.equal(request.init.redirect, 'error');
  assert.equal(request.init.credentials, 'omit');
  assert.ok(request.init.signal instanceof AbortSignal);
  assert.ok(!request.url.includes(key) && !request.init.body.includes(key));
});

test('Meta rejects truncated, tool, refusal and reasoning-only output instead of returning a report', async () => {
  const invalid = [
    ...['max_tokens', 'tool_use', 'refusal'].map(stop_reason => ({ ...fixtures.meta, stop_reason })),
    { stop_reason: 'end_turn', content: [{ type: 'refusal' }, { type: 'text', text: json }] },
    { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: json }, { type: 'redacted_thinking', data: json }] },
    ...['not JSON', 'null', '{}', '[]'].map(text => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] })),
  ];
  for (const body of invalid) {
    await assert.rejects(requestCoaching(options('meta', {
      fetchImpl: async () => mockResponse(body),
    })), error => error.status === 502);
  }
});

test('Meta errors are actionable, sanitized and do not retry or suggest Claude workspace settings', async () => {
  for (const [status, expectedStatus, expectedMessage] of [
    [400, 400, /rejected the request/], [403, 403, /API key and its model access/],
    [404, 502, /selected model/], [429, 429, /temporarily rate-limited/], [503, 502, /unavailable right now/],
  ]) {
    let calls = 0;
    await assert.rejects(requestCoaching(options('meta', {
      fetchImpl: async () => {
        calls++;
        return mockResponse({ error: { message: `${key} ${prompt}` } }, status);
      },
    })), error => {
      assert.equal(error.status, expectedStatus);
      assert.match(error.message, expectedMessage);
      assert.doesNotMatch(error.message, /Claude|workspace/);
      assert.ok(!error.message.includes(key) && !error.message.includes(prompt));
      return true;
    });
    assert.equal(calls, 1);
  }
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

test('DeepSeek chat requests bounded JSON with private bearer authentication and ignores reasoning', async () => {
  for (const model of [undefined, 'deepseek-v4-pro']) {
    let request;
    const result = await requestCoaching(options('deepseek', {
      model, browser: true,
      fetchImpl: async (url, init) => {
        request = { url, init, body: JSON.parse(init.body) };
        // DeepSeek may send whitespace keep-alives before its non-stream JSON.
        return new Response(`\n\n${JSON.stringify(fixtures.deepseek)}\n`);
      },
    }));
    assert.deepEqual(result, report);
    assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
    assert.deepEqual(request.init.headers, { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` });
    assert.equal(request.body.model, model || 'deepseek-flash');
    assert.equal(request.body.max_tokens, 8192);
    assert.equal(request.body.stream, false);
    assert.deepEqual(request.body.thinking, { type: 'disabled' });
    assert.deepEqual(request.body.response_format, { type: 'json_object' });
    assert.match(request.body.messages[0].content, /JSON object/);
    assert.deepEqual(request.body.messages[1], { role: 'user', content: prompt });
    assert.equal(request.body.input, undefined);
    assert.equal(request.body.store, undefined);
    assert.equal(request.init.redirect, 'error');
    assert.equal(request.init.credentials, 'omit');
    assert.ok(request.init.signal instanceof AbortSignal);
    assert.ok(!request.url.includes(key) && !request.init.body.includes(key));
  }
});

test('DeepSeek distinguishes balance, rate limits and invalid parameters without leaking provider errors or retrying', async () => {
  for (const [status, expectedStatus, expectedMessage] of [
    [402, 402, /balance is insufficient.*Add funds/],
    [429, 429, /temporarily rate-limited.*Wait briefly/],
    [422, 422, /rejected the request.*model/],
    [503, 502, /unavailable right now/],
  ]) {
    let calls = 0;
    await assert.rejects(requestCoaching(options('deepseek', {
      fetchImpl: async () => {
        calls++;
        return { ok: false, status, json: async () => { throw new Error(`Do not read ${key} ${prompt}`); } };
      },
    })), error => {
      assert.equal(error.status, expectedStatus);
      assert.match(error.message, expectedMessage);
      assert.ok(!error.message.includes(key) && !error.message.includes(prompt));
      if (status === 429) assert.doesNotMatch(error.message, /balance|billing|credit|quota/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('DeepSeek rejects incomplete, refused, reasoning-only and invalid JSON reports', async () => {
  const invalid = [
    ...['length', 'tool_calls', 'insufficient_system_resource', 'aborted', 'content_filter'].map(finish_reason =>
      ({ choices: [{ finish_reason, message: { content: json } }] })),
    { choices: [{ finish_reason: 'stop', message: { refusal: 'Refused', content: json } }] },
    ...[null, '', 'null', '[]', '{}', 'not JSON', '<think>' + json].map(content =>
      ({ choices: [{ finish_reason: 'stop', message: { content, reasoning_content: json } }] })),
    null, [], { choices: [] },
  ];
  for (const body of invalid) {
    await assert.rejects(requestCoaching(options('deepseek', {
      fetchImpl: async () => mockResponse(body),
    })), error => error.status === 502);
  }
  await assert.rejects(requestCoaching(options('deepseek', {
    fetchImpl: async () => new Response(`<html>${key}</html>`),
  })), error => /unreadable response/.test(error.message) && !error.message.includes(key));
});

test('DeepSeek rejects unsafe credentials, model paths and oversized prompts before sending', async () => {
  let calls = 0;
  for (const extra of [
    { apiKey: '' }, { apiKey: 'invalid\r\nheader' }, { model: 'https://other.example/model' },
    { model: '../model' }, { model: 'organization/model' }, { prompt: 'é'.repeat(256 * 1024 + 1) },
  ]) {
    await assert.rejects(requestCoaching(options('deepseek', {
      ...extra, fetchImpl: async () => { calls++; throw new Error('Must not send'); },
    })));
  }
  assert.equal(calls, 0);
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

test('OpenAI 429 codes distinguish temporary rate limits from credits and account limits without retrying', async () => {
  const messages = new Set();
  for (const [code, expected] of [
    ['credit_balance_exhausted', /credit balance is exhausted.*Add credits/],
    ['organization_spend_limit_exceeded', /organization reached its API spending limit/],
    ['project_spend_limit_exceeded', /project reached its API spending limit/],
    ['organization_usage_limit_exceeded', /organization reached its API usage limit/],
    ['insufficient_quota', /insufficient API quota.*Check API credits/],
    ['rate_limit_exceeded', /temporarily rate-limited.*Wait briefly/],
    ['slow_down', /asked this request to slow down.*Wait briefly/],
  ]) {
    let calls = 0;
    await assert.rejects(requestCoaching(options('openai', {
      fetchImpl: async () => {
        calls++;
        return mockResponse({ error: { code, message: `${key} ${prompt}` } }, 429);
      },
    })), error => {
      assert.equal(error.status, 429);
      assert.match(error.message, expected);
      assert.ok(!error.message.includes(key) && !error.message.includes(prompt));
      messages.add(error.message);
      return true;
    });
    assert.equal(calls, 1);
  }
  assert.equal(messages.size, 7);
});

test('specific OpenAI limit codes take precedence over broader error types', async () => {
  for (const [code, type, expected] of [
    ['credit_balance_exhausted', 'rate_limit_error', /credit balance is exhausted/],
    ['project_spend_limit_exceeded', 'insufficient_quota', /project reached its API spending limit/],
    ['rate_limit_exceeded', 'insufficient_quota', /temporarily rate-limited/],
    [null, 'rate_limit_error', /temporarily rate-limited/],
    ['unknown_code', 'insufficient_quota', /insufficient API quota/],
  ]) {
    await assert.rejects(requestCoaching(options('openai', {
      fetchImpl: async () => mockResponse({ error: { code, type } }, 429),
    })), expected);
  }
});

test('unknown, malformed, and malicious limit fields never leak or claim exhausted credit', async () => {
  for (const body of [
    { error: { code: key, type: prompt, message: `Credit exhausted: ${key}` } },
    { error: { code: '__proto__', type: 'toString' } },
    { error: { code: { toString: 'credit_balance_exhausted' }, type: ['insufficient_quota'] } },
    { error: null }, null, [],
  ]) {
    await assert.rejects(requestCoaching(options('openai', {
      fetchImpl: async () => mockResponse(body, 429),
    })), error => {
      assert.equal(error.status, 429);
      assert.match(error.message, /may be a temporary rate limit or an account quota or billing limit/);
      assert.doesNotMatch(error.message, /exhausted|insufficient/);
      assert.ok(!error.message.includes(key) && !error.message.includes(prompt));
      return true;
    });
  }
  await assert.rejects(requestCoaching(options('openai', {
    fetchImpl: async () => new Response(`<html>${key}</html>`, { status: 429 }),
  })), error => error.status === 429 && /may be a temporary rate limit/.test(error.message) && !error.message.includes(key));
  for (const provider of ['anthropic', 'google', 'huggingface']) {
    await assert.rejects(requestCoaching(options(provider, {
      fetchImpl: async () => mockResponse({ error: { code: 'credit_balance_exhausted' } }, 429),
    })), /may be a temporary rate limit/);
  }
});

test('aborting while reading OpenAI limit details remains cancellation, not a fallback limit', async () => {
  const controller = new AbortController();
  let bodyStarted;
  const reading = new Promise(resolve => { bodyStarted = resolve; });
  const pending = requestCoaching(options('openai', {
    signal: controller.signal,
    fetchImpl: async (_url, init) => ({ ok: false, status: 429,
      json: () => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException(key, 'AbortError')), { once: true });
        bodyStarted();
      }),
    }),
  }));
  await reading;
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError' && !error.message.includes(key));
});

test('timeouts while reading OpenAI limit details remain sanitized timeout failures', async () => {
  for (const name of ['TimeoutError', 'AbortError']) {
    await assert.rejects(requestCoaching(options('openai', {
      fetchImpl: async () => ({ ok: false, status: 429,
        json: async () => { throw Object.assign(new Error(key), { name }); },
      }),
    })), error => error.status === 504 && /took too long/.test(error.message) && !error.message.includes(key));
  }
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
