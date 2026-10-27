export const RUBRIC_LIMITS = Object.freeze({ fileBytes: 5 * 1024 * 1024, textCharacters: 40_000, pdfPages: 30, xmlBytes: 2 * 1024 * 1024, zipEntries: 1024, pdfTimeoutMs: 30_000 });

export class RubricDocumentError extends Error {
  constructor(code, message) { super(message); this.name = 'RubricDocumentError'; this.code = code; }
}
const error = (code, message) => new RubricDocumentError(code, message);
const fallback = 'Paste the rubric text instead.';
const corrupt = () => error('RUBRIC_CORRUPT', `This file could not be read. Try exporting it again, or paste the rubric text instead.`);

export function validateRubricFile(file) {
  if (!file || typeof file.arrayBuffer !== 'function' || !Number.isSafeInteger(file.size) || file.size <= 0) throw error('RUBRIC_EMPTY', `Choose a nonempty PDF, DOCX, or TXT file. ${fallback}`);
  if (file.size > RUBRIC_LIMITS.fileBytes) throw error('RUBRIC_FILE_LIMIT', 'Choose a rubric file of 5 MB or less, or paste its text.');
  const basename = String(file.name || '').split(/[\\/]/).at(-1);
  if (basename.length > 255) throw error('RUBRIC_NAME_LIMIT', 'Rename the rubric file to 255 characters or fewer, then choose it again.');
  const name = basename.replace(/[\u0000-\u001f\u007f]/g, '');
  const extension = name.match(/\.(pdf|docx|txt)$/i)?.[1].toLowerCase();
  if (!extension) throw error('RUBRIC_FORMAT', 'Choose a PDF, DOCX, or TXT file. Older .doc files need to be saved as .docx first.');
  return { name, extension };
}

export function validateRubricText(text) {
  if (typeof text !== 'string' || !text.trim()) throw error('RUBRIC_NO_TEXT', `No readable text was found. Image-only or scanned files need their text pasted manually; this app does not perform OCR.`);
  if (text.length > RUBRIC_LIMITS.textCharacters) throw error('RUBRIC_TEXT_LIMIT', 'The rubric exceeds 40,000 characters. Use a shorter rubric or paste the relevant criteria; nothing has been imported.');
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text)) throw error('RUBRIC_ENCODING', `This file contains unreadable or binary text. Save it as UTF-8 text or ${fallback.toLowerCase()}`);
  return text;
}

export function decodeDocumentBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw corrupt();
  let encoding = 'utf-8';
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0 && bytes[2] === 0x3f && bytes[3] === 0)) encoding = 'utf-16le';
  else if ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && bytes[1] === 0x3c && bytes[2] === 0 && bytes[3] === 0x3f)) encoding = 'utf-16be';
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw error('RUBRIC_ENCODING', `The text encoding could not be read. Save it as UTF-8 text or ${fallback.toLowerCase()}`); }
}

const partPattern = /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/;
export function extractDocxParts(bytes, { Unzip, UnzipInflate }) {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 3 || bytes[3] !== 4) throw corrupt();
  let entries = 0, actualBytes = 0, declaredBytes = 0, failure;
  const parts = new Map();
  const streams = [];
  const fail = problem => { failure ||= problem; };
  try {
    const archive = new Unzip(entry => {
      if (++entries > RUBRIC_LIMITS.zipEntries) throw error('RUBRIC_ZIP_LIMIT', `This Word file contains too many internal files. ${fallback}`);
      if (!partPattern.test(entry.name)) return;
      if (parts.has(entry.name)) throw corrupt();
      if (![0, 8].includes(entry.compression)) throw corrupt();
      if (entry.originalSize !== undefined) {
        if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0) throw corrupt();
        declaredBytes += entry.originalSize;
        if (declaredBytes > RUBRIC_LIMITS.xmlBytes) throw error('RUBRIC_XML_LIMIT', `This Word file contains too much document data. ${fallback}`);
      }
      const part = { name: entry.name, chunks: [], length: 0, complete: false };
      parts.set(entry.name, part);
      streams.push(entry);
      entry.ondata = (problem, chunk, final) => {
        if (failure) return;
        if (problem || !(chunk instanceof Uint8Array)) { fail(corrupt()); return; }
        actualBytes += chunk.length;
        part.length += chunk.length;
        if (actualBytes > RUBRIC_LIMITS.xmlBytes) { fail(error('RUBRIC_XML_LIMIT', `This Word file expands to too much document data. ${fallback}`)); return; }
        part.chunks.push(chunk);
        if (final) {
          part.complete = true;
          if (entry.originalSize !== undefined && part.length !== entry.originalSize) fail(corrupt());
        }
      };
      entry.start();
    });
    archive.register(UnzipInflate);
    // Inflate emits output after each push, so keep input chunks small as well as
    // checking the actual output. A whole-archive push would defeat that bound.
    for (let offset = 0; offset < bytes.length; offset += 1024) {
      archive.push(bytes.subarray(offset, offset + 1024), offset + 1024 >= bytes.length);
      if (failure) throw failure;
    }
    if (!parts.has('word/document.xml') || [...parts.values()].some(part => !part.complete)) throw corrupt();
    return [...parts.values()].sort((a, b) => a.name === 'word/document.xml' ? -1 : b.name === 'word/document.xml' ? 1 : a.name.localeCompare(b.name)).map(part => {
      const data = new Uint8Array(part.length);
      let offset = 0;
      for (const chunk of part.chunks) { data.set(chunk, offset); offset += chunk.length; }
      return { name: part.name, xml: decodeDocumentBytes(data) };
    });
  } catch (problem) { throw problem instanceof RubricDocumentError ? problem : corrupt(); }
  finally { for (const stream of streams) { try { stream.terminate(); } catch {} } }
}

