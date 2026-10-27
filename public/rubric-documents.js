import { validateRubricFile, validateRubricText, decodeDocumentBytes, extractDocxParts, docxPartsToText, extractPdfText, RubricDocumentError, RUBRIC_LIMITS } from '../lib/rubric-document.mjs';

export async function extractRubric(file, { signal } = {}) {
  const check = () => { if (signal?.aborted) throw new DOMException('Document reading canceled.', 'AbortError'); };
  check();
  const { name, extension } = validateRubricFile(file);
  let bytes;
  try { bytes = new Uint8Array(await file.arrayBuffer()); }
  catch { check(); throw new RubricDocumentError('RUBRIC_READ', 'This file could not be opened. Choose it again or paste the rubric text.'); }
  check();
  if (!bytes.length || bytes.length > RUBRIC_LIMITS.fileBytes) throw new RubricDocumentError('RUBRIC_FILE_LIMIT', 'Choose a nonempty rubric file of 5 MB or less.');
  let text;
  try {
    if (extension === 'txt') text = validateRubricText(decodeDocumentBytes(bytes));
    if (extension === 'docx') {
      const zip = await import('fflate');
      check();
      text = docxPartsToText(extractDocxParts(bytes, zip));
    }
    if (extension === 'pdf') {
      const [pdfjs, { default: workerUrl }] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
      check();
      text = await extractPdfText(bytes, pdfjs, { workerUrl, signal });
    }
  } catch (problem) {
    if (problem instanceof RubricDocumentError || problem?.name === 'AbortError') throw problem;
    throw new RubricDocumentError('RUBRIC_READER', 'The document reader could not load or read this file. Reload the page, try another file, or paste the rubric text.');
  }
  check(); return { text, name };
}
