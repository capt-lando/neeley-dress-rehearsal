import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildAnalysisPrompt } from '../lib/analysis-core.mjs';
import { analysisInput, createHostedApi } from '../supabase/functions/rehearsal-api/api.mjs';

const policyText = await readFile(new URL('../lib/coaching-prompt.md', import.meta.url), 'utf8');
const user = '11111111-1111-4111-8111-111111111111';
const recordingId = '33333333-3333-4333-8333-333333333333';
const requestId = '44444444-4444-4444-8444-444444444444';
const origin = 'https://capt-lando.github.io';
const token = 'header.' + Buffer.from(JSON.stringify({ sub: user, amr: [{ method: 'oauth' }] })).toString('base64url') + '.signature';
function fixture() {
  const calls = [];
  const store = {
    async admitRequest() {},
    async verifyUser() { return { id: user, identities: [{ provider: 'google' }] }; },
    async profile() {},
    async owned(owner, id) {
      assert.equal(owner, user); assert.equal(id, recordingId);
      return { id, duration_seconds: 60, status: 'transcribed', transcript: 'We should expand tutoring.' };
    },
    async reserve(_owner, _id, _request, kind, _hash, cost) {
      calls.push('reserve'); assert.equal(kind, 'coach'); assert.equal(cost, 60000);
      return { state: 'new' };
    },
    async finish() {},
    async requestStatus() { return {state:'reserved'}; },
    async completeRequest(_owner,_request,result) { return result; },
    async update() {},
  };
  const app = createHostedApi({ store, policyText,
    env: { ALLOWED_ORIGINS: origin, COACHING_PROVIDER: 'openai', COACHING_API_KEY: 'test-only-key', COACHING_RESERVE_MICROUSD: '60000' },
    coach: async () => {
      calls.push('coach');
      return { thesis: { summary: 'Expand tutoring.', clarity: 'An explicit claim.', evidence: ['We should expand tutoring.'] } };
    },
    fetchImpl: async () => { assert.fail('This regression must not make network requests.'); },
  });
  return { calls, run: body => app(new Request('https://project.supabase.co/functions/v1/rehearsal-api/analyze-text', {
    method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })) };
}
function preparation(character) {
  return { recordingId, requestId, text: 'We should expand tutoring.', targetScript: character.repeat(30000),
    targetTalkingPoints: character.repeat(10000), instructorRubric: character.repeat(40000),
    assignmentInstructions: character.repeat(40000), assignmentFileName: 'assignment.pdf' };
}

// 256 KiB plus the short provider instructions and message framing stays below
// GPT-6 Luna's 272K-token long-context threshold even at one token per UTF-8 byte.
// At $0.125/M cache-write input and $0.50/M output (8,192-token cap), that leaves
// substantial headroom inside the $0.06 reservation. This is not an invoice cap.
test('serialized multibyte coaching context is rejected before reservation or provider work', async () => {
  const body = preparation('漢');
  const prompt = buildAnalysisPrompt(analysisInput(body, 60), policyText);
  assert.ok(prompt.length < 256 * 1024, 'a character-count limit would miss this case');
  assert.ok(Buffer.byteLength(prompt) > 256 * 1024);
  assert.ok(Buffer.byteLength(prompt) < 512 * 1024, 'the old serialized-prompt limit admitted this case');
  assert.ok(Buffer.byteLength(JSON.stringify(body)) < 512 * 1024, 'the request body is independently valid');
  const f = fixture(), response = await f.run(body);
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /Shorten the assignment instructions, rubric, script, or preparation notes/);
  assert.deepEqual(f.calls, []);
});

test('the same field lengths within the serialized byte budget still reach the managed coach', async () => {
  const body = preparation('a');
  assert.ok(Buffer.byteLength(buildAnalysisPrompt(analysisInput(body, 60), policyText)) < 256 * 1024);
  const f = fixture(), response = await f.run(body);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).analysis.method, 'ai');
  assert.deepEqual(f.calls, ['reserve', 'coach']);
});
