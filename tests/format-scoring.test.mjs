import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzeSpeech, buildAnalysisPrompt } from '../lib/analysis-core.mjs';
import { buildChatPrompt, CHAT_INSTRUCTIONS } from '../lib/coach-chat.mjs';

const policy = 'Assess the supplied presentation using its assignment context.';
const criteria = ['claim', 'evidence', 'structure', 'audience', 'conclusion'];
const claim = 'TeamDock puts every deadline in one shared view.';
const pitch = `Busy students waste hours coordinating projects. ${claim} A campus pilot cut missed deadlines by half. Book a demo this week.`;
const rubric = (items = criteria) => items.map(criterion => ({
  criterion,
  score: 4,
  reason: 'Grounded coaching assessment of the supplied presentation.',
  evidence: [claim],
}));
const payload = prompt => JSON.parse(prompt.slice(prompt.indexOf('DATA_JSON:\n') + 'DATA_JSON:\n'.length));

test('the shipped report policy adapts each criterion to the format without turning brevity into a penalty', async () => {
  const shippedPolicy = await readFile(new URL('../lib/coaching-prompt.md', import.meta.url), 'utf8');
  const prompt = buildAnalysisPrompt({ text: pitch, durationSeconds: 30 }, shippedPolicy);
  assert.match(prompt, /actual presentation format and purpose before judging quality/);
  assert.match(prompt, /short incomplete formal presentation is not automatically an elevator pitch/);
  assert.match(prompt, /longer conversational update is not automatically a formal speech/);
  assert.match(prompt, /Do not reward or penalize duration, word count, sentence count, or brevity itself/);
  assert.match(prompt, /Length may affect assessment only when instructorRubric or assignmentInstructions explicitly states/);
  assert.match(prompt, /personal practice time goal.*not such a requirement/);
  assert.match(prompt, /do not estimate duration from the transcript/);
  assert.match(prompt, /all five can earn full credit in an effective elevator pitch/);
  for (const criterion of ['Claim', 'Evidence', 'Structure', 'Audience', 'Conclusion']) assert.ok(prompt.includes(`- ${criterion}:`));
  assert.match(prompt, /Unsupported promises still need scrutiny/);
  assert.match(prompt, /do not inflate scores, manufacture praise, or excuse an incomplete assignment/);
  assert.match(prompt, /annotation capacity scales only to make room for notes, never to set the quality rating/);
  assert.match(prompt, /including none when no useful improvement is supported/);
  assert.doesNotMatch(prompt, /communicates an idea to a business audience|Recorded duration provides context only/);
});

test('follow-up coaching shares format and length rules without inventing a new score', () => {
  assert.match(CHAT_INSTRUCTIONS, /Adapt coaching to the actual presentation format and purpose/);
  assert.match(CHAT_INSTRUCTIONS, /An elevator pitch can succeed with a clear value proposition/);
  assert.match(CHAT_INSTRUCTIONS, /A formal presentation needs development, support, organization, and synthesis appropriate to its task/);
  assert.match(CHAT_INSTRUCTIONS, /Length may affect assessment only when assignmentInstructions or instructorRubric explicitly states/);
  assert.match(CHAT_INSTRUCTIONS, /Personal practice timing goals are optional coaching context, not grading requirements/);
  assert.match(CHAT_INSTRUCTIONS, /chat cannot re-grade a recording/);
});

test('unscored fallback recognizes that a pitch can work without formal stock phrases', () => {
  const report = analyzeSpeech({ text: pitch });
  const reasons = Object.fromEntries(report.analysis.rubric.map(item => [item.criterion, item.reason]));
  assert.equal(report.analysis.overallRating, null);
  assert.match(reasons.claim, /may be expressed in other words/);
  assert.match(reasons.evidence, /credible proof point may already support the idea/);
  assert.match(reasons.structure, /explicit signposts are optional/);
  assert.match(reasons.audience, /naming the audience aloud is optional/);
  assert.match(reasons.conclusion, /next step may already provide an effective ending/);
});

test('recorded duration and pace do not independently change grounded criterion scores or the overall rating', () => {
  const aiFeedback = { rubric: rubric() };
  const baseline = analyzeSpeech({ text: pitch, aiFeedback });
  assert.equal(baseline.analysis.overallRating, 80);
  assert.equal(baseline.wordStats.durationSeconds, null);
  assert.equal(baseline.wordStats.wordsPerMinute, null);

  for (const durationSeconds of [5, 30, 300, 900]) {
    const report = analyzeSpeech({ text: pitch, durationSeconds, aiFeedback });
    assert.deepEqual(report.analysis, baseline.analysis, `duration ${durationSeconds} must not alter the analysis`);
    assert.equal(report.wordStats.durationSeconds, durationSeconds);
    assert.equal(report.wordStats.wordsPerMinute, Math.round(report.wordStats.totalWords / durationSeconds * 60));
  }
});

