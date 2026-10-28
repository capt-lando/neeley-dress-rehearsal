import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { renderDiscussableTranscript, selectedTranscriptQuote, createAnnotationPopover } from '../lib/transcript-discussion.mjs';

function insertion(text, offset, number) {
  const anchorStart = 0, anchorEnd = offset || text.length;
  return { category: 'transition', kind: 'insertion', quote: '', start: offset, end: offset,
    anchorQuote: text.slice(anchorStart, anchorEnd), anchorStart, anchorEnd, placement: offset ? 'after' : 'before',
    comment: 'Connect this idea to the next point.', suggestion: 'With that context, consider the solution.', assessment: 'needs_work', number };
}

function segmentsFor(text, insertions = [], spans = []) {
  const boundaries = [...new Set([0, text.length, ...insertions.map(item => item.start), ...spans.flatMap(item => [item.start, item.end])])].sort((a, b) => a - b);
  return boundaries.flatMap((start, index) => {
    const pieces = insertions.filter(item => item.start === start).map(annotation => ({ text: '', annotation }));
    const end = boundaries[index + 1];
    if (end > start) pieces.push({ text: text.slice(start, end), annotation: spans.find(item => item.start <= start && item.end >= end) || null });
    return pieces;
  });
}

function render(text, insertions = [], spans = []) {
  const { document, window } = parseHTML('<html><body><div id="transcript"></div><aside id="bubble" hidden><h3 id="title"></h3><p id="explanation"></p><section id="revision"><p id="suggestion"></p></section><button id="close">Close</button><button id="discuss">Discuss</button></aside></body></html>');
  const container = document.getElementById('transcript');
  renderDiscussableTranscript({ document, container, text, segments: segmentsFor(text, insertions, spans) });
  return { document, window, container };
}

function renderedContent(container) {
  const references = [];
  let text = '';
  function visit(node) {
    if (node.nodeType === 3) { text += node.textContent; return; }
    if (node.classList?.contains('annotation-ref')) {
      references.push({ number: Number(node.dataset.annotationNumber), offset: text.length }); return;
    }
    for (const child of node.childNodes) visit(child);
  }
  visit(container);
  return { text, references };
}

test('transition gaps render exactly once at transcript and sentence boundaries without changing source text', () => {
  const text = 'First sentence. Second sentence.\nThird sentence.  ';
  const offsets = [0, text.indexOf(' Second'), text.indexOf('Second'), text.indexOf('Third'), text.length];
  const items = offsets.map((offset, index) => insertion(text, offset, index + 1));
  const { container } = render(text, items);
  assert.deepEqual(renderedContent(container), { text, references: items.map(item => ({ number: item.number, offset: item.start })) });
  assert.equal(container.querySelectorAll('.annotation-transition-ref').length, items.length);
  for (const item of items) {
    const ref = container.querySelector(`#annotation-quote-${item.number}`);
    assert.equal(ref.getAttribute('aria-label'), `Suggested transition note ${item.number}`);
    assert.equal(ref.getAttribute('href'), `#annotation-note-${item.number}`);
    assert.equal(ref.getAttribute('aria-describedby'), `annotation-note-${item.number}`);
    assert.equal(ref.getAttribute('aria-haspopup'), 'dialog');
    assert.equal(ref.getAttribute('aria-controls'), 'annotation-bubble');
    assert.equal(ref.getAttribute('aria-expanded'), 'false');
    assert.equal(ref.querySelector('.annotation-caret').textContent, '');
    assert.equal(ref.querySelector('.annotation-caret').getAttribute('aria-hidden'), 'true');
    assert.equal(ref.closest('.transcript-sentence').getAttribute('role'), null);
  }
});

test('gaps in whitespace and several gaps at the same offset retain their exact positions and order', () => {
  const text = 'One idea. \t \n\nAnother idea.\n';
  const offsets = [text.indexOf('\t'), text.indexOf('\n'), text.indexOf('\n') + 1, text.indexOf('Another'), text.indexOf('Another')];
  const items = offsets.map((offset, index) => insertion(text, offset, index + 1));
  const { container } = render(text, items);
  assert.deepEqual(renderedContent(container), { text, references: items.map(item => ({ number: item.number, offset: item.start })) });
});

test('a gap inside a highlighted passage preserves all fragments and a single original reference', () => {
  const text = 'Our first point matters. Our second point follows.';
  const span = { category: 'clarity', quote: text, start: 0, end: text.length, comment: 'Explain this connection.', number: 1 };
  const gap = insertion(text, text.indexOf(' point'), 2);
  const { container } = render(text, [gap], [span]);
  assert.equal(renderedContent(container).text, text);
  assert.deepEqual(renderedContent(container).references, [{ number: 2, offset: gap.start }, { number: 1, offset: text.length }]);
  assert.equal([...container.querySelectorAll('mark')].map(mark => mark.textContent).join(''), text);
  assert.ok(container.querySelectorAll('mark[data-annotation-number="1"]').length > 1);
  assert.equal(container.querySelectorAll('#annotation-quote-1').length, 1);
  assert.equal(container.querySelectorAll('.annotation-ref[data-annotation-number="1"]').length, 1);
  assert.equal(container.querySelectorAll('[role="button"] [role="button"]').length, 0);
});

