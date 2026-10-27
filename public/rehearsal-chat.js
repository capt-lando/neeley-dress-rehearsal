const GREETING = 'Who is your audience?';
const MAX_HISTORY = 12;
const MAX_HISTORY_CHARS = 16000;
const MAX_QUOTE = 4000;

// The conversation lives in this tab. Only an explicit send calls the AI coach.
export function createRehearsalChat({ document, request, getContext, onSignIn = () => {}, uuid = () => crypto.randomUUID() }) {
  const $ = id => document.getElementById(id);
  const elements = Object.fromEntries(['messages', 'status', 'retry', 'stop', 'quote', 'quote-text', 'quote-clear', 'form', 'message', 'send', 'sign-in', 'context-note'].map(name => [name, $(`chat-${name}`)]));
  let messages = [], quote = '', pending = null, retry = null, generation = 0, disposed = false, quoteAnimation = null;
  let access = { available: false, signedIn: false, identity: undefined, contextKey: undefined, hasTranscript: false };
  const listeners = [];
  const listen = (element, event, callback) => { element.addEventListener(event, callback); listeners.push(() => element.removeEventListener(event, callback)); };
  const status = text => { elements.status.textContent = text; };

  function appendMessage(role, text, attachedQuote = '') {
    const row = document.createElement('div');
    row.className = `chat-message chat-message-${role}`;
    const label = document.createElement('span'); label.className = 'sr-only'; label.textContent = role === 'user' ? 'You: ' : 'Coach: ';
    const body = document.createElement('p'); body.textContent = text;
    row.append(label);
    if (attachedQuote) {
      const excerpt = document.createElement('blockquote'); excerpt.className = 'chat-message-quote';
      const caption = document.createElement('span'); caption.textContent = 'Selected from your transcript';
      const passage = document.createElement('p'); passage.textContent = attachedQuote;
      excerpt.append(caption, passage); row.append(excerpt);
    }
    row.append(body); elements.messages.append(row);
    elements.messages.scrollTop = elements.messages.scrollHeight;
  }
  function renderConversation() {
    elements.messages.replaceChildren(); appendMessage('assistant', GREETING);
    for (const message of messages) appendMessage(message.role, message.text, message.quote);
  }
  function recordMessage(role, text, attachedQuote = '') {
    messages.push({ role, text, ...(attachedQuote ? { quote: attachedQuote } : {}) });
    if (messages.length > 60) { messages = messages.slice(-60); renderConversation(); }
    else appendMessage(role, text, attachedQuote);
  }
  function renderAccess() {
    const canSend = access.available && access.signedIn;
    elements.message.disabled = !canSend || Boolean(pending);
    elements.send.disabled = !canSend || Boolean(pending) || !elements.message.value.trim();
    elements['sign-in'].hidden = access.signedIn;
    elements.stop.hidden = !pending;
    elements.retry.hidden = !retry || !canSend || Boolean(pending);
    elements.form.setAttribute('aria-busy', String(Boolean(pending)));
    elements['context-note'].textContent = !access.signedIn ? 'Sign in to plan your take and discuss your feedback.'
      : !access.available ? 'Your coach is connecting. Your rehearsal can stay open.'
        : access.hasTranscript ? 'Your current transcript and preparation are in context.'
          : 'Here before, during, and after your rehearsal.';
  }
  function historyWithinLimit(limit = MAX_HISTORY_CHARS) {
    const result = []; let length = 0;
    for (const message of messages.slice(-MAX_HISTORY).reverse()) {
      let text = message.text;
      if (message.quote) {
        const prefix = 'Attached transcript quote (reference only):\n', suffix = `\nQuestion: ${message.text}`;
        const room = 4000 - prefix.length - suffix.length;
        const excerpt = message.quote.length > room ? `${message.quote.slice(0, room - 1)}…` : message.quote;
        text = `${prefix}${excerpt}${suffix}`;
      }
      if (length + text.length > limit) break;
      result.unshift({ role: message.role, text }); length += text.length;
    }
    return result;
  }
  function showQuote(animate = false) {
    quoteAnimation?.cancel(); quoteAnimation = null;
    elements['quote-text'].textContent = quote;
    elements.quote.hidden = !quote;
    if (quote && animate && !document.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      quoteAnimation = elements.quote.animate?.([
        { opacity: .45, transform: 'translateY(5px)', backgroundColor: '#eee3f7' },
        { opacity: 1, transform: 'translateY(0)', backgroundColor: '#faf7fc' },
      ], { duration: 220, easing: 'ease-out' }) || null;
    }
  }
  function cancelPending() {
    generation++; pending?.controller.abort(); pending = null; retry = null;
    renderAccess();
  }
  function reset() {
    cancelPending(); messages = []; quote = ''; elements.message.value = ''; status(''); showQuote(); renderConversation(); renderAccess();
  }

  async function send({ retrying = false } = {}) {
    if (disposed || pending) return;
    if (!access.signedIn) { onSignIn(); return; }
    if (!access.available) { status('Your coach is not connected yet. Try again shortly.'); return; }
    const message = elements.message.value.trim();
    if (!retrying && (!message || message.length > 2000)) return;
    let attempt;
    if (retrying) {
      if (!retry) return;
      attempt = retry;
      if (attempt.failed) {
        try {
          const requestId = uuid();
          attempt = { requestId, body: JSON.stringify({ ...JSON.parse(attempt.body), requestId }) };
        } catch { status('Your rehearsal context could not be prepared. Please try again.'); return; }
      }
    } else {
      try {
        const current = getContext();
        const requestId = uuid();
        attempt = { requestId, body: JSON.stringify({ requestId, ...(current.recordingId ? { recordingId: current.recordingId } : {}), message,
          history: historyWithinLimit(), context: { ...current.context, ...(quote ? { selectedQuote: quote } : {}) } }) };
      } catch { status('Your rehearsal context could not be prepared. Please try again.'); return; }
      recordMessage('user', message, quote);
      elements.message.value = ''; quote = ''; showQuote();
    }
    retry = null;
    const controller = new AbortController(), token = ++generation;
    pending = { controller }; status('Thinking through your rehearsal…'); renderAccess();
    try {
      const result = await request('/api/coach-chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: attempt.body, signal: controller.signal });
      if (disposed || token !== generation || controller.signal.aborted) return;
      if (result?.requestId !== attempt.requestId || typeof result?.reply !== 'string' || !result.reply.trim() || result.reply.length > 4000) throw new Error('The coach returned an unreadable reply. Try again.');
      recordMessage('assistant', result.reply.trim()); status('');
    } catch (error) {
      if (disposed || token !== generation || controller.signal.aborted) return;
      retry = { ...attempt, failed: error?.jobState === 'failed' };
      // The transport supplies safe public errors; never display response bodies or request details.
      status(typeof error?.message === 'string' && error.message.length < 400 ? error.message : 'Your coach could not reply. Please try again.');
    } finally {
      if (!disposed && token === generation) { pending = null; renderAccess(); }
    }
  }

  listen(elements.form, 'submit', event => { event.preventDefault(); void send(); });
  listen(elements.message, 'input', () => renderAccess());
  listen(elements.message, 'keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(); }
  });
  listen(elements.retry, 'click', () => { void send({ retrying: true }); });
  listen(elements.stop, 'click', () => { cancelPending(); status('Stopped waiting. The request may still be processed.'); });
  listen(elements['sign-in'], 'click', () => onSignIn());
  listen(elements['quote-clear'], 'click', () => { quote = ''; showQuote(); elements.message.focus(); });
  renderConversation(); showQuote(); renderAccess();
  return {
    update(next = {}) {
      if (disposed) return;
      const changed = (next.identity !== undefined && next.identity !== access.identity) ||
        (next.contextKey !== undefined && access.contextKey !== undefined && next.contextKey !== access.contextKey) ||
        (next.signedIn === false && access.signedIn);
      access = { ...access, ...next };
      if (changed) reset(); else renderAccess();
    },
    reset,
    selectQuote(text) {
      if (disposed || typeof text !== 'string') return;
      const selected = text.trim();
      if (selected.length > MAX_QUOTE) { status('Select a shorter passage—up to 4,000 characters.'); return; }
      quote = selected; showQuote(Boolean(quote));
      if (quote) elements.message.focus();
    },
    cancelPending,
    getRehearsalContext() {
      const recent = historyWithinLimit(10000);
      while (recent.length) {
        const context = JSON.stringify({ source: 'Coaching conversation, not recorded speech', messages: recent });
        if (context.length <= 12000) return context;
        recent.shift();
      }
      return '';
    },
    dispose() { if (disposed) return; cancelPending(); quoteAnimation?.cancel(); quoteAnimation = null; disposed = true; for (const remove of listeners) remove(); messages = []; quote = ''; },
  };
}
