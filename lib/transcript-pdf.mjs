import { fontRuns, loadPdfFonts } from './pdf-fonts.mjs';

// Match the on-screen annotation palette; PDF exports use static gold highlights.
export const PDF_ANNOTATIONS = Object.freeze({
  thesis: { label: 'Thesis', background: '#f0e9f7', color: '#44265c', description: 'Your central claim and main message.' },
  evidence: { label: 'Evidence', background: '#e8f4ea', color: '#295c38', description: 'Examples, support, and reasoning.' },
  structure: { label: 'Structure', background: '#e8f1fa', color: '#294f72', description: 'Organization, transitions, and flow.' },
  delivery: { label: 'Word habits', background: '#fbf2dc', color: '#745411', description: 'Wording and habits visible in the transcript.' },
  clarity: { label: 'Clarity', background: '#faeaf0', color: '#74364d', description: 'Language that helps the audience understand.' },
  great: { label: 'Great sentence', background: '#fff9ee', color: '#6e541b', description: 'Gold stars recognize especially effective wording.' },
});
const INK = '#29262d', PURPLE = '#4b2e6b', MUTED = '#796587', RED = '#c55050';
const MAX_TEXT = 60000, MAX_NOTES = 240, MAX_NOTE_TEXT = 4000, MAX_TOTAL = 512000;
const invalid = message => new Error(message || 'The transcript could not be prepared for PDF export.');

// Only strings and known formatting properties become PDF instructions. Transcript
// text, comments, and suggestions are never interpreted as HTML, links, or markup.
function literal(text, style = {}) {
  return String(text).split(/(\S{40,})/u).filter(Boolean).flatMap(part =>
    fontRuns(part).map(run => ({ ...style, ...run, ...( /^\S{40,}$/u.test(part) ? { wordBreak: 'break-all' } : {}) })));
}

function validateModel(model) {
  if (!model || typeof model.text !== 'string' || !model.text.trim()) throw invalid('There is no transcript to download.');
  if (model.text.length > MAX_TEXT) throw invalid('This transcript is too long to export. Shorten it before downloading.');
  if (!Array.isArray(model.segments) || model.segments.length > MAX_NOTES * 2 + 1) throw invalid();
  let position = 0, characters = model.text.length;
  const notes = [];
  for (const segment of model.segments) {
    if (!segment || typeof segment.text !== 'string' || model.text.slice(position, position + segment.text.length) !== segment.text) throw invalid();
    const item = segment.annotation;
    if (item) {
      if (!Object.hasOwn(PDF_ANNOTATIONS, item.category) || !['strength', 'needs_work', 'observation'].includes(item.assessment) ||
          item.number !== notes.length + 1 || item.start !== position || item.end !== position + segment.text.length || item.quote !== segment.text ||
          typeof item.comment !== 'string' || !item.comment.trim() || item.comment.length > MAX_NOTE_TEXT ||
          (item.suggestion != null && (typeof item.suggestion !== 'string' || item.suggestion.length > MAX_NOTE_TEXT))) throw invalid();
      characters += item.comment.length + (item.suggestion?.length || 0);
      notes.push(item);
    }
    position += segment.text.length;
  }
  if (position !== model.text.length || notes.length > MAX_NOTES || characters > MAX_TOTAL) throw invalid('This coaching report is too large to export as one PDF.');
  return notes;
}

