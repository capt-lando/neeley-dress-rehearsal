import { randomUUID } from 'node:crypto';
import { analyzeSpeech, buildAnalysisPrompt, buildCoachingInstructions, MAX_TRANSCRIPT_ANNOTATIONS } from '../lib/analysis-core.mjs';

export const INPUT_LIMITS = Object.freeze({
  text: 60_000, targetScript: 30_000, targetTalkingPoints: 30_000,
  plannedIntroduction: 8_000, plannedTransitions: 8_000,
  instructorRubric: 40_000, rubricFileName: 255, speakerName: 120,
  assignmentInstructions: 40_000, assignmentFileName: 255,
});
export const MAX_FEEDBACK_BYTES = 2 * 1024 * 1024;
const CRITERIA = ['claim', 'evidence', 'structure', 'audience', 'conclusion'];
const FEEDBACK_KEYS = new Set(['thesis', 'strengths', 'improvements', 'rhetoric', 'rubric', 'targetCoverage', 'annotations', 'conversationStarter']);
const INPUT_KEYS = new Set([...Object.keys(INPUT_LIMITS), 'targetMode', 'durationSeconds', 'useAI']);

export class RehearsalError extends Error {
  constructor(code, message) { super(message); this.name = 'RehearsalError'; this.code = code; }
}

function fail(code, message) { throw new RehearsalError(code, message); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

// Bound the JSON tree before serializing it. MCP supplies JSON, but keeping the
// store strict also protects direct callers and avoids circular/deep objects.
function jsonBytes(value, limit, label) {
  const seen = new Set();
  let members = 0;
  const visit = (item, depth = 0) => {
    if (++members > 100_000 || depth > 20) fail('INPUT_LIMIT', `${label} has too many nested values. Simplify it and try again.`);
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || seen.has(item)) fail('INVALID_JSON', `${label} must contain ordinary JSON values only.`);
    seen.add(item);
    if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null && !Array.isArray(item)) {
      fail('INVALID_JSON', `${label} must contain ordinary JSON objects only.`);
    }
    for (const key of Object.keys(item)) visit(item[key], depth + 1);
    seen.delete(item);
  };
  visit(value);
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > limit) fail('INPUT_LIMIT', `${label} exceeds the ${Math.round(limit / 1024)} KiB limit. Shorten it and try again; no text was saved or truncated.`);
  return bytes;
}

function checkedInput(input) {
  if (!object(input)) fail('INVALID_INPUT', 'input must be an object containing the current transcript and planning fields.');
  for (const key of Object.keys(input)) if (!INPUT_KEYS.has(key)) {
    fail('INVALID_INPUT', `Unsupported input field: ${key}. Send only the current transcript, planning fields, and duration; never provider credentials or precomputed feedback.`);
  }
  for (const [key, limit] of Object.entries(INPUT_LIMITS)) {
    if (!(key in input)) continue;
    if (typeof input[key] !== 'string') fail('INVALID_INPUT', `${key} must be a string.`);
    if (input[key].length > limit) fail('INPUT_LIMIT', `${key} must contain at most ${limit.toLocaleString('en-US')} characters. No text was saved or truncated.`);
  }
  if (typeof input.text !== 'string') fail('INVALID_INPUT', 'Provide the transcript in input.text.');
  if ('targetMode' in input && !['points', 'script', 'both'].includes(input.targetMode)) fail('INVALID_INPUT', 'targetMode must be points, script, or both.');
  if ('durationSeconds' in input && input.durationSeconds !== null &&
      (typeof input.durationSeconds !== 'number' || !Number.isFinite(input.durationSeconds) || input.durationSeconds < 0 || input.durationSeconds > 601)) {
    fail('INVALID_INPUT', 'durationSeconds must be null or a finite number between 0 and 601.');
  }
  if ('useAI' in input && typeof input.useAI !== 'boolean') fail('INVALID_INPUT', 'useAI must be a boolean when supplied.');
  jsonBytes(input, 1024 * 1024, 'The rehearsal input');
  // Reuse the same transcript, target, and complexity validation as the app.
  analyzeSpeech(input);
  return structuredClone(input);
}

