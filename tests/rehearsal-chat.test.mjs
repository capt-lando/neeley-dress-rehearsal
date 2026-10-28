import test from 'node:test';
import assert from 'node:assert/strict';
import { createRehearsalChat } from '../public/rehearsal-chat.js';
import { DEFAULT_CONVERSATION_STARTER } from '../lib/conversation-starter.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
class Element {
  constructor(tag = 'DIV') { this.tagName = tag; this.children = []; this.listeners = new Map(); this.attributes = new Map(); this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false; }
  addEventListener(event, callback) { this.listeners.set(event, callback); }
  removeEventListener(event) { this.listeners.delete(event); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  focus() { this.focused = true; }
  dispatch(event, values = {}) { return this.listeners.get(event)?.({ preventDefault() {}, ...values }); }
  set innerHTML(_) { throw new Error('Unsafe HTML rendering'); }
}
function harness(options = {}) {
  const elements = new Map(), calls = [], pending = [];
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  let context = { context: { phase: 'prepare', targetTalkingPoints: 'Practice once' } }, signIns = 0, serial = 0;
  const ui = createRehearsalChat({ document: { getElementById: get, createElement: tag => new Element(tag.toUpperCase()) },
    request(path, options) { const wait = deferred(); calls.push({ path, ...options }); pending.push(wait); return wait.promise; },
    getContext: options.getContext || (() => context), onSignIn: () => signIns++, uuid: options.uuid || (() => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`) });
  const respond = (index, reply = 'Try one clear recommendation.') => pending[index].resolve({ requestId: JSON.parse(calls[index].body).requestId, model: 'gpt-6-luna', reply });
  const submit = message => { get('chat-message').value = message; get('chat-form').dispatch('submit'); };
  const text = () => get('chat-messages').children.map(row => row.children.at(-1).textContent);
  return { ui, get, calls, pending, respond, submit, text, get signIns() { return signIns; }, setContext(value) { context = value; }, ready() { ui.update({ available: true, signedIn: true, identity: 'student-a', contextKey: 1 }); } };
}

test('the warm initial question and every context update stay local', () => {
  const h = harness(); assert.deepEqual(h.text(), [DEFAULT_CONVERSATION_STARTER]);
  h.ready(); h.ui.update({ hasTranscript: true }); h.ui.update({ available: true });
  assert.equal(h.calls.length, 0); assert.equal(h.get('chat-send').disabled, true);
  assert.match(h.get('chat-context-note').textContent, /current transcript/);
});

test('signed-out chat offers sign-in and cannot spend', () => {
  const h = harness(); h.submit('Who is my audience?');
  assert.equal(h.calls.length, 0); assert.equal(h.signIns, 1); assert.equal(h.get('chat-message').disabled, true);
  h.get('chat-sign-in').dispatch('click'); assert.equal(h.signIns, 2);
});

test('loading documents keeps the typed message local and shows only the approved loading explanation', () => {
  const h = harness({ getContext() { throw Object.assign(new Error('Private file details'), { code: 'DOCUMENTS_LOADING' }); } });
  h.ready(); h.submit('How should I approach this assignment?');
  assert.equal(h.calls.length, 0); assert.equal(h.get('chat-message').value, 'How should I approach this assignment?');
  assert.match(h.get('chat-status').textContent, /documents to finish loading/);
  assert.doesNotMatch(h.get('chat-status').textContent, /Private file details/);
  assert.deepEqual(h.text(), [DEFAULT_CONVERSATION_STARTER]);
});

test('selecting a quote only attaches context and preserves the typed question', async () => {
  const h = harness(); h.ready(); h.get('chat-message').value = 'How do I improve this?';
  h.ui.selectQuote('Everyone should practice more.');
  assert.equal(h.get('chat-message').value, 'How do I improve this?'); assert.equal(h.calls.length, 0);
  assert.equal(h.get('chat-quote-text').textContent, 'Everyone should practice more.'); assert.equal(h.get('chat-quote').hidden, false);
  h.get('chat-form').dispatch('submit');
  assert.equal(JSON.parse(h.calls[0].body).context.selectedQuote, 'Everyone should practice more.');
  assert.equal(JSON.parse(h.calls[0].body).message, 'How do I improve this?');
  h.respond(0); await tick(); assert.equal(h.get('chat-quote').hidden, true);
});

test('sent passages remain visible beside their question and reach later follow-ups', async () => {
  const h = harness(); h.ready(); h.ui.selectQuote('Everyone should practice more.'); h.submit('How do I improve this?');
  const user = h.get('chat-messages').children[1];
  assert.equal(user.children[1].className, 'chat-message-quote');
  assert.equal(user.children[1].children[1].textContent, 'Everyone should practice more.');
  h.respond(0); await tick(); h.submit('Why?');
  const next = JSON.parse(h.calls[1].body);
  const earlierQuestion = next.history.find(message => message.role === 'user').text;
  assert.match(earlierQuestion, /Attached transcript quote \(reference only\):/);
  assert.match(earlierQuestion, /Everyone should practice more\./);
  assert.match(earlierQuestion, /Question: How do I improve this\?/);
  assert.equal(next.context.selectedQuote, undefined); h.respond(1); await tick();
});

test('long attached quotes stay whole in the current request and bounded in future history', async () => {
  const h = harness(); h.ready(); const passage = 'q'.repeat(4000), question = 'u'.repeat(2000);
  h.ui.selectQuote(passage); h.submit(question);
  assert.equal(JSON.parse(h.calls[0].body).context.selectedQuote, passage);
  h.respond(0); await tick(); h.submit('Explain');
  const history = JSON.parse(h.calls[1].body).history;
  assert.ok(history.every(message => message.text.length <= 4000)); assert.ok(history.find(message => message.role === 'user').text.endsWith(question));
  assert.ok(h.ui.getRehearsalContext().length <= 12000); h.respond(1); await tick();
});

test('quote removal never sends an AI request and oversized passages are rejected', () => {
  const h = harness(); h.ready(); h.ui.selectQuote('A sentence.'); h.get('chat-quote-clear').dispatch('click');
  assert.equal(h.get('chat-quote').hidden, true);
  assert.equal(h.calls.length, 0);
  h.ui.selectQuote('x'.repeat(4001)); assert.match(h.get('chat-status').textContent, /shorter/); assert.equal(h.get('chat-quote').hidden, true);
});

test('a sent message uses a frozen preparation context and safe plain text', async () => {
  const h = harness(); h.ready(); h.submit('My class <img src=x onerror=alert(1)>');
  const input = JSON.parse(h.calls[0].body); assert.equal(input.context.phase, 'prepare'); assert.equal(input.recordingId, undefined);
  assert.deepEqual(input.history, [{ role: 'assistant', text: DEFAULT_CONVERSATION_STARTER }]);
  h.setContext({ recordingId: 'new-recording', context: { phase: 'review', text: 'New transcript' } });
  h.respond(0, '<script>alert(1)</script>'); await tick();
  assert.equal(h.text().at(-1), '<script>alert(1)</script>');
  assert.equal(JSON.parse(h.calls[0].body).context.text, undefined);
  assert.equal(h.get('chat-message').disabled, false);
});

test('recording and transcript changes preserve the conversation and pending answer', async () => {
  const h = harness(); h.ready(); h.submit('My audience is my finance professor.');
  h.setContext({ recordingId: 'take-one', context: { phase: 'recording', text: 'Our recommendation is' } });
  h.ui.update({ hasTranscript: true, contextKey: 1 });
  assert.equal(h.calls[0].signal.aborted, false);
  h.respond(0); await tick(); h.submit('Explain the closing.');
  const next = JSON.parse(h.calls[1].body); assert.equal(next.recordingId, 'take-one'); assert.equal(next.context.phase, 'recording');
  assert.equal(next.history.find(message => message.role === 'user').text, 'My audience is my finance professor.');
  h.respond(1); await tick();
});

test('an account change clears private messages, draft, quote and late replies', async () => {
  const h = harness(); h.ready(); h.submit('Private goal'); h.get('chat-message').value = 'Private draft'; h.ui.selectQuote('Private quote');
  h.ui.update({ identity: 'student-b' });
  assert.equal(h.calls[0].signal.aborted, true); assert.equal(h.get('chat-message').value, ''); assert.equal(h.get('chat-quote').hidden, true);
  h.respond(0, 'Private late reply'); await tick(); assert.deepEqual(h.text(), [DEFAULT_CONVERSATION_STARTER]); assert.equal(h.ui.getRehearsalContext(), '');
});

test('opening another saved rehearsal resets private chat, while ordinary update does not', async () => {
  const h = harness(); h.ready(); h.submit('Review this take'); h.respond(0); await tick();
  h.ui.update({ contextKey: 2 }); assert.deepEqual(h.text(), [DEFAULT_CONVERSATION_STARTER]);
  h.ui.update({ signedIn: false, identity: null }); assert.equal(h.get('chat-sign-in').hidden, false);
});

test('uncertain errors can retry only the same request ID and exact frozen payload', async () => {
  const h = harness(); h.ready(); h.ui.selectQuote('Original quote'); h.submit('Help');
  h.pending[0].reject(new Error('Connection interrupted.')); await tick(); assert.equal(h.get('chat-retry').hidden, false);
  h.setContext({ context: { phase: 'review', text: 'Different text' } });
  h.get('chat-retry').dispatch('click'); assert.equal(h.calls[1].body, h.calls[0].body); assert.equal(h.text().filter(text => text === 'Help').length, 1);
  h.respond(1); await tick(); assert.equal(h.get('chat-retry').hidden, true);
});

test('only a confirmed failed request receives a new ID on explicit retry', async () => {
  const h = harness(); h.ready(); h.submit('Help');
  h.pending[0].reject(Object.assign(new Error('The provider could not reply.'), { jobState: 'failed' })); await tick();
  assert.equal(h.calls.length, 1);
  h.get('chat-retry').dispatch('click');
  const first = JSON.parse(h.calls[0].body), next = JSON.parse(h.calls[1].body);
  assert.notEqual(first.requestId, next.requestId); delete first.requestId; delete next.requestId; assert.deepEqual(first, next);
  h.respond(1); await tick(); assert.equal(h.text().filter(text => text === 'Help').length, 1);
});

test('invalid current context leaves the draft intact without an unhandled request', async () => {
  const h = harness(); h.ready(); h.setContext(null); h.submit('Keep my draft'); await tick();
  assert.equal(h.calls.length, 0); assert.equal(h.get('chat-message').value, 'Keep my draft'); assert.match(h.get('chat-status').textContent, /context could not/);
});

test('retry setup failures remain recoverable without another request', async () => {
  let ids = 0;
  const h = harness({ uuid: () => { if (++ids === 2) throw new Error('Unavailable'); return `request-${ids}`; } });
  h.ready(); h.submit('Help'); h.pending[0].reject(Object.assign(new Error('Try again'), { jobState: 'failed' })); await tick();
  h.get('chat-retry').dispatch('click'); await tick();
  assert.equal(h.calls.length, 1); assert.equal(h.get('chat-retry').hidden, false); assert.match(h.get('chat-status').textContent, /context could not/);
  h.get('chat-retry').dispatch('click'); h.respond(1); await tick(); assert.equal(h.calls.length, 2);
});

test('double submit, composition Enter and blank messages do not duplicate calls', async () => {
  const h = harness(); h.ready(); h.submit(' '); assert.equal(h.calls.length, 0);
  h.get('chat-message').value = 'Help'; h.get('chat-message').dispatch('keydown', { key: 'Enter', isComposing: true }); assert.equal(h.calls.length, 0);
  h.get('chat-message').dispatch('keydown', { key: 'Enter', shiftKey: true }); assert.equal(h.calls.length, 0);
  h.get('chat-message').dispatch('keydown', { key: 'Enter' }); h.submit('Duplicate'); assert.equal(h.calls.length, 1);
  h.respond(0); await tick();
});

test('stop and disposal abort waiting and ignore uncooperative late replies', async () => {
  const h = harness(); h.ready(); h.submit('Question'); h.get('chat-stop').dispatch('click');
  assert.equal(h.calls[0].signal.aborted, true); h.respond(0); await tick(); assert.equal(h.text().length, 2);
  h.submit('Next'); h.ui.dispose(); h.respond(1); await tick(); assert.equal(h.calls[1].signal.aborted, true); assert.equal(h.text().length, 3);
});

test('conversation requests and analysis context remain bounded after many turns', async () => {
  const h = harness(); h.ready();
  for (let index = 0; index < 18; index++) { h.submit('u'.repeat(1900)); h.respond(index, 'a'.repeat(3900)); await tick(); }
  for (const call of h.calls) {
    const { history } = JSON.parse(call.body); assert.ok(history.length <= 12); assert.ok(history.reduce((sum, message) => sum + message.text.length, 0) <= 16000);
  }
  const context = h.ui.getRehearsalContext(); assert.ok(context.length <= 12000); assert.match(context, /not recorded speech/);
});

test('mismatched or oversized responses are not added to conversation', async () => {
  const h = harness(); h.ready(); h.submit('Help'); h.pending[0].resolve({ requestId: 'another', reply: 'Wrong reply' }); await tick();
  assert.equal(h.text().length, 2); assert.equal(h.get('chat-retry').hidden, false);
  h.get('chat-retry').dispatch('click'); h.respond(1, 'x'.repeat(4001)); await tick(); assert.equal(h.text().length, 2);
});

const reportWithStarter = conversationStarter => ({ transcript: 'We should expand tutoring.', analysis: { method: 'ai', conversationStarter } });
const firstStarter = 'Your tutoring proposal is clear. What example could make its benefit more concrete?';
const nextStarter = 'Your revised ending asks for a pilot. How would you make that next step easier to act on?';

test('fresh feedback replaces only the untouched opener and includes that exact question on the first send', async () => {
  const h = harness(); h.ready(); h.ui.update({ hasTranscript: true, report: reportWithStarter(firstStarter) });
  assert.deepEqual(h.text(), [firstStarter]); assert.equal(h.calls.length, 0);
  assert.equal(h.ui.getRehearsalContext(), '', 'an unanswered generated question is not student preparation');
  h.submit('I could describe a student working an evening shift.');
  assert.deepEqual(JSON.parse(h.calls[0].body).history, [{ role: 'assistant', text: firstStarter }]);
  h.respond(0); await tick();
  assert.match(h.ui.getRehearsalContext(), /What example could make its benefit/);
});

test('updated reports preserve a conversation and its pending response instead of replacing its opening', async () => {
  const h = harness(); h.ready(); h.ui.update({ report: reportWithStarter(firstStarter) });
  h.submit('I will use the evening-shift example.');
  h.ui.update({ report: reportWithStarter(nextStarter), hasTranscript: true });
  assert.equal(h.calls[0].signal.aborted, false); assert.equal(h.text()[0], firstStarter);
  h.respond(0); await tick(); h.ui.update({ report: reportWithStarter(nextStarter) });
  assert.equal(h.text()[0], firstStarter); assert.equal(h.text().length, 3);
  h.submit('How can I introduce it?');
  assert.equal(JSON.parse(h.calls[1].body).history[0].text, firstStarter);
  h.respond(1); await tick();
});

test('feedback arriving while a student drafts or selects a passage does not change the question being answered', () => {
  const h = harness(); h.ready(); h.ui.update({ report: reportWithStarter(firstStarter) });
  h.get('chat-message').value = 'My draft'; h.ui.update({ report: reportWithStarter(nextStarter) });
  assert.equal(h.text()[0], firstStarter); assert.equal(h.get('chat-message').value, 'My draft');
  h.get('chat-message').value = ''; h.ui.selectQuote('We should expand tutoring.');
  h.ui.update({ report: reportWithStarter(nextStarter) }); assert.equal(h.text()[0], firstStarter);
  h.get('chat-quote-clear').dispatch('click'); h.ui.update({ report: reportWithStarter(nextStarter) });
  assert.equal(h.text()[0], nextStarter); assert.equal(h.calls.length, 0);
});

test('feedback refresh leaves an uncertain retry payload and its original opening untouched', async () => {
  const h = harness(); h.ready(); h.ui.update({ report: reportWithStarter(firstStarter) }); h.submit('An evening-shift example.');
  h.pending[0].reject(new Error('Connection interrupted.')); await tick();
  h.ui.update({ report: reportWithStarter(nextStarter) });
  assert.equal(h.text()[0], firstStarter); assert.equal(h.get('chat-retry').hidden, false);
  h.get('chat-retry').dispatch('click'); assert.equal(h.calls[1].body, h.calls[0].body);
  h.respond(1); await tick();
});

test('opening another saved take uses its own opener and account changes remove private report context', () => {
  const h = harness(); h.ready(); h.ui.update({ report: reportWithStarter(firstStarter), hasTranscript: true });
  h.ui.update({ contextKey: 2, report: reportWithStarter(nextStarter), hasTranscript: true });
  assert.deepEqual(h.text(), [nextStarter]); assert.equal(h.calls.length, 0);
  h.ui.update({ identity: 'student-b' }); assert.deepEqual(h.text(), [DEFAULT_CONVERSATION_STARTER]);
  h.ui.update({ available: true }); assert.deepEqual(h.text(), [DEFAULT_CONVERSATION_STARTER]);
  h.ui.update({ report: reportWithStarter(firstStarter) });
  h.ui.update({ signedIn: false, report: reportWithStarter(firstStarter) });
  assert.deepEqual(h.text(), [DEFAULT_CONVERSATION_STARTER]);
});

test('old report feedback generates a local specific question and invalid generated markup never becomes HTML', () => {
  const h = harness(); h.ready();
  h.ui.update({ report: { analysis: { method: 'ai', conversationStarter: '<img src=x onerror=bad()>?', improvements: ['Use a concrete example of the evening schedule.'] } } });
  assert.match(h.text()[0], /concrete example of the evening schedule/);
  assert.doesNotMatch(h.text()[0], /img|audience/); assert.equal(h.calls.length, 0);
});

test('a context reset cannot briefly reuse the previous report before the app finishes restoring or clearing it', () => {
  const h = harness(); h.ready(); const oldReport = reportWithStarter(firstStarter);
  h.ui.update({ report: oldReport, hasTranscript: true });
  h.ui.update({ contextKey: 2, report: oldReport, hasTranscript: true });
  assert.deepEqual(h.text(), [DEFAULT_CONVERSATION_STARTER]);
  h.ui.update({ report: null, hasTranscript: false }); assert.deepEqual(h.text(), [DEFAULT_CONVERSATION_STARTER]);
  h.ui.update({ report: reportWithStarter(nextStarter), hasTranscript: true }); assert.deepEqual(h.text(), [nextStarter]);
  h.ui.update({ report: oldReport });
  h.ui.update({ identity: 'student-b', report: oldReport, hasTranscript: true });
  assert.deepEqual(h.text(), [DEFAULT_CONVERSATION_STARTER]);
});
