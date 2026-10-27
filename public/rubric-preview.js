import { prepareRubricPreview as prepare } from '../lib/rubric-preview.mjs';
import { validateRubricFile } from '../lib/rubric-document.mjs';

export async function prepareRubricPreview(file, options = {}) {
  const { extension } = validateRubricFile(file);
  if (options.signal?.aborted) throw new DOMException('Document preview canceled.', 'AbortError');
  if (extension === 'pdf') {
    const [pdfjs, { default: workerUrl }] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
    return prepare(file, { ...options, pdfjs, workerUrl });
  }
  if (extension === 'docx') {
    const [docx, zip, { prepareDocxPreview }] = await Promise.all([import('docx-preview'), import('fflate'), import('../lib/rubric-preview-input.mjs')]);
    return prepare(file, { ...options, renderDocx: docx.renderAsync, sanitizeDocx: bytes => prepareDocxPreview(bytes, zip) });
  }
  return prepare(file, options);
}
