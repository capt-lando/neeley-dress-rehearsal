import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBrowserService } from '../lib/browser-service.mjs';
import { BARK_MODEL_ID, BARK_MODELS } from '../lib/speech-models.mjs';

const policyText = await readFile(new URL('../lib/coaching-prompt.md', import.meta.url), 'utf8');
const post = body => ({ method: 'POST', body: JSON.stringify(body) });
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const noNetwork = async () => { throw new Error('Unexpected remote request'); };
const basicSpeech = async () => ({ text: 'We should expand tutoring. Thank you.', durationSeconds: 6 });
const create = overrides => createBrowserService({ policyText, transcribe: basicSpeech, fetchImpl: noNetwork, ...overrides });

function providerResponse(provider, feedback) {
  const text = JSON.stringify(feedback);
  if (provider === 'openai') return { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] };
  if (provider === 'anthropic' || provider === 'meta') return { stop_reason: 'end_turn', content: [{ type: 'text', text }] };
  if (provider === 'deepseek') return { choices: [{ finish_reason: 'stop', message: { content: text } }] };
  return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] };
}

test('browser config exposes local speech and five coaching providers without credentials', async () => {
  const service = create();
  const config = await service.request('/api/config');
  assert.equal(config.localSpeech, true);
  assert.equal(config.speechConfigured, true);
  assert.equal(config.analysisConfigured, false);
  assert.equal(config.transcriptionModel, BARK_MODEL_ID);
  assert.deepEqual(config.providers.map(item => item.id), ['openai', 'anthropic', 'google', 'deepseek', 'meta']);
  assert.equal(Object.hasOwn(config, 'analysisApiKey'), false);
});

test('provider keys and models remain isolated in memory and settings validation is atomic', async () => {
  const service = create();
  await service.request('/api/settings', post({ analysisProvider: 'openai', analysisApiKey: 'sk-private-openai', analysisModel: 'custom-model' }));
  await service.request('/api/settings', post({ analysisProvider: 'anthropic', analysisApiKey: 'sk-private-claude', workspaceId: 'wrk_123' }));
  await assert.rejects(service.request('/api/settings', post({ analysisProvider: 'google', analysisApiKey: 'private-google', transcriptionModel: 'bad-model' })), { status: 400 });
  const unchanged = await service.request('/api/config');
  assert.equal(unchanged.analysisProvider, 'anthropic');
  assert.equal(unchanged.providers.find(item => item.id === 'google').configured, false);
  assert.equal(unchanged.providers.find(item => item.id === 'openai').model, 'custom-model');
  assert.ok(!JSON.stringify(unchanged).includes('private-'));
  const cleared = await service.request('/api/settings', post({ clearAnalysisKey: true }));
  assert.equal(cleared.analysisConfigured, false);
  assert.equal(cleared.providers.find(item => item.id === 'openai').configured, true);
  const separate = create();
  assert.equal((await separate.request('/api/config')).providers.some(item => item.configured), false);
});

test('unsafe settings never send requests or change the selected provider', async () => {
  const service = create();
  for (const body of [
    { analysisProvider: '__proto__' }, { analysisProvider: 'huggingface' },
    { analysisApiKey: 'bad\nheader' }, { analysisModel: '../other' },
    { workspaceId: 'invalid workspace' }, { transcriptionModel: 'openai/whisper-large-v3' },
    { transcriptionModel: 'onnx-community/whisper-base.en' }, { transcriptionModel: 'onnx-community/whisper-small.en' },
    { transcriptionModel: 'bark-pro-unavailable' },
  ]) await assert.rejects(service.request('/api/settings', post(body)), { status: 400 });
  assert.equal((await service.request('/api/config')).analysisProvider, 'openai');
});

