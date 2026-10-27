import test from 'node:test';
import assert from 'node:assert/strict';
import * as zip from 'fflate';
import { extractRubric } from '../public/rubric-documents.js';
import { RUBRIC_LIMITS, validateRubricFile, validateRubricText, decodeDocumentBytes, extractDocxParts, wordDocumentToText, docxPartsToText, createPdfTextCollector, extractPdfText as parsePdfText } from '../lib/rubric-document.mjs';

const utf8 = value => new TextEncoder().encode(value);
const file = (name, content, type = '') => new File([content], name, { type });
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const element = (localName, children = [], textContent = '', namespaceURI = W) => ({ localName, children, textContent, namespaceURI });
const t = text => element('t', [], text);
const p = (...runs) => element('p', runs.map(run => typeof run === 'string' ? element('r', [t(run)]) : run));
const wordDocument = (...children) => ({ documentElement: element('document', [element('body', children)]), getElementsByTagName: () => [] });
const xml = text => `<?xml version="1.0"?><w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;

function pdfMock(pages, overrides = {}) {
  const seen = { destroyed: 0, cleaned: 0, cancelled: 0, terminated: 0, workerDestroyed: 0, requested: [], options: null };
  const document = {
    numPages: pages.length,
    async getPage(index) {
      seen.requested.push(index);
      const chunks = pages[index - 1];
      let cursor = 0;
      return {
        cleanup() { seen.cleaned++; },
        streamTextContent() { return { getReader() { return {
          read: async () => cursor < chunks.length ? { done: false, value: { items: chunks[cursor++] } } : { done: true },
          cancel() { seen.cancelled++; return Promise.resolve(); },
        }; } }; },
      };
    },
    ...overrides.document,
  };
  const pdfjs = {
    WorkerImpl: class {
      constructor(url, options) { seen.workerUrl = url; seen.workerOptions = options; seen.worker = this; this.listeners = new Map(); }
      addEventListener(type, handler) { this.listeners.set(type, handler); }
      removeEventListener(type, handler) { if (this.listeners.get(type) === handler) this.listeners.delete(type); }
      terminate() { seen.terminated++; }
    },
    PDFWorker: class {
      constructor({ port }) { this.port = port; }
      destroy() { seen.workerDestroyed++; }
    },
    getDocument(options) {
    seen.options = options;
    return { promise: overrides.promise || Promise.resolve(document), destroy() { seen.destroyed++; return overrides.destroy?.() || Promise.resolve(); } };
  } };
  return { pdfjs, seen };
}
const extractPdfText = (bytes, pdfjs, options) => parsePdfText(bytes, pdfjs, { workerUrl: 'mock-pdf-worker.mjs', WorkerImpl: pdfjs.WorkerImpl, ...options });

test('rubric files validate type and size before reading; browser MIME may be empty', () => {
  assert.deepEqual(validateRubricFile(file('Rubric.PDF', 'data')), { name: 'Rubric.PDF', extension: 'pdf' });
  assert.throws(() => validateRubricFile(file('rubric.doc', 'data')), { code: 'RUBRIC_FORMAT' });
  assert.throws(() => validateRubricFile(file('rubric.txt', '')), { code: 'RUBRIC_EMPTY' });
  assert.throws(() => validateRubricFile(file(`${'x'.repeat(252)}.txt`, 'rubric')), { code: 'RUBRIC_NAME_LIMIT' });
  assert.throws(() => validateRubricFile({ name: 'large.pdf', size: RUBRIC_LIMITS.fileBytes + 1, arrayBuffer() { throw Error('Must not read'); } }), { code: 'RUBRIC_FILE_LIMIT' });
});

test('TXT import preserves full Unicode and accepts exactly 40,000 characters', async () => {
  const text = 'Rubric — clarity, evidence, and café examples.\r\n10 points. 😀';
  assert.deepEqual(await extractRubric(file('rubric.txt', text)), { text, name: 'rubric.txt' });
  assert.equal(validateRubricText('x'.repeat(40_000)).length, 40_000);
  await assert.rejects(extractRubric(file('rubric.txt', 'x'.repeat(40_001))), { code: 'RUBRIC_TEXT_LIMIT' });
});

test('TXT imports decode UTF-8 and both UTF-16 BOMs without replacement characters', () => {
  assert.equal(decodeDocumentBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('Café')])), 'Café');
  assert.equal(decodeDocumentBytes(new Uint8Array([0xff, 0xfe, 0x41, 0, 0xe9, 0])), 'Aé');
  assert.equal(decodeDocumentBytes(new Uint8Array([0xfe, 0xff, 0, 0x41, 0, 0xe9])), 'Aé');
  assert.throws(() => decodeDocumentBytes(new Uint8Array([0xc3, 0x28])), { code: 'RUBRIC_ENCODING' });
  assert.throws(() => validateRubricText('Rubric\0binary'), { code: 'RUBRIC_ENCODING' });
  assert.throws(() => validateRubricText(' \n\t '), { code: 'RUBRIC_NO_TEXT' });
});

test('read errors and misleading file size cannot bypass public import checks', async () => {
  await assert.rejects(extractRubric({ name: 'rubric.txt', size: 20, async arrayBuffer() { throw Error('disk detail'); } }), { code: 'RUBRIC_READ' });
  await assert.rejects(extractRubric({ name: 'rubric.txt', size: 1, async arrayBuffer() { return new ArrayBuffer(RUBRIC_LIMITS.fileBytes + 1); } }), { code: 'RUBRIC_FILE_LIMIT' });
});

test('DOCX extracts text-bearing parts and skips a large compressed image', () => {
  const documentXml = xml('Thesis and evidence');
  const archive = zip.zipSync({
    'word/media/image.png': new Uint8Array(3 * 1024 * 1024),
    'word/document.xml': utf8(documentXml),
    'word/header1.xml': utf8(`<w:hdr xmlns:w="${W}"/>`),
    'word/footnotes.xml': utf8(`<w:footnotes xmlns:w="${W}"/>`),
    'word/comments.xml': utf8('Comments are not rubric criteria'),
    '../word/document.xml': utf8('Traversal is not a document part'),
    'word/../../evil.js': utf8('alert(1)'),
    'word/_rels/document.xml.rels': utf8('<Relationship Target="https://attacker.invalid/secret"/>'),
  });
  const parts = extractDocxParts(archive, zip);
  assert.equal(parts[0].name, 'word/document.xml');
  assert.equal(parts[0].xml, documentXml);
  assert.deepEqual(parts.slice(1).map(part => part.name), ['word/footnotes.xml', 'word/header1.xml']);
});

test('DOCX rejects missing document, corrupt headers, unsupported compression, and oversized XML', () => {
  assert.throws(() => extractDocxParts(utf8('not a zip'), zip), { code: 'RUBRIC_CORRUPT' });
  assert.throws(() => extractDocxParts(zip.zipSync({ 'other.xml': utf8('not a document') }), zip), { code: 'RUBRIC_CORRUPT' });
  const oversized = zip.zipSync({ 'word/document.xml': utf8('x'.repeat(RUBRIC_LIMITS.xmlBytes + 1)) });
  assert.throws(() => extractDocxParts(oversized, zip), { code: 'RUBRIC_XML_LIMIT' });
  const wrongCompression = zip.zipSync({ 'word/document.xml': utf8(xml('Criterion')) });
  new DataView(wrongCompression.buffer).setUint16(8, 99, true);
  assert.throws(() => extractDocxParts(wrongCompression, zip), { code: 'RUBRIC_CORRUPT' });
});

test('DOCX enforces actual inflation size when ZIP metadata understates output', () => {
  const archive = zip.zipSync({ 'word/document.xml': utf8('x'.repeat(RUBRIC_LIMITS.xmlBytes + 1)) });
  new DataView(archive.buffer).setUint32(22, 10, true);
  assert.throws(() => extractDocxParts(archive, zip), { code: 'RUBRIC_XML_LIMIT' });
  const mismatch = zip.zipSync({ 'word/document.xml': utf8(xml('Criterion')) });
  new DataView(mismatch.buffer).setUint32(22, 10, true);
  assert.throws(() => extractDocxParts(mismatch, zip), { code: 'RUBRIC_CORRUPT' });
});

test('DOCX applies the XML budget across body and supplementary parts', () => {
  const archive = zip.zipSync({
    'word/document.xml': utf8('x'.repeat(1_100_000)),
    'word/header1.xml': utf8('x'.repeat(1_100_000)),
  });
  assert.throws(() => extractDocxParts(archive, zip), { code: 'RUBRIC_XML_LIMIT' });
});

test('DOCX rejects duplicate document entries and excessive entry counts', () => {
  const duplicate = zip.zipSync({ 'word/document.xml': utf8(xml('One')), 'word/documenz.xml': utf8(xml('Two')) });
  const oldName = utf8('word/documenz.xml');
  for (let index = 0; index <= duplicate.length - oldName.length; index++) {
    if (oldName.every((byte, offset) => duplicate[index + offset] === byte)) duplicate[index + 'word/documen'.length] = 't'.charCodeAt(0);
  }
  assert.throws(() => extractDocxParts(duplicate, zip), { code: 'RUBRIC_CORRUPT' });
  const files = Object.fromEntries(Array.from({ length: RUBRIC_LIMITS.zipEntries }, (_, index) => [`ignored/${index}.txt`, utf8('x')]));
  files['word/document.xml'] = utf8(xml('Criterion'));
  assert.throws(() => extractDocxParts(zip.zipSync(files), zip), { code: 'RUBRIC_ZIP_LIMIT' });
});

test('Word text preserves split words, Unicode, paragraph boundaries, tabs, and tables', () => {
  const row = (...cells) => element('tr', cells.map(cell => element('tc', [p(cell)])));
  const doc = wordDocument(
    p('Pre', 'sentation café 😀'),
    element('tbl', [row('Criterion', 'Points'), row('Evidence', '10')]),
    p(element('r', [t('Timing'), element('tab'), t('5 minutes'), element('br'), t('Thank you.')]))
  );
  assert.equal(wordDocumentToText(doc), 'Presentation café 😀\nCriterion\tPoints\nEvidence\t10\n\nTiming\t5 minutes\nThank you.');
});

test('Word text excludes deleted text, field instructions and duplicate alternate content', () => {
  const alternate = element('AlternateContent', [element('Choice', [p('Chosen text')]), element('Fallback', [p('Duplicate text')])], '', 'http://schemas.openxmlformats.org/markup-compatibility/2006');
  const doc = wordDocument(p('Current ', element('del', [t('deleted')]), element('instrText', [], 'FIELD CODE'), 'criteria.'), alternate);
  assert.equal(wordDocumentToText(doc), 'Current criteria.\nChosen text');
});

test('Word text validates XML namespace and bounds deeply nested input', () => {
  assert.throws(() => wordDocumentToText({ documentElement: element('document', [], '', 'unrelated') }), { code: 'RUBRIC_CORRUPT' });
  let deep = t('text');
  for (let index = 0; index < 150; index++) deep = element('sdt', [deep]);
  assert.throws(() => wordDocumentToText(wordDocument(deep)), { code: 'RUBRIC_XML_LIMIT' });
});

test('DOCX rejects entity declarations before parsing and reports XML parse errors', () => {
  class NeverParse { constructor() { throw Error('Unsafe XML reached parser'); } }
  assert.throws(() => docxPartsToText([{ name: 'word/document.xml', xml: '<!DOCTYPE x [<!ENTITY x "boom">]><x/>' }], NeverParse), { code: 'RUBRIC_CORRUPT' });
  class BrokenParser { parseFromString() { return { getElementsByTagName: () => [{}] }; } }
  assert.throws(() => docxPartsToText([{ name: 'word/document.xml', xml: '<bad>' }], BrokenParser), { code: 'RUBRIC_CORRUPT' });
});

test('DOCX combines supplemental text with labels and validates the full combined character count', () => {
  class Parser { parseFromString(value, type) { assert.equal(type, 'application/xml'); return wordDocument(p(value)); } }
  assert.equal(docxPartsToText([{ name: 'word/document.xml', xml: 'Body criteria' }, { name: 'word/footer1.xml', xml: 'Additional criteria' }], Parser), 'Body criteria\n\nfooter1:\nAdditional criteria');
  assert.throws(() => docxPartsToText([{ name: 'word/document.xml', xml: 'x'.repeat(39_999) }, { name: 'word/footer1.xml', xml: 'Other criteria' }], Parser), { code: 'RUBRIC_TEXT_LIMIT' });
});

test('PDF collector keeps split words together and preserves line/table separation', () => {
  const collector = createPdfTextCollector();
  const item = (str, x, y, width, hasEOL = false) => ({ str, width, height: 10, transform: [10, 0, 0, 10, x, y], hasEOL });
  collector.add([item('Pre', 0, 100, 15), item('sentation', 15, 100, 40), item('10 points', 100, 100, 40, true)]);
  collector.add([item('Evidence', 0, 80, 40)]);
  assert.equal(collector.value(), 'Presentation\t10 points\nEvidence');
});

test('PDF streams all pages locally and cleans up readers, pages and the worker', async () => {
  const { pdfjs, seen } = pdfMock([[[{ str: 'Thesis: 10 points', hasEOL: true }]], [[{ str: 'Evidence: 20 points', hasEOL: true }]]]);
  const bytes = utf8('%PDF-test');
  assert.equal(await extractPdfText(bytes, pdfjs), 'Thesis: 10 points\nEvidence: 20 points');
  assert.equal(seen.options.data, bytes);
  assert.equal(seen.options.url, undefined);
  assert.equal(seen.options.useWorkerFetch, false);
  assert.equal(seen.options.isEvalSupported, false);
  assert.equal(seen.options.worker.port, seen.worker);
  assert.deepEqual(seen.workerOptions, { type: 'module' });
  assert.deepEqual(seen.requested, [1, 2]);
  assert.equal(seen.destroyed, 1);
  assert.equal(seen.cleaned, 2);
  assert.equal(seen.cancelled, 2);
  assert.equal(seen.terminated, 1);
  assert.equal(seen.workerDestroyed, 1);
  assert.equal(seen.worker.listeners.size, 0);
});

test('document cancellation rejects before reading or after a pending file read without starting parsers', async () => {
  let reads = 0, finishRead;
  const input = { name: 'canceled.docx', size: 10, arrayBuffer() { reads++; return new Promise(resolve => { finishRead = resolve; }); } };
  await assert.rejects(extractRubric(input, { signal: AbortSignal.abort() }), { name: 'AbortError' }); assert.equal(reads, 0);
  const controller = new AbortController(), reading = extractRubric(input, { signal: controller.signal });
  controller.abort(); finishRead(utf8('invalid document').buffer);
  await assert.rejects(reading, { name: 'AbortError' }); assert.equal(reads, 1);
});

test('PDF cancellation kills workers during load, page access, and text reads and removes listeners', async () => {
  for (const phase of ['load', 'page', 'read']) {
    const pending = new Promise(() => {}), controller = new AbortController();
    let readCanceled = 0;
    const overrides = phase === 'load' ? { promise: pending } : { document: {
      numPages: 1,
      getPage: phase === 'page' ? () => pending : async () => ({ cleanup() {}, streamTextContent() { return { getReader() { return { read: () => pending, cancel() { readCanceled++; return Promise.resolve(); } }; } }; } }),
    } };
    const { pdfjs, seen } = pdfMock([], overrides);
    let added = 0, removed = 0;
    const signal = { get aborted() { return controller.signal.aborted; }, addEventListener(...args) { added++; controller.signal.addEventListener(...args); }, removeEventListener(...args) { removed++; controller.signal.removeEventListener(...args); } };
    const reading = extractPdfText(utf8('%PDF-test'), pdfjs, { signal });
    await new Promise(resolve => setImmediate(resolve)); controller.abort();
    await assert.rejects(reading, { name: 'AbortError' });
    assert.equal(seen.terminated, 1, phase); assert.equal(seen.destroyed, 1, phase); assert.equal(seen.workerDestroyed, 1, phase);
    assert.equal(seen.worker.listeners.size, 0, phase); assert.equal(added, 1); assert.equal(removed, 1);
    assert.equal(readCanceled, phase === 'read' ? 1 : 0);
  }
});

test('250 rapid canceled PDF reads leave no live workers or event listeners', async () => {
  let active = 0, peak = 0, created = 0, terminated = 0; const reads = [], workers = [];
  let previous;
  for (let index = 0; index < 250; index++) {
    previous?.abort(); const controller = new AbortController(); previous = controller;
    const { pdfjs } = pdfMock([], { promise: new Promise(() => {}) });
    const Worker = pdfjs.WorkerImpl;
    pdfjs.WorkerImpl = class extends Worker {
      constructor(...args) { super(...args); workers.push(this); created++; peak = Math.max(peak, ++active); }
      terminate() { super.terminate(); active--; terminated++; }
    };
    reads.push(extractPdfText(utf8('%PDF-test'), pdfjs, { signal: controller.signal }).then(() => assert.fail('Canceled input resolved'), error => assert.equal(error.name, 'AbortError')));
  }
  previous.abort(); await Promise.all(reads);
  assert.equal(created, 250); assert.equal(terminated, 250); assert.equal(peak, 1); assert.equal(active, 0);
  assert.ok(workers.every(worker => worker.listeners.size === 0));
});

test('PDF page limit rejects before extracting any partial document', async () => {
  const { pdfjs, seen } = pdfMock(Array.from({ length: 31 }, () => []));
  await assert.rejects(extractPdfText(utf8('%PDF-test'), pdfjs), { code: 'RUBRIC_PAGE_LIMIT' });
  assert.deepEqual(seen.requested, []);
  assert.equal(seen.destroyed, 1);
});

test('PDF character limit aborts the reader and refuses partial results', async () => {
  const { pdfjs, seen } = pdfMock([[[{ str: 'x'.repeat(39_999) }], [{ str: 'additional criteria' }]]]);
  await assert.rejects(extractPdfText(utf8('%PDF-test'), pdfjs), { code: 'RUBRIC_TEXT_LIMIT' });
  assert.equal(seen.destroyed, 1);
  assert.equal(seen.cancelled, 1);
});

test('PDF accepts exactly 40,000 characters plus its final structural newline', async () => {
  const { pdfjs } = pdfMock([[[{ str: 'x'.repeat(40_000), hasEOL: true }]]]);
  assert.equal((await extractPdfText(utf8('%PDF-test'), pdfjs)).length, 40_000);
});

test('PDF refuses a mixed text/scanned or blank document instead of omitting a page', async () => {
  const { pdfjs, seen } = pdfMock([[[{ str: 'Readable first-page criteria' }]], []]);
  await assert.rejects(extractPdfText(utf8('%PDF-test'), pdfjs), problem => problem.code === 'RUBRIC_NO_TEXT' && problem.message.includes('Page 2') && problem.message.includes('nothing has been imported'));
  assert.equal(seen.destroyed, 1);
  assert.equal(seen.cleaned, 2);
});

test('PDF scans, passwords and corrupt documents have distinct actionable errors', async () => {
  const scan = pdfMock([[]]);
  await assert.rejects(extractPdfText(utf8('%PDF-test'), scan.pdfjs), problem => problem.code === 'RUBRIC_NO_TEXT' && /OCR/.test(problem.message));
  const password = pdfMock([], { promise: Promise.reject(Object.assign(new Error('private details'), { name: 'PasswordException' })) });
  await assert.rejects(extractPdfText(utf8('%PDF-test'), password.pdfjs), problem => problem.code === 'RUBRIC_PASSWORD' && !problem.message.includes('private details'));
  const broken = pdfMock([], { promise: Promise.reject(new Error('provider internals')) });
  await assert.rejects(extractPdfText(utf8('%PDF-test'), broken.pdfjs), { code: 'RUBRIC_CORRUPT' });
  assert.equal(scan.seen.destroyed + password.seen.destroyed + broken.seen.destroyed, 3);
});

test('PDF timeout destroys the worker and does not wait on hanging cleanup', async () => {
  const { pdfjs, seen } = pdfMock([], { promise: new Promise(() => {}), destroy: () => new Promise(() => {}) });
  await assert.rejects(extractPdfText(utf8('%PDF-test'), pdfjs, { timeoutMs: 5 }), { code: 'RUBRIC_TIMEOUT' });
  assert.equal(seen.destroyed, 1);
  assert.equal(seen.terminated, 1, 'native worker termination must not wait for PDF.js transport cleanup');
  assert.equal(seen.workerDestroyed, 1);
});

test('PDF worker failures abort immediately without falling back to main-thread parsing', async () => {
  for (const event of ['error', 'messageerror']) {
    const { pdfjs, seen } = pdfMock([], { promise: new Promise(() => {}), destroy: () => new Promise(() => {}) });
    const reading = extractPdfText(utf8('%PDF-test'), pdfjs);
    seen.worker.listeners.get(event)();
    await assert.rejects(reading, { code: 'RUBRIC_READER' });
    assert.equal(seen.terminated, 1);
    assert.equal(seen.destroyed, 1);
  }
});

test('PDF import requires an explicit native worker and cleans it up if PDF.js initialization fails', async () => {
  const { pdfjs, seen } = pdfMock([]);
  await assert.rejects(extractPdfText(utf8('%PDF-test'), pdfjs, { WorkerImpl: null }), { code: 'RUBRIC_BROWSER' });
  await assert.rejects(extractPdfText(utf8('%PDF-test'), pdfjs, { workerUrl: undefined }), { code: 'RUBRIC_BROWSER' });
  await assert.rejects(extractPdfText(utf8('%PDF-test'), pdfjs, { WorkerImpl: class { constructor() { throw new Error('CSP blocked'); } } }), { code: 'RUBRIC_BROWSER' });
  assert.equal(seen.options, null, 'unsupported workers must not start PDF.js parsing');
  pdfjs.PDFWorker = class { constructor() { throw new Error('Initialization failed'); } };
  await assert.rejects(extractPdfText(utf8('%PDF-test'), pdfjs), { code: 'RUBRIC_CORRUPT' });
  assert.equal(seen.terminated, 1);
});
