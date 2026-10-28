import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostedSession } from '../lib/hosted-session.mjs';

const ownerId = '11111111-1111-4111-8111-111111111111';
const otherOwner = '22222222-2222-4222-8222-222222222222';
const recordingId = '33333333-3333-4333-8333-333333333333';
const project = 'https://pilot.supabase.co';
function memory() {
  const values = new Map();
  return { values, getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

test('current rehearsal survives recreation with exact draft text and stays isolated by owner and project', () => {
  const storage = memory(), session = createHostedSession(storage, project);
  const draft = { ownerId, recordingId, transcript: 'Café 🚀\nEdited  wording.', transcriptBasis: 'Original wording.',
    reportGeneratedAt: '2026-10-28T18:00:00.000Z', targetMode: 'both', targetScript: 'Full script.', targetTalkingPoints: 'Point one\nPoint two',
    plannedIntroduction: 'Imagine this.', plannedTransitions: 'Next, the plan.', instructorRubric: 'Clarity matters.', rubricFileName: 'Teacher.pdf',
    assignmentInstructions: 'Explain the proposal.', assignmentFileName: 'Assignment.docx', page: 'history' };
  assert.equal(session.save(ownerId, draft), true);
  assert.deepEqual(createHostedSession(storage, project).read(ownerId), { version: 1, ...draft });
  assert.equal(session.read(otherOwner), null);
  assert.equal(createHostedSession(storage, 'https://other.supabase.co').read(ownerId), null);
  assert.equal(session.save(otherOwner, draft), false);
});

test('only bounded editor text and a recording reference are stored, never arbitrary report or credential fields', () => {
  const storage = memory(), session = createHostedSession(storage, project);
  const valid = { ownerId, recordingId, transcript: 'Exact text.', token: 'secret', audio: 'media bytes', report: { private: 'not stored here' } };
  assert.equal(session.save(ownerId, valid), true);
  const raw = [...storage.values.values()][0];
  assert.doesNotMatch(raw, /secret|media bytes|private|not stored here/);
  const previous = session.read(ownerId);
  for (const [field, limit] of [['transcript', 60000], ['transcriptBasis', 60000], ['targetScript', 30000], ['targetTalkingPoints', 30000],
    ['plannedIntroduction', 8000], ['plannedTransitions', 8000], ['instructorRubric', 40000], ['assignmentInstructions', 40000],
    ['rubricFileName', 255], ['assignmentFileName', 255], ['reportGeneratedAt', 64]]) {
    assert.equal(session.save(ownerId, { ...valid, [field]: 'x'.repeat(limit + 1) }), false);
    assert.deepEqual(session.read(ownerId), previous, 'an invalid snapshot must not erase valid current work');
  }
  for (const invalid of [{ ...valid, transcript: {} }, { ...valid, recordingId: 'foreign-path' }, { ...valid, targetMode: 'invalid' }, { ...valid, page: 'invalid' }]) {
    assert.equal(session.save(ownerId, invalid), false);
  }
});

test('corrupt, unsupported and foreign snapshots cannot be restored', () => {
  const storage = memory(), session = createHostedSession(storage, project);
  for (const value of ['{broken', 'x'.repeat(512 * 1024 + 1), JSON.stringify({ version: 2, ownerId }), JSON.stringify({ version: 1, ownerId: otherOwner })]) {
    storage.setItem(`neeley-current:${project}:${ownerId}`, value);
    assert.equal(session.read(ownerId), null);
  }
});

test('JSON escaping cannot create an unreadable oversized snapshot or replace prior saved work', () => {
  const storage = memory(), session = createHostedSession(storage, project);
  session.save(ownerId, { ownerId, recordingId, transcript: 'Keep this restorable rehearsal.' });
  const before = storage.getItem(`neeley-current:${project}:${ownerId}`);
  const oversized = { ownerId, recordingId, transcript: '"'.repeat(60000), transcriptBasis: '\n'.repeat(60000),
    targetScript: '"'.repeat(30000), targetTalkingPoints: '\n'.repeat(30000),
    plannedIntroduction: '"'.repeat(8000), plannedTransitions: '\n'.repeat(8000),
    instructorRubric: '"'.repeat(40000), assignmentInstructions: '\n'.repeat(40000) };
  assert.ok(JSON.stringify(oversized).length > 512 * 1024, 'each field is valid but serialized escaping exceeds the snapshot bound');
  assert.equal(session.save(ownerId, oversized), false);
  assert.equal(storage.getItem(`neeley-current:${project}:${ownerId}`), before);
  assert.equal(session.read(ownerId).transcript, 'Keep this restorable rehearsal.');
});

test('deleting another recording preserves current work while explicit clear removes it', () => {
  const session = createHostedSession(memory(), project);
  session.save(ownerId, { ownerId, recordingId, transcript: 'Saved work.' });
  session.clear(ownerId, otherOwner); assert.equal(session.read(ownerId).recordingId, recordingId);
  session.clear(ownerId, recordingId); assert.equal(session.read(ownerId), null);
  session.save(ownerId, { ownerId, plannedIntroduction: 'An unfinished draft.' });
  assert.equal(session.read(ownerId).recordingId, '');
  session.clear(ownerId); assert.equal(session.read(ownerId), null);
});

test('unavailable tab storage does not prevent recording, sign-out or explicit reset', () => {
  const session = createHostedSession({ getItem() { throw new Error('Unavailable'); }, setItem() { throw new Error('Quota'); }, removeItem() { throw new Error('Unavailable'); } }, project);
  assert.equal(session.save(ownerId, { ownerId, recordingId }), false);
  assert.equal(session.read(ownerId), null);
  assert.doesNotThrow(() => session.clear(ownerId));
});