const wordNamespaces = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main']);
const markupNamespace = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
export function wordDocumentToText(document) {
  const root = document?.documentElement;
  if (!root || !wordNamespaces.has(root.namespaceURI) || !['document', 'hdr', 'ftr', 'footnotes', 'endnotes'].includes(root.localName)) throw corrupt();
  const parts = [];
  const stack = [{ node: root, exit: false, depth: 0 }];
  let visited = 0;
  const trimSeparator = separator => { while (parts.at(-1) === separator) parts.pop(); };
  while (stack.length) {
    const { node, exit, depth } = stack.pop();
    if (depth > 128 || (!exit && ++visited > 100_000)) throw error('RUBRIC_XML_LIMIT', `This Word document is too complex to import. ${fallback}`);
    const word = wordNamespaces.has(node.namespaceURI);
    const tag = node.localName;
    if (exit) {
      if (word && tag === 'p') parts.push('\n');
      if (word && tag === 'tc') { trimSeparator('\n'); parts.push('\t'); }
      if (word && tag === 'tr') { trimSeparator('\t'); parts.push('\n'); }
      if (word && tag === 'tbl') parts.push('\n');
      continue;
    }
    if (word && ['del', 'moveFrom', 'instrText', 'delText'].includes(tag)) continue;
    if (word && tag === 't') { parts.push(node.textContent || ''); continue; }
    if (word && tag === 'tab') { parts.push('\t'); continue; }
    if (word && ['br', 'cr'].includes(tag)) { parts.push('\n'); continue; }
    let children = Array.from(node.children || []);
    if (node.namespaceURI === markupNamespace && tag === 'AlternateContent') {
      const alternative = children.find(child => child.localName === 'Choice') || children.find(child => child.localName === 'Fallback');
      children = alternative ? [alternative] : [];
    }
    stack.push({ node, exit: true, depth });
    for (let index = children.length - 1; index >= 0; index--) stack.push({ node: children[index], exit: false, depth: depth + 1 });
  }
  return parts.join('').trim();
}

export function docxPartsToText(parts, DOMParserImpl = globalThis.DOMParser) {
  if (typeof DOMParserImpl !== 'function') throw error('RUBRIC_BROWSER', 'Word import needs a current Chrome or Edge browser. Paste the rubric text instead.');
  const sections = [];
  for (const part of parts) {
    if (/<\s*!(?:DOCTYPE|ENTITY)\b/i.test(part.xml)) throw corrupt();
    let document;
    try { document = new DOMParserImpl().parseFromString(part.xml, 'application/xml'); } catch { throw corrupt(); }
    if (document.getElementsByTagName('parsererror').length) throw corrupt();
    const text = wordDocumentToText(document);
    if (text) sections.push(part.name === 'word/document.xml' ? text : `${part.name.replace(/^word\//, '').replace(/\.xml$/, '')}:\n${text}`);
  }
  return validateRubricText(sections.join('\n\n'));
}

