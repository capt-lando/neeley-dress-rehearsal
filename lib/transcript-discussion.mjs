/** Existing saved impact notes share the great-sentence treatment. */
export function annotationCategory(item) {
  return item.category === 'impact' ? 'great' : item.category;
}

export function annotationAssessment(item) {
  if (annotationCategory(item) === 'great') return 'strength';
  if (['strength', 'needs_work', 'observation'].includes(item.assessment)) return item.assessment;
  return typeof item.suggestion === 'string' && item.suggestion.trim() ? 'needs_work' : 'observation';
}

export function sentenceRanges(text) {
  const source = String(text || '');
  if (typeof Intl.Segmenter === 'function') {
    return [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(source)]
      .map(({ index, segment }) => ({ start: index, end: index + segment.length }));
  }
  return [...source.matchAll(/[^.!?\n]*(?:[.!?]+[ \t]*|\n|$)/g)]
    .filter(match => match[0]).map(match => ({ start: match.index, end: match.index + match[0].length }));
}

export function renderDiscussableTranscript({ document, container, text, segments }) {
  const source = String(text || '');
  let offset = 0, segmentIndex = 0;
  const pieces = segments.map(segment => {
    const piece = { ...segment, annotation: segment.annotation ? { ...segment.annotation, category: annotationCategory(segment.annotation) } : null, start: offset, end: offset + segment.text.length };
    offset = piece.end; return piece;
  });
  const annotationEnds = new Map(), marked = new Set(), inserted = new Set();
  for (const piece of pieces) {
    if (piece.annotation && piece.end > piece.start) annotationEnds.set(piece.annotation.number, piece.end);
  }
  function referenceFor(item) {
    const reference = document.createElement('a');
    reference.className = item.category === 'transition' ? 'annotation-ref annotation-transition-ref' : 'annotation-ref';
    reference.dataset.annotationNumber = String(item.number);
    reference.setAttribute('aria-haspopup', 'dialog'); reference.setAttribute('aria-expanded', 'false');
    reference.setAttribute('aria-controls', 'annotation-bubble');
    reference.setAttribute('aria-describedby', `annotation-note-${item.number}`);
    if (item.category === 'transition') {
      const caret = document.createElement('span');
      caret.className = 'annotation-caret'; caret.setAttribute('aria-hidden', 'true');
      reference.append(caret);
    } else if (item.category === 'great') {
      const star = document.createElement('span');
      star.className = 'annotation-star'; star.textContent = '★'; star.setAttribute('aria-hidden', 'true');
      reference.append(star);
    }
    reference.append(document.createTextNode(`[${item.number}]`));
    reference.href = `#annotation-note-${item.number}`;
    reference.setAttribute('aria-label', item.category === 'transition' ? `Suggested transition note ${item.number}`
      : item.category === 'great' ? `Read great sentence annotation ${item.number}` : `Read annotation ${item.number}`);
    return reference;
  }
  function annotationOwnsFocus(sentence) {
    // Annotation controls have their own keyboard actions; avoid nested button roles.
    sentence.tabIndex = -1; sentence.removeAttribute('role'); sentence.removeAttribute('aria-label');
  }
  const nodes = [];
  const ranges = sentenceRanges(source);
  if (!ranges.length && pieces.some(piece => piece.annotation?.kind === 'insertion')) ranges.push({ start: 0, end: 0 });
  for (const [rangeIndex, range] of ranges.entries()) {
    const finalRange = rangeIndex === ranges.length - 1;
    const sentence = document.createElement('span');
    sentence.className = 'transcript-sentence';
    sentence.dataset.quote = source.slice(range.start, range.end).trim().slice(0, 4000);
    if (sentence.dataset.quote) {
      sentence.tabIndex = 0; sentence.setAttribute('role', 'button');
      sentence.setAttribute('aria-label', `Discuss: ${sentence.dataset.quote.slice(0, 180)}`);
    }
    while (segmentIndex < pieces.length && (pieces[segmentIndex].end < range.start ||
      pieces[segmentIndex].end === range.start && pieces[segmentIndex].start < pieces[segmentIndex].end)) segmentIndex++;
    for (let index = segmentIndex; index < pieces.length && (pieces[index].start < range.end || finalRange && pieces[index].start === range.end); index++) {
      const piece = pieces[index];
      if (piece.start === piece.end && piece.annotation?.category === 'transition' && piece.annotation.kind === 'insertion') {
        if (piece.start >= range.start && !inserted.has(piece.annotation.number)) {
          const reference = referenceFor(piece.annotation);
          reference.id = `annotation-quote-${piece.annotation.number}`;
          sentence.append(reference); annotationOwnsFocus(sentence);
          inserted.add(piece.annotation.number);
        }
        continue;
      }
      const start = Math.max(piece.start, range.start), end = Math.min(piece.end, range.end);
      if (start >= end) continue;
      if (!piece.annotation) { sentence.append(document.createTextNode(source.slice(start, end))); continue; }
      const mark = document.createElement('mark'), item = piece.annotation;
      mark.className = `annotation-${item.category}`; mark.textContent = source.slice(start, end);
      mark.dataset.assessment = annotationAssessment(item);
      mark.dataset.annotationNumber = String(item.number);
      mark.tabIndex = 0; mark.setAttribute('role', 'button');
      mark.setAttribute('aria-label', `Read ${item.category === 'great' ? 'great sentence ' : ''}annotation ${item.number}: ${source.slice(start, end)}`);
      mark.setAttribute('aria-haspopup', 'dialog'); mark.setAttribute('aria-expanded', 'false');
      mark.setAttribute('aria-controls', 'annotation-bubble');
      mark.setAttribute('aria-describedby', `annotation-note-${item.number}`);
      annotationOwnsFocus(sentence);
      if (!marked.has(item.number)) { mark.id = `annotation-quote-${item.number}`; marked.add(item.number); }
      sentence.append(mark);
      if (end === annotationEnds.get(item.number)) sentence.append(referenceFor(item));
    }
    nodes.push(sentence);
  }
  container.replaceChildren(...nodes);
}