function validateFeedback(feedback, input) {
  if (!object(feedback)) fail('INVALID_FEEDBACK', 'feedback must be the coaching JSON object, not a JSON string or a finished report.');
  jsonBytes(feedback, MAX_FEEDBACK_BYTES, 'The coaching feedback');
  for (const key of Object.keys(feedback)) if (!FEEDBACK_KEYS.has(key)) {
    fail('INVALID_FEEDBACK', `Remove the unsupported feedback field ${key}; use the exact response shape from get_coaching_request.`);
  }
  if (!Array.isArray(feedback.rubric) || feedback.rubric.length !== CRITERIA.length ||
      CRITERIA.some(criterion => feedback.rubric.filter(item => object(item) && item.criterion === criterion).length !== 1)) {
    fail('INVALID_FEEDBACK', `Return exactly one rated rubric entry for each criterion: ${CRITERIA.join(', ')}. Each needs a 0–5 score, a reason, and transcript evidence. Fetch this revision with get_coaching_request if needed, then repair and resubmit it.`);
  }
  if (!Array.isArray(feedback.annotations) || feedback.annotations.length > MAX_TRANSCRIPT_ANNOTATIONS) {
    fail('INVALID_FEEDBACK', `Return annotations as an array with at most ${MAX_TRANSCRIPT_ANNOTATIONS} exact, non-overlapping transcript highlights. Select useful passages across the whole speech, leaving ordinary text unmarked. Use [] only when no useful grounded highlights exist.`);
  }
  const report = analyzeSpeech({ ...input, aiFeedback: feedback });
  const unrated = report.analysis.rubric.filter(item => !Number.isFinite(item.score)).map(item => item.criterion);
  if (report.analysis.method !== 'ai' || unrated.length || !Number.isFinite(report.analysis.overallRating)) {
    fail('INVALID_FEEDBACK', `Repair the unsupported rubric entries: ${unrated.length ? unrated.join(', ') : CRITERIA.join(', ')}. Each needs a finite score from 0 to 5, a nonempty reason, and a real transcript quotation of at most 500 characters. For an absent feature, quote the relevant passage reviewed. No rating has been published; resubmit the same revision.`);
  }
  if (report.analysis.annotations.length !== feedback.annotations.length) {
    fail('INVALID_FEEDBACK', 'One or more annotations were invalid. Copy each quote exactly from this revision’s transcript (including case, spacing, and punctuation), use thesis/evidence/structure/delivery/clarity/great, a nonempty comment, and the correct positive occurrence number when wording repeats. Keep quotations within 500 characters and remove overlapping highlights. Repair and resubmit the same revision; no partial report has been published.');
  }
  return report;
}

/** In-memory only. No transcript files, provider clients, or network access. */
export class RehearsalStore {
  #sessions = new Map();
  #policyText;
  #now;
  #ttlMs;
  #maxSessions;
  #maxRetainedBytes;

  constructor({ policyText, now = Date.now, ttlMs = 2 * 60 * 60 * 1000, maxSessions = 24, maxRetainedBytes = 32 * 1024 * 1024 } = {}) {
    this.#policyText = buildCoachingInstructions(policyText);
    if (typeof now !== 'function' || !Number.isSafeInteger(ttlMs) || ttlMs < 1 ||
        !Number.isSafeInteger(maxSessions) || maxSessions < 1 || !Number.isSafeInteger(maxRetainedBytes) || maxRetainedBytes < 1) {
      throw new TypeError('Provide a clock function and positive integer session limits.');
    }
    this.#now = now; this.#ttlMs = ttlMs; this.#maxSessions = maxSessions; this.#maxRetainedBytes = maxRetainedBytes;
  }