export function createPdfTextCollector() {
  let text = '', previous;
  return {
    add(items) {
      for (const item of items || []) {
        if (typeof item.str !== 'string') continue;
        if (text.length + item.str.length > RUBRIC_LIMITS.textCharacters + 1024) throw error('RUBRIC_TEXT_LIMIT', 'The rubric exceeds 40,000 characters. Use a shorter rubric or paste the relevant criteria; nothing has been imported.');
        if (previous && item.str && text && !/\s$/.test(text) && !/^\s/.test(item.str)) {
          const before = previous.transform, current = item.transform;
          let separator = ' ';
          if (Array.isArray(before) && Array.isArray(current) && Number.isFinite(previous.width)) {
            const height = Math.max(Math.abs(previous.height || before[3] || 0), Math.abs(item.height || current[3] || 0), 1);
            const gap = current[4] - before[4] - previous.width;
            separator = Math.abs(current[5] - before[5]) > height * 0.5 ? '\n' : gap > height * 2 ? '\t' : gap > height * 0.15 ? ' ' : '';
          }
          text += separator;
        }
        text += item.str;
        if (item.hasEOL) text += '\n';
        if (text.length > RUBRIC_LIMITS.textCharacters && (text.length > RUBRIC_LIMITS.textCharacters + 1024 || text.trim().length > RUBRIC_LIMITS.textCharacters)) throw error('RUBRIC_TEXT_LIMIT', 'The rubric exceeds 40,000 characters. Use a shorter rubric or paste the relevant criteria; nothing has been imported.');
        previous = item;
      }
    },
    nextPage() { if (text && !text.endsWith('\n')) text += '\n'; previous = undefined; },
    value() { return validateRubricText(text.trim()); },
  };
}

export async function extractPdfText(bytes, pdfjs, { workerUrl, WorkerImpl = globalThis.Worker, timeoutMs = RUBRIC_LIMITS.pdfTimeoutMs } = {}) {
  let loadingTask, reader, timer, nativeWorker, pdfWorker, stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    // Kill our worker directly: PDF.js cleanup can wait forever on a busy parser.
    try { nativeWorker?.terminate(); } catch {}
    try { pdfWorker?.destroy(); } catch {}
    try { Promise.resolve(reader?.cancel()).catch(() => {}); } catch {}
    try { Promise.resolve(loadingTask?.destroy()).catch(() => {}); } catch {}
  };
  const timeoutError = () => error('RUBRIC_TIMEOUT', 'This PDF took too long to read. Try a simpler PDF or paste the rubric text.');
  const check = () => { if (stopped) throw timeoutError(); };
  try {
    if (typeof WorkerImpl !== 'function' || !workerUrl) throw error('RUBRIC_BROWSER', 'PDF import needs browser worker support. Try another browser or paste the rubric text.');
    try { nativeWorker = new WorkerImpl(workerUrl, { type: 'module' }); }
    catch { throw error('RUBRIC_BROWSER', 'The browser blocked the PDF reader worker. Try another browser or paste the rubric text.'); }
    const workerFailure = new Promise((_, reject) => {
      const failed = () => { stop(); reject(error('RUBRIC_READER', 'The PDF reader could not start or stopped unexpectedly. Reload the page or paste the rubric text.')); };
      nativeWorker.addEventListener('error', failed);
      nativeWorker.addEventListener('messageerror', failed);
    });
    // An explicit port prevents PDF.js from falling back to parsing on the UI thread.
    pdfWorker = new pdfjs.PDFWorker({ port: nativeWorker });
    const work = (async () => {
      loadingTask = pdfjs.getDocument({ data: bytes, worker: pdfWorker, useWorkerFetch: false, disableFontFace: true, useSystemFonts: false, enableXfa: false });
      const document = await loadingTask.promise;
      check();
      if (!Number.isSafeInteger(document.numPages) || document.numPages < 1) throw corrupt();
      if (document.numPages > RUBRIC_LIMITS.pdfPages) throw error('RUBRIC_PAGE_LIMIT', 'Choose a rubric PDF with 30 pages or fewer, or paste its relevant text.');
      const collector = createPdfTextCollector();
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
        check();
        const page = await document.getPage(pageNumber);
        check();
        reader = page.streamTextContent().getReader();
        let hasText = false;
        try {
          while (true) {
            check();
            const result = await reader.read();
            check();
            if (result.done) break;
            collector.add(result.value.items);
            if (result.value.items.some(item => typeof item.str === 'string' && item.str.trim())) hasText = true;
          }
          if (!hasText) throw error('RUBRIC_NO_TEXT', `Page ${pageNumber} has no readable text and may be blank or scanned. Remove blank pages, export a text-based PDF, or paste the rubric manually. This app does not perform OCR; nothing has been imported.`);
          collector.nextPage();
        } finally {
          try { Promise.resolve(reader?.cancel()).catch(() => {}); } catch {}
          reader = undefined;
          try { page.cleanup(); } catch {}
        }
      }
      return collector.value();
    })();
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { stop(); reject(timeoutError()); }, timeoutMs); });
    return await Promise.race([work, timeout, workerFailure]);
  } catch (problem) {
    if (problem instanceof RubricDocumentError) throw problem;
    if (problem?.name === 'PasswordException') throw error('RUBRIC_PASSWORD', 'This PDF is password-protected. Save an unlocked copy or paste the rubric text.');
    throw corrupt();
  } finally { clearTimeout(timer); stop(); }
}