test('Unicode and repeated passages use offsets instead of searching for a matching quote', () => {
  const text = '🌙 Café — together.\n🌙 Café — together.\n再见。';
  const offset = text.lastIndexOf('Café');
  const gap = insertion(text, offset, 1);
  const { container } = render(text, [gap]);
  assert.deepEqual(renderedContent(container), { text, references: [{ number: 1, offset }] });
  assert.equal(selectedTranscriptQuote(container, { isCollapsed: false, rangeCount: 1,
    anchorNode: container.firstChild, focusNode: container.lastChild,
    getRangeAt: () => ({ cloneContents: () => container.cloneNode(true) }) }), text);
  assert.ok(!container.textContent.includes(gap.suggestion));
});

test('a transition already spoken remains highlighted and gets a decorative caret reference', () => {
  const text = 'We know the problem. Now consider the solution.';
  const quote = 'Now consider the solution.';
  const span = { category: 'transition', quote, start: text.indexOf(quote), end: text.length,
    comment: 'Make the relationship to the problem explicit.', suggestion: 'To address that problem, consider this solution.', assessment: 'needs_work', number: 1 };
  const { container } = render(text, [], [span]);
  assert.equal(container.querySelector('mark.annotation-transition').textContent, quote);
  assert.equal(container.querySelector('mark').dataset.assessment, 'needs_work');
  assert.equal(container.querySelector('.annotation-transition-ref .annotation-caret').textContent, '');
  assert.deepEqual(renderedContent(container), { text, references: [{ number: 1, offset: text.length }] });
});

test('ordinary and live transcript rendering retain their existing sentence and annotation behavior', () => {
  const text = '  Clear words.\nSpecific evidence.  ';
  const live = render(text);
  assert.equal(live.container.textContent, text);
  assert.equal(live.container.querySelectorAll('.annotation-ref').length, 0);
  assert.ok(live.container.querySelector('.transcript-sentence[role="button"]'));
  const quote = 'Specific evidence.';
  const span = { category: 'great', quote, start: text.indexOf(quote), end: text.indexOf(quote) + quote.length, comment: 'Concrete support.', number: 1 };
  const { container } = render(text, [], [span]);
  assert.equal(container.querySelector('.annotation-star').textContent, '★');
  assert.equal(container.querySelector('.annotation-ref').getAttribute('aria-label'), 'Read great sentence annotation 1');
  assert.equal(container.querySelectorAll('.annotation-caret').length, 0);
  assert.equal(renderedContent(container).text, text);
});

test('gap popovers expose suggestions safely and discuss their real anchor while restoring focus', () => {
  const text = 'Our first point. Another point.';
  const gap = insertion(text, text.indexOf(' Another'), 1);
  gap.comment = '<script>Explain the relationship.</script>';
  gap.suggestion = '<img src=x> With that context, consider the next point.';
  const { document, window: domWindow, container } = render(text, [gap]);
  const get = id => document.getElementById(id), bubble = get('bubble'), ref = container.querySelector('.annotation-ref');
  let activeElement = document.body;
  Object.defineProperty(document, 'activeElement', { get: () => activeElement });
  for (const element of [bubble, ref]) element.focus = () => { activeElement = element; };
  ref.getBoundingClientRect = () => ({ left: 20, top: 40, right: 40, bottom: 60, width: 20, height: 20 });
  bubble.getBoundingClientRect = () => ({ width: 340, height: 180 });
  const window = { innerWidth: 800, innerHeight: 600, addEventListener() {}, removeEventListener() {} }, discussed = [];
  const controller = createAnnotationPopover({ document, window, container, bubble, title: get('title'), explanation: get('explanation'),
    suggestion: get('suggestion'), suggestionSection: get('revision'), closeButton: get('close'), discussButton: get('discuss'),
    onDiscuss: quote => discussed.push(quote), categoryLabel: () => 'Transition' });
  controller.setAnnotations([gap]);
  assert.equal(controller.open(1, ref), true);
  assert.equal(get('title').textContent, 'Transition · Note 1');
  assert.equal(get('explanation').textContent, gap.comment);
  assert.equal(get('suggestion').textContent, gap.suggestion);
  assert.equal(get('revision').hidden, false);
  assert.equal(bubble.querySelector('script, img'), null);
  assert.equal(ref.getAttribute('aria-expanded'), 'true');
  assert.equal(document.activeElement, bubble);
  const escape = new domWindow.Event('keydown', { bubbles: true, cancelable: true });
  escape.key = 'Escape'; bubble.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true); assert.equal(bubble.hidden, true); assert.equal(document.activeElement, ref);
  assert.equal(ref.getAttribute('aria-expanded'), 'false');
  controller.open(1, ref); get('discuss').click();
  assert.deepEqual(discussed, [gap.anchorQuote]);
  assert.equal(document.activeElement, ref);
  controller.dispose();
});