test('word count does not independently change fixed grounded criterion scores or the overall rating', () => {
  const aiFeedback = { rubric: rubric() };
  const concise = analyzeSpeech({ text: claim, durationSeconds: 30, aiFeedback });
  const expanded = analyzeSpeech({
    text: `${claim} ${'Additional project details give the audience more context. '.repeat(60)}`,
    durationSeconds: 30,
    aiFeedback,
  });

  assert.ok(expanded.wordStats.totalWords > concise.wordStats.totalWords * 20);
  assert.notEqual(expanded.wordStats.wordsPerMinute, concise.wordStats.wordsPerMinute);
  assert.deepEqual(expanded.analysis.rubric, concise.analysis.rubric);
  assert.equal(concise.analysis.overallRating, 80);
  assert.equal(expanded.analysis.overallRating, concise.analysis.overallRating);
});

test('analysis prompt preserves exact explicit assignment and rubric limits without inferring an unknown duration', () => {
  const assignmentInstructions = 'Deliver an elevator pitch lasting at least 30 seconds and at most 60 seconds. Use between 75 and 150 words.';
  const instructorRubric = 'Length criterion: minimum 30 seconds; maximum 60 seconds. Word-count range: minimum 75 words; maximum 150 words.';

  for (const durationSeconds of [undefined, null, 0, -1, Infinity, NaN, '45']) {
    const data = payload(buildAnalysisPrompt({ text: pitch, assignmentInstructions, instructorRubric, durationSeconds }, policy));
    assert.equal(data.assignmentInstructions, assignmentInstructions);
    assert.equal(data.instructorRubric, instructorRubric);
    assert.equal(data.transcript, pitch);
    assert.equal(data.durationSeconds, null);
    assert.equal(data.measuredWordStats.durationSeconds, null);
    assert.equal(data.measuredWordStats.wordsPerMinute, null);
    assert.equal(data.measuredWordStats.totalWords, analyzeSpeech({ text: pitch }).wordStats.totalWords);
  }

  const measured = payload(buildAnalysisPrompt({ text: pitch, assignmentInstructions, instructorRubric, durationSeconds: 45.25 }, policy));
  assert.equal(measured.durationSeconds, 45.25);
  assert.equal(measured.measuredWordStats.durationSeconds, 45.25);
});

test('follow-up chat preserves supplied format and explicit assignment and rubric limits', () => {
  const context = {
    transcript: pitch,
    assignmentInstructions: 'Elevator pitch: minimum 30 seconds, maximum 60 seconds.',
    instructorRubric: 'A concise proof point and a clear next step. Minimum 75 words; maximum 150 words.',
    durationSeconds: null,
  };
  const data = JSON.parse(buildChatPrompt({
    context,
    history: [],
    message: 'Help me improve this pitch within the supplied requirements.',
  }));

  assert.deepEqual(data.preparationAndTranscript, context);
});

for (const [label, items, expectedRating] of [
  ['complete', criteria, 80],
  ['partial', ['claim'], null],
]) {
  test(`an explicit empty improvements list in ${label} grounded AI feedback stays empty`, () => {
    const fallback = analyzeSpeech({ text: pitch });
    assert.ok(fallback.analysis.improvements.length > 0, 'fixture must exercise absent heuristic cue matches');

    const report = analyzeSpeech({ text: pitch, aiFeedback: { rubric: rubric(items), improvements: [] } });
    assert.equal(report.analysis.method, 'ai');
    assert.equal(report.analysis.overallRating, expectedRating);
    assert.deepEqual(report.analysis.improvements, [], 'a deliberate empty AI list must not be replaced by heuristic advice');
  });

  test(`legacy ${label} AI feedback without improvements retains provisional fallback advice`, () => {
    const fallback = analyzeSpeech({ text: pitch });
    const report = analyzeSpeech({ text: pitch, aiFeedback: { rubric: rubric(items) } });

    assert.equal(report.analysis.method, 'ai');
    assert.equal(report.analysis.provisional, true);
    assert.equal(report.analysis.overallRating, expectedRating);
    assert.ok(report.analysis.improvements.length > 0);
    assert.deepEqual(report.analysis.improvements, fallback.analysis.improvements);
  });
}