test('switching among all five providers routes only its saved key and model, and clearing is isolated', async () => {
  const ids = ['openai', 'anthropic', 'google', 'deepseek', 'meta'];
  const calls = [];
  const service = create({ fetchImpl: async (url, options) => {
    calls.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    return new Response('Unauthorized', { status: 401 });
  } });
  for (const id of ids) {
    await service.request('/api/settings', post({ analysisProvider: id, analysisApiKey: `${id}-private`, analysisModel: `${id}-custom` }));
  }
  for (const id of [...ids].reverse()) {
    const config = await service.request('/api/settings', post({ analysisProvider: id }));
    assert.equal(config.analysisModel, `${id}-custom`);
    assert.equal(config.analysisConfigured, true);
    assert.ok(!JSON.stringify(config).includes('-private'));
    const report = await service.request('/api/analyze-text', post({ text: 'We should expand tutoring.' }));
    const call = calls.at(-1);
    const keyHeader = { google: 'x-goog-api-key', meta: 'x-api-key' }[id] || 'Authorization';
    assert.equal(call.headers[keyHeader], keyHeader === 'Authorization' ? `Bearer ${id}-private` : `${id}-private`);
    if (id === 'google') assert.match(call.url, /google-custom:generateContent$/);
    else assert.equal(call.body.model, `${id}-custom`);
    assert.ok(!JSON.stringify(report).includes('-private'));
  }
  const cleared = await service.request('/api/settings', post({ analysisProvider: 'meta', clearAnalysisKey: true }));
  assert.equal(cleared.analysisConfigured, false);
  assert.ok(cleared.providers.filter(item => item.id !== 'meta').every(item => item.configured));
  const before = calls.length;
  const report = await service.request('/api/analyze-text', post({ text: 'We should expand tutoring.' }));
  assert.equal(report.meta.coachingStatus, 'not_connected');
  assert.equal(calls.length, before);
  service.dispose();
  assert.equal((await create().request('/api/config')).providers.some(item => item.configured), false);
});

test('each supported Bark variant reaches local transcription using its actual model ID', async () => {
  const seen = [];
  const service = create({ transcribe: async (_blob, { model }) => { seen.push(model); return basicSpeech(); } });
  for (const model of BARK_MODELS) {
    const config = await service.request('/api/settings', post({ transcriptionModel: model.id }));
    assert.equal(config.transcriptionModel, model.id);
    await service.request('/api/transcribe', { method: 'POST', body: new Blob(['audio']) });
  }
  assert.deepEqual(seen, BARK_MODELS.map(model => model.id));
});

test('local transcription delegates blob/model/signal/progress and does not call an API route', async () => {
  const seen = [];
  const progress = [];
  const service = create({ transcribe: async (blob, options) => {
    seen.push({ blob, options }); options.onProgress({ status: 'progress', progress: 50 });
    return { text: '  Real spoken words.  ', durationSeconds: 4, chunks: [{ text: 'Real spoken words.' }] };
  } });
  service.setProgressHandler(value => progress.push(value));
  await service.request('/api/settings', post({ transcriptionModel: BARK_MODEL_ID }));
  const blob = new Blob(['audio'], { type: 'audio/wav' });
  const result = await service.request('/api/transcribe', { method: 'POST', body: blob });
  assert.equal(seen[0].blob, blob);
  assert.equal(seen[0].options.model, BARK_MODEL_ID);
  assert.equal(seen[0].options.signal.aborted, false);
  assert.deepEqual(progress, [{ status: 'progress', progress: 50 }]);
  assert.equal(result.text, 'Real spoken words.');
  assert.equal(result.durationSeconds, 4);
  assert.equal(result.localSpeech, true);
});

test('empty speech, invalid duration and oversize audio fail with useful errors', async () => {
  const blob = new Blob(['audio']);
  for (const [result, status] of [ [{ text: '', durationSeconds: 4 }, 422], [{ text: 'Speech', durationSeconds: 0 }, 400], [{ text: 'Speech', durationSeconds: 601 }, 413] ]) {
    const service = create({ transcribe: async () => result });
    await assert.rejects(service.request('/api/transcribe', { method: 'POST', body: blob }), { status });
  }
  const service = create();
  await assert.rejects(service.request('/api/transcribe', { method: 'POST', body: new Blob([]) }), { status: 400 });
  await assert.rejects(service.request('/api/transcribe', { method: 'POST', body: { size: 21 * 1024 * 1024, arrayBuffer() {} } }), { status: 413 });
});

