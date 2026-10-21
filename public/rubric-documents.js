import { validateRubricFile, validateRubricText, decodeDocumentBytes, extractDocxParts, docxPartsToText, extractPdfText, RubricDocumentError, RUBRIC_LIMITS } from '../lib/rubric-document.mjs';

export async function extractRubric(file) {
  const { name, extension } = validateRubricFile(file);
  let bytes;
  try { bytes = new Uint8Array(await file.arrayBuffer()); }
  catch { throw new RubricDocumentError('RUBRIC_READ', 'This file could not be opened. Choose it again or paste the rubric text.'); }
  if (!bytes.length || bytes.length > RUBRIC_LIMITS.fileBytes) throw new RubricDocumentError('RUBRIC_FILE_LIMIT', 'Choose a nonempty rubric file of 5 MB or less.');
  let text;
  try {
    if (extension === 'txt') text = validateRubricText(decodeDocumentBytes(bytes));
    if (extension === 'docx') {
      const zip = await import('fflate');
      text = docxPartsToText(extractDocxParts(bytes, zip));
    }
    if (extension === 'pdf') {
      const [pdfjs, { default: workerUrl }] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      text = await extractPdfText(bytes, pdfjs);
    }
  } catch (problem) {
    if (problem instanceof RubricDocumentError) throw problem;
    throw new RubricDocumentError('RUBRIC_READER', 'The document reader could not load or read this file. Reload the page, try another file, or paste the rubric text.');
  }
  return { text, name };
}
