/** Keep exact transcript characters while making each sentence selectable. */
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
    const piece = { ...segment, start: offset, end: offset + segment.text.length };
    offset = piece.end; return piece;
  });
  const nodes = [];
  for (const range of sentenceRanges(source)) {
    const sentence = document.createElement('span');
    sentence.className = 'transcript-sentence';
    sentence.dataset.quote = source.slice(range.start, range.end).trim().slice(0, 4000);
    if (sentence.dataset.quote) {
      sentence.tabIndex = 0; sentence.setAttribute('role', 'button');
      sentence.setAttribute('aria-label', `Discuss: ${sentence.dataset.quote.slice(0, 180)}`);
    }
    while (segmentIndex < pieces.length && pieces[segmentIndex].end <= range.start) segmentIndex++;
    for (let index = segmentIndex; index < pieces.length && pieces[index].start < range.end; index++) {
      const piece = pieces[index];
      const start = Math.max(piece.start, range.start), end = Math.min(piece.end, range.end);
      if (start >= end) continue;
      if (!piece.annotation) { sentence.append(document.createTextNode(source.slice(start, end))); continue; }
      const mark = document.createElement('mark'), item = piece.annotation;
      mark.className = `annotation-${item.category}`; mark.textContent = source.slice(start, end);
      mark.setAttribute('aria-describedby', `annotation-note-${item.number}`);
      if (start === piece.start) mark.id = `annotation-quote-${item.number}`;
      sentence.append(mark);
      if (end === piece.end) {
        const reference = document.createElement('a');
        reference.className = 'annotation-ref'; reference.textContent = `[${item.number}]`;
        reference.href = `#annotation-note-${item.number}`;
        reference.setAttribute('aria-label', `Read annotation ${item.number}`);
        sentence.append(reference);
      }
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
  fragment.querySelectorAll('.annotation-ref').forEach(node => node.remove());
  return (fragment.textContent || '').trim().slice(0, 4000);
}
