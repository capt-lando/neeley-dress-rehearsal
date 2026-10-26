const NAMES = new Set(['session_started', 'section_engaged', 'recording_completed', 'analysis_requested', 'analysis_completed', 'analysis_failed']);
const SECTIONS = new Set(['prepare', 'rehearse', 'feedback']);

/** Content-free, opt-in events. Identity is attached by the authenticated server. */
export function createUsageAnalytics({ send, now = () => performance.now(), uuid = () => crypto.randomUUID(), idleMs = 60_000 } = {}) {
  let consent = false, sessionId = '', section = 'prepare', visible = false, focused = false;
  let last = now(), activityAt = last, seconds = 0, queue = [], sending = null, controller = null;
  function track(name) {
    if (!consent || !NAMES.has(name) || name === 'section_engaged') return;
    if (queue.length < 100) queue.push({ id: uuid(), sessionId, name, section });
  }
  function tick() {
    const time = now();
    if (consent && visible && focused) seconds += Math.max(0, Math.min(time, activityAt + idleMs) - last) / 1000;
    last = time;
  }
  function commitDwell() {
    tick();
    while (seconds >= 0.1 && queue.length < 100) {
      const activeSeconds = Math.min(60, Math.round(seconds * 1000) / 1000);
      queue.push({ id: uuid(), sessionId, name: 'section_engaged', section, activeSeconds });
      seconds = Math.max(0, seconds - activeSeconds);
    }
    seconds = 0;
  }
  function setConsent(value) {
    const next = value === true;
    if (next === consent) return;
    controller?.abort(); controller = null; sending = null; queue = []; seconds = 0; consent = next; last = activityAt = now();
    sessionId = next ? uuid() : '';
    if (next) track('session_started');
  }
  async function flush() {
    if (!consent) return;
    commitDwell();
    if (sending || !queue.length) return sending;
    const batch = queue.splice(0, 20), owner = sessionId;
    controller = new AbortController();
    const current = controller;
    sending = Promise.resolve().then(() => { if (!current.signal.aborted) return send(batch, { signal: current.signal }); }).catch(() => {
      if (consent && sessionId === owner && !current.signal.aborted) queue = [...batch, ...queue].slice(0, 100);
    }).finally(() => { if (controller === current) { controller = null; sending = null; } });
    return sending;
  }
  return {
    setConsent, track, flush,
    activity() { tick(); activityAt = now(); },
    setView(next) {
      if (next.section !== undefined && !SECTIONS.has(next.section)) return;
      commitDwell();
      if (next.section) section = next.section;
      if (typeof next.visible === 'boolean') visible = next.visible;
      if (typeof next.focused === 'boolean') focused = next.focused;
    },
    dispose() { setConsent(false); },
  };
}
