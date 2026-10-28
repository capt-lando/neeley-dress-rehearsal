import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzeSpeech, buildAnalysisPrompt } from '../lib/analysis.mjs';
import { conversationStarterFor, normalizeConversationStarter, DEFAULT_CONVERSATION_STARTER, MAX_CONVERSATION_STARTER } from '../lib/conversation-starter.mjs';

const text = 'We should expand tutoring. More students could get help after work. Please approve a pilot next term.';
const starter = 'Your tutoring proposal ends with a clear request. What evidence could make the case for that pilot more convincing?';
function feedback(conversationStarter = starter) {
  return { thesis: { summary: 'Expand tutoring.', evidence: ['We should expand tutoring.'] }, conversationStarter };
}
function report(analysis = {}) { return { transcript: text, analysis: { method: 'ai', ...analysis } }; }

test('the existing analysis response carries a trimmed bounded question without changing transcript evidence', () => {
  const result = analyzeSpeech({ text, aiFeedback: feedback(`  ${starter}\n `) });
  assert.equal(result.analysis.conversationStarter, starter);
  assert.deepEqual(result.analysis.thesis.evidence, ['We should expand tutoring.']);
  assert.equal(result.analysis.overallRating, null);
  assert.equal(conversationStarterFor({ ...result, transcript: text }), starter);
});

test('malformed or oversized model starters are discarded without losing useful analysis', () => {
  const values = [null, 42, {}, ['A question?'], '', 'No question here.', 'x'.repeat(500) + '?',
    '<img src=x onerror=alert(1)> What next?', 'Hello\u0000. What next?', '[Try this](https://example.com)?'];
  for (const value of values) {
    const result = analyzeSpeech({ text, aiFeedback: feedback(value) });
    assert.equal(result.analysis.method, 'ai');
    assert.equal(result.analysis.conversationStarter, undefined);
    assert.equal(normalizeConversationStarter(value), '');
  }
  assert.equal(normalizeConversationStarter('x'.repeat(499) + '?').length, MAX_CONVERSATION_STARTER);
});

test('a generated opener alone cannot establish AI analysis or be treated as spoken evidence', () => {
  const result = analyzeSpeech({ text, aiFeedback: { conversationStarter: starter } });
  assert.notEqual(result.analysis.method, 'ai');
  assert.equal(result.analysis.conversationStarter, undefined);
  assert.deepEqual(result.analysis.annotations, []);
});

test('old saved reports open with their actual priority instead of an invented audience gap', () => {
  const saved = report({ improvements: ['Explain how a pilot would reach students who work evenings.', 'Make the ending shorter.'] });
  const before = structuredClone(saved), opening = conversationStarterFor(saved);
  assert.match(opening, /Explain how a pilot would reach students who work evenings/);
  assert.doesNotMatch(opening, /audience|Make the ending shorter/);
  assert.ok(opening.endsWith('?')); assert.ok(opening.length <= MAX_CONVERSATION_STARTER);
  assert.deepEqual(saved, before);
});

test('legacy fallback prefers a grounded improvement annotation and skips invented quotations', () => {
  const saved = report({ annotations: [
    { quote: 'Not in this recording.', comment: 'Invented issue.', assessment: 'needs_work' },
    { quote: 'We should expand tutoring.', comment: 'The recommendation is direct.', assessment: 'strength' },
    { quote: 'More students could get help after work.', comment: 'Support this benefit with an example.', assessment: 'needs_work' },
  ] });
  const opening = conversationStarterFor(saved);
  assert.match(opening, /More students could get help after work/);
  assert.match(opening, /Support this benefit with an example/);
  assert.doesNotMatch(opening, /Invented issue|recommendation is direct/);
});

test('a saved central claim supplies context when no improvement or annotation is available', () => {
  const opening = conversationStarterFor(report({ thesis: { summary: 'Expand evening tutoring access.' } }));
  assert.match(opening, /Expand evening tutoring access/);
  assert.match(opening, /How would you/);
});

test('fallbacks handle missing and malformed older reports without markup or excessive text', () => {
  assert.equal(conversationStarterFor(null), DEFAULT_CONVERSATION_STARTER);
  assert.match(conversationStarterFor(null, { hasTranscript: true }), /this take/);
  const opening = conversationStarterFor(report({ conversationStarter: '<script>bad()</script>?', improvements: [null, {}, '<b>unsafe</b>', 'Explain the example. '.repeat(1000)] }));
  assert.ok(opening.length <= MAX_CONVERSATION_STARTER); assert.doesNotMatch(opening, /<|script|unsafe/);
  assert.match(opening, /Explain the example/);
  assert.equal(conversationStarterFor(report({ method: 'heuristic', conversationStarter: starter })).includes(starter), false);
});

test('analysis policy generates a specific tentative opener in the same response and the hosted copy stays synchronized', async () => {
  const prompt = buildAnalysisPrompt({ text, assignmentInstructions: 'Present to the campus investment committee.' });
  assert.match(prompt, /"conversationStarter":/);
  assert.match(prompt, /Do not automatically ask who the audience is/);
  assert.match(prompt, /It isn’t clear to me who you’re presenting to/);
  assert.match(prompt, /same feedback response/);
  const policy = await readFile(new URL('../lib/coaching-prompt.md', import.meta.url), 'utf8');
  const hosted = JSON.parse(await readFile(new URL('../supabase/functions/_shared/coaching-policy.json', import.meta.url), 'utf8'));
  assert.equal(hosted.text, policy);
});