test('prompt preview and local analysis preserve both complete inputs and never make remote requests', async () => {
  const service = create();
  const input = { text: 'Tutoring improves access.', targetMode: 'both', targetScript: 'The complete script.\nFinal script line.', targetTalkingPoints: 'Tutoring improves access\nExplain the budget', durationSeconds: 10, useAI: false };
  const { prompt } = await service.request('/api/prompt-preview', post(input));
  const data = JSON.parse(prompt.split('DATA_JSON:\n')[1]);
  assert.equal(data.targetScript, input.targetScript);
  assert.equal(data.targetTalkingPoints, input.targetTalkingPoints);
  assert.equal(data.targetMode, 'both');
  const report = await service.request('/api/analyze-text', post(input));
  assert.equal(report.analysis.method, 'heuristic');
  assert.equal(report.meta.coachingStatus, 'disabled');
  assert.equal(report.warnings.length, 0);
  assert.equal(report.blunders.targetCoverage.length, 2);
  assert.equal(report.meta.targetTalkingPoints, input.targetTalkingPoints);
  assert.equal(report.transcript, input.text);
  const oldPoints = await service.request('/api/analyze-text', post({ text: input.text, targetMode: 'points', targetScript: 'Tutoring improves access', targetTalkingPoints: '', useAI: false }));
  assert.equal(oldPoints.blunders.targetCoverage[0].status, 'covered');
});

test('oversize and empty presentation inputs are rejected before contacting a configured provider', async () => {
  let calls = 0;
  const service = create({ fetchImpl: async () => { calls++; throw new Error('Should not be called'); } });
  await service.request('/api/settings', post({ analysisApiKey: 'sk-test-private' }));
  for (const body of [{ text: '' }, { text: '!!!' }, { text: 'a'.repeat(60_001) }, { text: 'Speech.', targetScript: 'a'.repeat(30_001) }, { text: 'Speech.', targetTalkingPoints: 'a'.repeat(30_001) }]) {
    await assert.rejects(service.request('/api/analyze-text', post(body)));
  }
  assert.equal(calls, 0);
});