/** Only selections wholly inside the transcript are attached; citation links are UI. */
export function selectedTranscriptQuote(container, selection) {
  if (!selection || selection.isCollapsed || !selection.rangeCount ||
      !container.contains(selection.anchorNode) || !container.contains(selection.focusNode)) return '';
  const fragment = selection.getRangeAt(0).cloneContents();
  fragment.querySelectorAll('.annotation-ref, .annotation-bubble').forEach(node => node.remove());
  return (fragment.textContent || '').trim().slice(0, 4000);
}

/** One non-modal coaching bubble, kept outside the scrollable transcript. */
export function createAnnotationPopover({ document, window, container, bubble, title, explanation, suggestion, suggestionSection, closeButton, discussButton, onDiscuss, categoryLabel }) {
  let annotations = new Map(), active = null;
  const controlsFor = number => [...container.querySelectorAll('[data-annotation-number]')]
    .filter(control => control.dataset.annotationNumber === String(number));
  function close({ restoreFocus = false } = {}) {
    const previous = active;
    active = null; bubble.hidden = true;
    title.textContent = 'Coaching note'; explanation.textContent = ''; suggestion.textContent = ''; suggestionSection.hidden = true;
    for (const control of previous?.controls || []) {
      control.classList.remove('is-selected'); control.setAttribute('aria-expanded', 'false');
    }
    if (restoreFocus && previous && container.contains(previous.trigger)) previous.trigger.focus({ preventScroll: true });
  }
  function position(trigger) {
    const fragments = trigger.getClientRects?.();
    const bounds = fragments?.length ? fragments[fragments.length - 1] : trigger.getBoundingClientRect(), panel = bubble.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 1024;
    const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 768;
    const margin = 12, gap = 12, width = panel.width || Math.min(340, viewportWidth - margin * 2);
    const height = panel.height || 180;
    const center = bounds.left + (bounds.width || bounds.right - bounds.left) / 2;
    const left = Math.max(margin, Math.min(center - Math.min(width / 2, 100), viewportWidth - width - margin));
    const above = bounds.bottom + gap + height > viewportHeight - margin && bounds.top >= height + gap + margin;
    const top = Math.max(margin, Math.min(above ? bounds.top - height - gap : bounds.bottom + gap, viewportHeight - height - margin));
    bubble.style.left = `${left}px`; bubble.style.top = `${top}px`;
    bubble.style.setProperty('--annotation-tail-left', `${Math.max(20, Math.min(center - left, width - 20))}px`);
    bubble.dataset.placement = above ? 'above' : 'below';
  }
  function open(number, trigger) {
    const item = annotations.get(Number(number));
    if (!item || !container.contains(trigger)) return false;
    if (active?.trigger === trigger && active.number === item.number) { close({ restoreFocus: true }); return true; }
    close();
    title.textContent = item.category === 'great' ? categoryLabel(item.category) : `${categoryLabel(item.category)} · Note ${item.number}`;
    explanation.textContent = item.comment;
    const replacement = typeof item.suggestion === 'string' ? item.suggestion.trim() : '';
    suggestion.textContent = replacement; suggestionSection.hidden = !replacement;
    bubble.dataset.category = item.category; bubble.hidden = false;
    const anchorQuote = item.kind === 'insertion' && typeof item.anchorQuote === 'string' ? item.anchorQuote.trim().slice(0, 4000) : '';
    active = { number: item.number, trigger, controls: controlsFor(item.number), quote: anchorQuote || trigger.closest?.('.transcript-sentence')?.dataset.quote || item.quote };
    for (const control of active.controls) {
      control.classList.add('is-selected'); control.setAttribute('aria-expanded', 'true');
    }
    position(trigger);
    bubble.focus({ preventScroll: true });
    return true;
  }
  const onClose = () => close({ restoreFocus: true });
  const discuss = () => { const quote = active?.quote; close({ restoreFocus: true }); if (quote) onDiscuss(quote); };
  const onKeyDown = event => { if (active && event.key === 'Escape') { event.preventDefault(); onClose(); } };
  const onOutside = event => {
    if (active && !bubble.contains(event.target) && !active.controls.some(control => control.contains(event.target))) close();
  };
  const onScroll = event => { if (active && !bubble.contains(event.target)) close({ restoreFocus: bubble.contains(document.activeElement) }); };
  const onResize = () => { if (active) close({ restoreFocus: bubble.contains(document.activeElement) }); };
  closeButton.addEventListener('click', onClose);
  discussButton.addEventListener('click', discuss);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('pointerdown', onOutside);
  document.addEventListener('focusin', onOutside);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);
  return {
    open, close,
    setAnnotations(items) { close(); annotations = new Map(items.map(item => [item.number, { ...item, category: annotationCategory(item) }])); },
    dispose() {
      close(); annotations.clear(); closeButton.removeEventListener('click', onClose); discussButton.removeEventListener('click', discuss);
      document.removeEventListener?.('keydown', onKeyDown); document.removeEventListener?.('pointerdown', onOutside); document.removeEventListener?.('focusin', onOutside);
      window.removeEventListener?.('scroll', onScroll, true); window.removeEventListener?.('resize', onResize);
    },
  };
}