  prune() {
    const now = this.#now();
    for (const [id, session] of this.#sessions) if (session.expiresAt <= now) this.#sessions.delete(id);
  }

  #session(rehearsalId) {
    this.prune();
    if (typeof rehearsalId !== 'string' || !this.#sessions.has(rehearsalId)) {
      fail('REHEARSAL_NOT_FOUND', 'This rehearsal was cleared from memory or expired. Open a new rehearsal and prepare the current transcript again.');
    }
    return this.#sessions.get(rehearsalId);
  }

  #pending(rehearsalId, revision) {
    const session = this.#session(rehearsalId);
    if (!Number.isSafeInteger(revision) || revision < 1 || revision !== session.revision) {
      fail('STALE_REVISION', `This coaching request is stale. The current revision is ${session.revision}; do not submit feedback for an older transcript. Use get_rehearsal to inspect the current state.`);
    }
    if (session.status !== 'pending') fail('NO_PENDING_COACHING', 'There is no pending coaching request for this revision. Prepare the current transcript before requesting another assessment.');
    return session;
  }

  #summary(session) {
    return { rehearsalId: session.rehearsalId, revision: session.revision, status: session.status, report: structuredClone(session.report) };
  }

  #save(session, update) {
    const bytes = jsonBytes({ input: update.input, report: update.report }, this.#maxRetainedBytes, 'The rehearsal report');
    let retainedBytes = bytes;
    for (const other of this.#sessions.values()) if (other !== session) retainedBytes += other.bytes;
    if (retainedBytes > this.#maxRetainedBytes) fail('SESSION_MEMORY_LIMIT', 'The active rehearsals have reached the in-memory limit. Clear another rehearsal or shorten this input, then retry. The previous state is still available.');
    Object.assign(session, update, { bytes, expiresAt: this.#now() + this.#ttlMs });
    return this.#summary(session);
  }

  open() {
    this.prune();
    if (this.#sessions.size >= this.#maxSessions) {
      // Empty panels contain no work to lose; never evict a saved transcript.
      const empty = [...this.#sessions.values()].find(session => session.status === 'empty');
      if (empty) this.#sessions.delete(empty.rehearsalId);
      else fail('SESSION_LIMIT', 'Too many rehearsals are active. Clear an existing rehearsal before opening another.');
    }
    const session = { rehearsalId: randomUUID(), revision: 0, status: 'empty', input: null, report: null, bytes: 0, expiresAt: this.#now() + this.#ttlMs };
    this.#sessions.set(session.rehearsalId, session);
    return this.#summary(session);
  }

  prepare(rehearsalId, input) {
    const session = this.#session(rehearsalId);
    const snapshot = checkedInput(input);
    return this.#save(session, { input: snapshot, report: null, revision: session.revision + 1, status: 'pending' });
  }

  request(rehearsalId, revision) {
    const session = this.#pending(rehearsalId, revision);
    return { rehearsalId, revision, input: structuredClone(session.input), prompt: buildAnalysisPrompt(session.input, this.#policyText) };
  }

  submit(rehearsalId, revision, feedback) {
    const session = this.#pending(rehearsalId, revision);
    const report = validateFeedback(feedback, session.input);
    const { text, useAI, ...planning } = session.input;
    Object.assign(report, {
      transcript: text.trim(), input: planning, warnings: [],
      meta: {
        generatedAt: new Date(this.#now()).toISOString(), durationSeconds: session.input.durationSeconds || null,
        targetMode: session.input.targetMode || 'points', speakerName: session.input.speakerName || '',
        assignmentInstructions: session.input.assignmentInstructions || '', assignmentFileName: session.input.assignmentFileName || '',
        analysisProvider: 'codex', analysisProviderLabel: 'Codex', analysisModel: 'Codex',
        coachingStatus: 'complete', rehearsalId, revision,
      },
    });
    return this.#save(session, { input: session.input, report, revision, status: 'complete' });
  }

  get(rehearsalId) { return this.#summary(this.#session(rehearsalId)); }

  clear(rehearsalId) {
    const session = this.#session(rehearsalId);
    return this.#save(session, { input: null, report: null, revision: session.revision + 1, status: 'empty' });
  }

  dispose() { this.#sessions.clear(); }
}