test('each selected coaching service receives its own key and returns grounded feedback', async () => {
  for (const provider of ['openai', 'anthropic', 'google', 'deepseek', 'meta']) {
    let seen;
    const feedback = { thesis: { summary: 'Expand tutoring.', clarity: 'Explicit recommendation.', evidence: ['We should expand tutoring.'] } };
    const service = create({ fetchImpl: async (url, options) => { seen = { url, options }; return response(providerResponse(provider, feedback)); } });
    await service.request('/api/settings', post({ analysisProvider: provider, analysisApiKey: `${provider}-privateKey` }));
    const report = await service.request('/api/analyze-text', post({ text: 'We should expand tutoring.' }));
    assert.equal(new URL(seen.url).hostname, { openai: 'api.openai.com', anthropic: 'api.anthropic.com', google: 'generativelanguage.googleapis.com', deepseek: 'api.deepseek.com', meta: 'api.meta.ai' }[provider]);
    const keyHeader = { google: 'x-goog-api-key', meta: 'x-api-key' }[provider] || 'Authorization';
    assert.equal(seen.options.headers[keyHeader], keyHeader === 'Authorization' ? `Bearer ${provider}-privateKey` : `${provider}-privateKey`);
    if (provider === 'anthropic') assert.equal(seen.options.headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.equal(report.analysis.method, 'ai');
    assert.equal(report.meta.coachingStatus, 'partial');
    assert.deepEqual(report.meta.missingCoachingCriteria, ['claim', 'evidence', 'structure', 'audience', 'conclusion']);
    assert.match(report.warnings[0], /AI coaching is partial/);
    assert.equal(report.meta.analysisProvider, provider);
    assert.ok(!JSON.stringify(report).includes('privateKey'));
  }
});

test('coaching completeness reflects validated criteria without retries or invented scores', async () => {
  const text = 'We should expand tutoring.';
  for (const audience of ['valid', 'missing', 'unverifiable']) {
    let calls = 0;
    const rubric = ['claim', 'evidence', 'structure', 'audience', 'conclusion']
      .filter(criterion => audience !== 'missing' || criterion !== 'audience')
      .map(criterion => ({ criterion, score: 0, reason: 'A supported assessment.',
        evidence: [criterion === 'audience' && audience === 'unverifiable' ? 'Words never spoken.' : text] }));
    const service = create({ fetchImpl: async () => {
      calls++;
      return response(providerResponse('openai', { rubric, annotations: [{ category: 'thesis', quote: text, comment: 'Your proposal.' }] }));
    } });
    await service.request('/api/settings', post({ analysisApiKey: 'sk-test-private' }));
    const report = await service.request('/api/analyze-text', post({ text }));
    assert.equal(calls, 1);
    assert.equal(report.analysis.annotations.length, 1);
    assert.equal(report.analysis.method, 'ai');
    if (audience === 'valid') {
      assert.equal(report.meta.coachingStatus, 'complete');
      assert.deepEqual(report.meta.missingCoachingCriteria, []);
      assert.deepEqual(report.warnings, []);
      assert.equal(report.analysis.overallRating, 0);
    } else {
      assert.equal(report.meta.coachingStatus, 'partial');
      assert.deepEqual(report.meta.missingCoachingCriteria, ['audience']);
      assert.match(report.warnings[0], /missing for: audience/);
      assert.equal(report.analysis.overallRating, null);
      assert.equal(report.analysis.rubric.find(item => item.criterion === 'audience').score, null);
    }
  }
});

test('provider failures and unusable feedback clearly fall back without fabricated AI ratings', async () => {
  for (const [coachingStatus, fetchImpl, warning] of [
    ['failed', async () => new Response('private-response-body', { status: 401 }), /could not authorize/],
    ['failed', async () => new Response('private-response-body', { status: 429 }), /API usage limit/],
    ['failed', async () => { throw new Error('Network diagnostics with sk-private'); }, /could not be reached/],
    ['failed', async () => response(providerResponse('openai', 'invalid-report')), /invalid coaching report/],
    ['invalid_response', async () => response(providerResponse('openai', { invented: true })), /without usable transcript evidence/],
  ]) {
    const service = create({ fetchImpl });
    await service.request('/api/settings', post({ analysisApiKey: 'sk-private' }));
    const report = await service.request('/api/analyze-text', post({ text: 'We should practice.' }));
    assert.equal(report.analysis.method, 'heuristic');
    assert.equal(report.analysis.overallRating, null);
    assert.equal(report.meta.coachingStatus, coachingStatus);
    assert.match(report.warnings[0], warning);
    assert.match(report.warnings[0], /local transcript checks/);
    assert.ok(!JSON.stringify(report).includes('sk-private'));
    assert.ok(!JSON.stringify(report).includes('private-response-body'));
  }
});

test('a missing selected-provider key and an intentionally local report have distinct coaching states', async () => {
  let calls = 0;
  const service = create({ fetchImpl: async () => { calls++; throw new Error('Unexpected network request'); } });
  await service.request('/api/settings', post({ analysisProvider: 'openai', analysisApiKey: 'sk-private' }));
  await service.request('/api/settings', post({ analysisProvider: 'google' }));
  const notConnected = await service.request('/api/analyze-text', post({ text: 'We should expand tutoring.' }));
  assert.equal(notConnected.meta.coachingStatus, 'not_connected');
  assert.equal(notConnected.analysis.method, 'heuristic');
  assert.equal(notConnected.analysis.overallRating, null);
  assert.equal(notConnected.meta.analysisProvider, 'google');
  assert.match(notConnected.warnings[0], /Google \(Gemini\) API key/);

  await service.request('/api/settings', post({ analysisProvider: 'openai' }));
  const local = await service.request('/api/analyze-text', post({ text: 'We should expand tutoring.', useAI: false }));
  assert.equal(local.meta.coachingStatus, 'disabled');
  assert.equal(local.analysis.method, 'heuristic');
  assert.equal(local.analysis.overallRating, null);
  assert.deepEqual(local.warnings, []);
  assert.equal(calls, 0);
});

test('aborting coaching propagates cancellation instead of returning a fallback report', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const service = create({ fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('Canceled'), { name: 'AbortError' })), { once: true });
    started();
  }) });
  await service.request('/api/settings', post({ analysisApiKey: 'sk-private' }));
  const controller = new AbortController();
  const result = service.request('/api/analyze-text', { ...post({ text: 'We should practice.' }), signal: controller.signal });
  await ready; controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
});