export function buildTranscriptPdfDefinition(model) {
  const notes = validateModel(model);
  const transcript = model.segments.flatMap(segment => {
    const item = segment.annotation;
    if (!item) return literal(segment.text);
    const style = item.assessment === 'needs_work'
      ? { decoration: 'underline', decorationColor: RED, decorationStyle: 'solid' }
      : { background: PDF_ANNOTATIONS[item.category].background };
    return [
      ...literal(segment.text, style),
      ...literal(`${item.category === 'great' ? ' ★' : ''} [${item.number}]`, {
        fontSize: 9, sup: true, color: item.category === 'great' ? '#a7770d' : '#5f4371',
        linkToDestination: `note-${item.number}`,
      }),
    ];
  });
  const keyRows = Object.entries(PDF_ANNOTATIONS).map(([category, entry]) => [
    { text: literal(`${category === 'great' ? '★ ' : ''}${entry.label}`, { bold: true }), fillColor: entry.background, color: entry.color },
    { text: literal(entry.description), color: MUTED },
  ]);
  keyRows.push([
    { text: literal('Needs work', { decoration: 'underline', decorationColor: RED }), color: INK },
    { text: literal('Red underlines identify wording to improve. The numbered note explains why.'), color: MUTED },
  ]);
  const noteRows = notes.map(item => {
    const category = PDF_ANNOTATIONS[item.category];
    const stack = [{ text: [...literal(category.label + ': ', { bold: true }), ...literal(item.comment)] }];
    if (item.suggestion?.trim()) stack.push({ text: [
      ...literal('Suggested wording: ', { bold: true }), ...literal(item.suggestion.trim()),
    ], margin: [0, 5, 0, 0] });
    return [
      { text: String(item.number) + '.', id: `note-${item.number}`, color: '#9779a9', alignment: 'right', bold: true },
      { stack, fillColor: category.background, color: category.color },
    ];
  });
  const rowLayout = {
    hLineWidth: () => 5, hLineColor: () => '#ffffff', vLineWidth: () => 0,
    paddingLeft: index => index === 0 ? 0 : 9, paddingRight: () => 9,
    paddingTop: () => 7, paddingBottom: () => 7,
  };
  return {
    pageSize: 'LETTER', pageMargins: [44, 56, 44, 52],
    info: { title: 'Neeley Dress Rehearsal - Annotated Transcript', author: 'Neeley Dress Rehearsal', subject: 'Original transcript, annotation color key, and coaching notes' },
    defaultStyle: { font: 'Roboto', fontSize: 10.5, color: INK, lineHeight: 1.3, preserveLeadingSpaces: true, preserveTrailingSpaces: true },
    header: { text: 'NEELEY DRESS REHEARSAL', color: PURPLE, fontSize: 8, bold: true, characterSpacing: 1.2, margin: [44, 26, 44, 0] },
    footer: (page, count) => {
      if (count > 200) throw invalid('This PDF would exceed 200 pages. Shorten the transcript or coaching notes before exporting.');
      return { columns: [
        { text: 'AI coaching feedback - not an academic grade', color: MUTED, fontSize: 8 },
        { text: `${page} / ${count}`, color: MUTED, fontSize: 8, alignment: 'right', width: 50 },
      ], margin: [44, 18, 44, 0] };
    },
    content: [
      { text: notes.length ? 'Annotated transcript' : 'Transcript', fontSize: 23, bold: true, color: PURPLE, margin: [0, 0, 0, 9] },
      { text: notes.length
        ? 'Your original words, with the same highlights as your rehearsal. Numbered references link to the color key and coaching notes on the following pages.'
        : 'Your original words. No AI annotations are available for this transcript. A guide to the annotation colors follows on a separate page.',
      color: MUTED, fontSize: 9.5, margin: [0, 0, 0, 19] },
      { text: transcript, fontSize: 11.5, lineHeight: 1.5, margin: [0, 0, 0, 0] },
      { text: 'Color key & coaching notes', id: 'coaching-key', pageBreak: 'before', fontSize: 21, bold: true, color: PURPLE, margin: [0, 0, 0, 9] },
      { text: 'Match each numbered passage in the transcript to its note below. Suggested wording is a proposed revision, separate from what you said.', color: MUTED, fontSize: 9.5, margin: [0, 0, 0, 12] },
      { table: { widths: [132, '*'], body: keyRows }, layout: rowLayout, fontSize: 9.5, margin: [0, 0, 0, 16] },
      ...(notes.length ? [
        { text: `${notes.length} coaching ${notes.length === 1 ? 'note' : 'notes'}`, bold: true, fontSize: 13, color: PURPLE, margin: [0, 0, 0, 8] },
        { table: { widths: [22, '*'], body: noteRows }, layout: rowLayout, fontSize: 10.5, lineHeight: 1.3 },
      ] : [{ text: 'There are no numbered coaching notes for this version. Analyze the rehearsal to add feedback.', color: MUTED }]),
    ],
  };
}

let renderer;
async function pdfRenderer() {
  if (!renderer) renderer = (async () => {
    const { default: pdfMake } = await import('pdfmake/build/pdfmake.js');
    await loadPdfFonts(pdfMake);
    return pdfMake;
  })().catch(error => { renderer = null; throw error; });
  return renderer;
}

export async function createTranscriptPdf(model) {
  // Build a plain immutable snapshot before asynchronous font/library loading.
  const definition = buildTranscriptPdfDefinition(model);
  const pdfMake = await pdfRenderer();
  const blob = await pdfMake.createPdf(definition).getBlob();
  if (blob.size < 5 || await blob.slice(0, 5).text() !== '%PDF-') throw invalid('The PDF could not be created. Try downloading it again.');
  return blob;
}
