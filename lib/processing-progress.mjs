/** A request timeline driven by confirmed events, never estimated percentages. */
export function createProcessingProgress({ container, list, status, elapsed, hosted, analysis, needsTranscript, signal, isCurrent = () => true, now = Date.now, setTimer = setInterval, clearTimer = clearInterval }) {
  const definitions = hosted
    ? [['prepare', 'Preparing'], ...(needsTranscript ? [['transcript', 'Transcribing']] : []), ...(analysis ? [['coach', 'AI coach'], ['check', 'Checking feedback']] : []), ['ready', 'Ready']]
    : [['working', 'Processing'], ['ready', 'Ready']];
  const document = container.ownerDocument;
  const steps = definitions.map(([key, label]) => {
    const item = document.createElement('li'), dot = document.createElement('span'), text = document.createElement('span');
    dot.className = 'processing-dot'; dot.setAttribute('aria-hidden', 'true'); text.className = 'processing-label'; text.textContent = label;
    item.append(dot, text); return { key, label, item, dot, text, done: false };
  });
  const started = now(); let current = 0, furthest = 0, stopped = false, timer;
  const alive = () => !stopped && isCurrent() && !signal?.aborted;
  const tick = () => { const seconds = Math.max(0, Math.floor((now() - started) / 1000)); elapsed.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} elapsed`; };
  function render() {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]; step.item.dataset.state = step.incomplete ? 'incomplete' : step.done ? 'complete' : current === i ? 'current' : 'waiting';
      step.dot.textContent = step.incomplete ? '!' : step.done ? '✓' : ''; step.item.setAttribute('aria-label', `${step.text.textContent}, ${step.item.dataset.state}`);
      if (current === i) step.item.setAttribute('aria-current', 'step'); else step.item.removeAttribute('aria-current');
    }
  }
  function advance(key, message, done = false) {
    if (!alive()) return;
    const index = steps.findIndex(step => step.key === key);
    if (index < furthest || index < 0) return;
    furthest = index; current = done ? -1 : index;
    steps.forEach((step, i) => { if (i < index || i === index && done) step.done = true; });
    status.textContent = message; render();
  }
  function stop() { stopped = true; current = -1; clearTimer(timer); signal?.removeEventListener('abort', abort); }
  function finish(kind = 'complete', message = '') {
    if (stopped || !isCurrent()) return;
    tick(); stop(); container.dataset.state = kind;
    if (kind === 'complete') steps.forEach(step => { step.done = true; });
    if (kind === 'partial') { const check = steps.find(step => step.key === 'check' || step.key === 'working'); if (check) check.incomplete = true; steps.at(-1).done = true; steps.at(-1).text.textContent = 'Feedback ready'; }
    status.textContent = message || (kind === 'complete' ? analysis ? 'Your feedback is ready.' : 'Your transcript is ready.' : kind === 'cancelled' ? hosted ? 'Stopped waiting. Processing may still finish in saved rehearsals.' : 'Stopped. Your recording is still here.' : 'Processing stopped. Please try again.');
    render();
  }
  const abort = () => finish('cancelled');
  list.replaceChildren(...steps.map(step => step.item)); container.hidden = false; container.dataset.state = 'working';
  status.textContent = hosted ? 'Preparing your rehearsal…' : analysis ? 'Preparing your request…' : 'Transcribing on this device…';
  tick(); render(); timer = setTimer(() => { if (alive()) tick(); }, 1000); signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  return {
    event(event, phase) {
      if (!hosted || !alive() || event?.type !== 'progress') return;
      switch (event.stage) {
        case 'accepted': if (furthest === 0) advance('prepare', 'Request accepted.'); break;
        case 'audio_validated': advance('transcript', 'Audio checked. Preparing transcription…'); break;
        case 'speech_requested': advance('transcript', 'Waiting for your transcript. You can keep listening.'); break;
        case 'transcript_received': advance('transcript', 'Transcript received.', true); break;
        case 'coach_requested': advance('coach', 'Waiting for AI feedback…'); break;
        case 'feedback_received': advance('check', 'Feedback received. Checking the response…'); break;
        case 'feedback_validated': advance('check', 'Feedback checked. Saving your rehearsal…', true); break;
        case 'saved': case 'cached_result': advance(phase === 'transcribe' ? 'transcript' : 'check', event.stage === 'saved' ? 'Saved privately.' : 'Saved result recovered.', true); break;
      }
    },
    transcriptReady() { if (hosted) advance('transcript', 'Your transcript is ready.', true); },
    coachingRequested() { if (!hosted && alive()) status.textContent = 'Coaching request in progress…'; },
    finish,
    clear() { stop(); if (isCurrent()) { container.hidden = true; container.dataset.state = 'idle'; render(); } },
  };
}