test('dispose cancels active local transcription, prevents stale results, and closes the session', async () => {
  let finish, seenSignal;
  const service = create({ transcribe: (_blob, options) => { seenSignal = options.signal; return new Promise(resolve => { finish = resolve; }); } });
  await service.request('/api/settings', post({ analysisApiKey: 'sk-private' }));
  const result = service.request('/api/transcribe', { method: 'POST', body: new Blob(['audio']) });
  service.dispose();
  assert.equal(seenSignal.aborted, true);
  finish({ text: 'Stale speech.', durationSeconds: 4 });
  await assert.rejects(result, { name: 'AbortError' });
  await assert.rejects(service.request('/api/config'), { status: 410 });
});

test('unknown local routes cannot become arbitrary network destinations', async () => {
  const service = create();
  await assert.rejects(service.request('https://example.com/steal'), { status: 404 });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.request('/api/config', { signal: controller.signal }), { name: 'AbortError' });
});

test('introduction, transition and rubric data reach the selected coach and metadata without leaking credentials', async () => {
  let outbound;
  const service = create({ fetchImpl: async (_url, options) => {
    outbound = JSON.parse(options.body);
    return response(providerResponse('openai', { thesis: { summary: 'Expand tutoring.', clarity: 'Explicit claim.', evidence: ['We should expand tutoring.'] } }));
  } });
  await service.request('/api/settings', post({ analysisApiKey: 'sk-rubric-private-key' }));
  const input = {
    text: 'We should expand tutoring.', targetMode: 'both', targetScript: 'A complete script.', targetTalkingPoints: 'Explain tutoring',
    plannedIntroduction: '  Imagine a campus where help is always available.\nWhat would change?  ',
    plannedTransitions: '  Move from access → affordability.\nConclude with the next step.  ',
    instructorRubric: '  Evidence: 50%.\nClarity: 30%.\nEye contact: 20%.\nFinal rubric line.  ',
    rubricFileName: 'Instructor rubric – final.docx',
  };
  const preview = await service.request('/api/prompt-preview', post(input));
  const report = await service.request('/api/analyze-text', post(input));
  const data = JSON.parse(outbound.input.split('DATA_JSON:\n')[1]);
  for (const field of ['plannedIntroduction', 'plannedTransitions', 'instructorRubric', 'rubricFileName']) {
    assert.equal(data[field], input[field]);
    assert.equal(report.meta[field], input[field]);
    assert.equal(JSON.parse(preview.prompt.split('DATA_JSON:\n')[1])[field], input[field]);
  }
  assert.ok(!outbound.input.includes('sk-rubric-private-key'));
  assert.ok(!JSON.stringify(report).includes('sk-rubric-private-key'));
  assert.ok(!preview.prompt.includes('sk-rubric-private-key'));
  assert.equal(report.analysis.method, 'ai');
});

test('rubric context limits are enforced for preview and analysis before any provider request', async () => {
  let calls = 0;
  const service = create({ fetchImpl: async () => { calls++; throw new Error('Invalid inputs must never reach the provider'); } });
  await service.request('/api/settings', post({ analysisApiKey: 'sk-validation-private' }));
  for (const [field, limit] of [['plannedIntroduction', 8_000], ['plannedTransitions', 8_000], ['instructorRubric', 40_000], ['rubricFileName', 255]]) {
    for (const path of ['/api/analyze-text', '/api/prompt-preview']) {
      await assert.rejects(service.request(path, post({ text: 'Speech.', [field]: 'x'.repeat(limit + 1) })), { status: 413 });
    }
    const input = { text: 'Speech.', useAI: false, [field]: 'x'.repeat(limit) };
    const report = await service.request('/api/analyze-text', post(input));
    assert.equal(report.meta[field], input[field]);
  }
  assert.equal(calls, 0);
  const legacy = await service.request('/api/analyze-text', post({ text: 'Legacy rehearsal.', useAI: false }));
  assert.equal(legacy.meta.plannedIntroduction, '');
  assert.equal(legacy.meta.plannedTransitions, '');
  assert.equal(legacy.meta.instructorRubric, '');
  assert.equal(legacy.meta.rubricFileName, '');
});
