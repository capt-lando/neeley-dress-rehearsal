const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIELDS = Object.freeze({
  transcript: 60_000, transcriptBasis: 60_000, reportGeneratedAt: 64,
  targetScript: 30_000, targetTalkingPoints: 30_000,
  plannedIntroduction: 8_000, plannedTransitions: 8_000,
  instructorRubric: 40_000, rubricFileName: 255,
  assignmentInstructions: 40_000, assignmentFileName: 255,
});
const MAX_SNAPSHOT = 512 * 1024;

function snapshot(ownerId, value) {
  if (!UUID.test(ownerId || '') || !value || typeof value !== 'object' || Array.isArray(value) || value.ownerId !== ownerId) return null;
  const recordingId = value.recordingId ?? '';
  if (recordingId !== '' && (typeof recordingId !== 'string' || !UUID.test(recordingId))) return null;
  const targetMode = value.targetMode ?? 'points', page = value.page ?? 'rehearse';
  if (!['points', 'script', 'both'].includes(targetMode) || !['rehearse', 'history'].includes(page)) return null;
  const clean = { version: 1, ownerId, recordingId, targetMode, page };
  for (const [name, limit] of Object.entries(FIELDS)) {
    const text = value[name] ?? '';
    if (typeof text !== 'string' || text.length > limit) return null;
    clean[name] = text;
  }
  return clean;
}

/** Same-tab editor state only. Saved audio and complete feedback stay in the cloud. */
export function createHostedSession(storage, project) {
  const key = ownerId => `neeley-current:${project}:${ownerId}`;
  function read(ownerId) {
    if (!UUID.test(ownerId || '')) return null;
    try {
      const raw = storage.getItem(key(ownerId));
      if (!raw || raw.length > MAX_SNAPSHOT) return null;
      const value = JSON.parse(raw);
      return value?.version === 1 ? snapshot(ownerId, value) : null;
    } catch { return null; }
  }
  function save(ownerId, value) {
    const clean = snapshot(ownerId, value);
    if (!clean) return false;
    const serialized = JSON.stringify(clean);
    if (serialized.length > MAX_SNAPSHOT) return false;
    try { storage.setItem(key(ownerId), serialized); return true; }
    catch { return false; }
  }
  function clear(ownerId, recordingId) {
    if (!UUID.test(ownerId || '') || recordingId !== undefined && read(ownerId)?.recordingId !== recordingId) return;
    try { storage.removeItem(key(ownerId)); } catch { /* Storage may be unavailable; never block the user's account action. */ }
  }
  return { read, save, clear };
}
