import { validateRubricFile, decodeDocumentBytes, RubricDocumentError, RUBRIC_LIMITS } from './rubric-document.mjs';

export const PREVIEW_LIMITS = Object.freeze({ pages: 30, pixels: 4_000_000, side: 2400, pageHeight: 24_000, nodes: 40_000, timeoutMs: 30_000 });
const abortError = () => new DOMException('Document preview canceled.', 'AbortError');
const failure = (code, message) => new RubricDocumentError(code, message);
const check = signal => { if (signal?.aborted) throw abortError(); };
const clampWidth = value => Math.max(120, Math.min(1400, Number(value) || 720));
const CSP = "default-src 'none'; script-src 'none'; connect-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
const PAPER = 'html,body{margin:0;padding:0;height:100%;background:#fff;overflow:hidden}body{position:relative}*{box-sizing:border-box}.preview-paper{position:relative;left:0;top:0;transform-origin:top left;margin:0!important;box-shadow:none!important}pre.preview-paper{width:816px;min-height:1056px;padding:64px;font:15px/1.7 Georgia,serif;white-space:pre-wrap;overflow-wrap:anywhere;color:#252129}';

function safeStyle(css) {
  return String(css || '').replace(/@import[^;]*(?:;|$)/gi, '').replace(/[^{};]*url\s*\([^)]*\)[^;}]*;?/gi, '');
}

function textLines(line) {
  const chars = [...line], lines = []; let offset = 0;
  while (chars.length - offset > 84) {
    let end = 84;
    while (end > 0 && !/\s/u.test(chars[offset + end])) end--;
    // Retain original indentation; use a hard break only for an unbroken
    // token or an exceptionally long run of whitespace.
    if (end > 0 && chars.slice(offset, offset + end).some(char => !/\s/u.test(char))) {
      lines.push(chars.slice(offset, offset + end).join('')); offset += end + 1;
    } else { lines.push(chars.slice(offset, offset + 84).join('')); offset += 84; }
  }
  lines.push(chars.slice(offset).join('')); return lines;
}

// DOCX output stays in a script-disabled, network-disabled frame. This second
// pass also strips active nodes/attributes before any generated content is mounted.
export function sanitizePreviewDom(root) {
  const nodes = [...root.querySelectorAll('*')];
  if (nodes.length > PREVIEW_LIMITS.nodes) throw failure('RUBRIC_PREVIEW_COMPLEX', 'This document is too complex to preview. Export it as PDF to see its original layout.');
  for (const node of nodes) {
    if (/^(script|iframe|object|embed|link|base|meta|form|input|button|textarea|select|video|audio|source|foreignObject)$/i.test(node.localName)) { node.remove(); continue; }
    for (const attribute of [...node.attributes]) {
      if (/^on/i.test(attribute.name) || /^(?:href|xlink:href|srcset|action|formaction|target|download)$/i.test(attribute.name)) node.removeAttribute(attribute.name);
    }
    if (node.localName === 'img' && !/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/=\s]+$/i.test(node.getAttribute('src') || '')) { node.remove(); continue; }
    if (node.hasAttribute('style')) node.setAttribute('style', safeStyle(node.getAttribute('style')));
    if (node.localName === 'style') node.textContent = safeStyle(node.textContent);
  }
  return root;
}

export async function prepareRubricPreview(file, options = {}) {
  const { signal, document: dom = globalThis.document } = options;
  check(signal);
  const { name, extension: kind } = validateRubricFile(file);
  const bytes = new Uint8Array(await file.arrayBuffer());
  check(signal);
  if (!bytes.length || bytes.length > RUBRIC_LIMITS.fileBytes) throw failure('RUBRIC_FILE_LIMIT', 'Choose a nonempty rubric file of 5 MB or less.');
  if (!dom?.createElement) throw failure('RUBRIC_PREVIEW_BROWSER', 'Document preview needs a current browser.');
  let disposed = false, pageCount = 0, source = null, loadingTask = null, nativeWorker = null, pdfWorker = null;
  const views = new Map(), warnings = [], lifetime = new AbortController();
  function alive() { check(signal); if (disposed) throw abortError(); }
  function releaseView(view) {
    view.closed = true;
    try { view.task?.cancel(); } catch { /* Already complete. */ }
    view.stop?.();
    if (view.canvas) { view.canvas.width = 0; view.canvas.height = 0; }
    view.element?.remove();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    lifetime.abort();
    for (const view of views.values()) releaseView(view);
    views.clear();
    try { Promise.resolve(loadingTask?.destroy()).catch(() => {}); } catch { /* Worker is already stopped. */ }
    try { pdfWorker?.destroy(); } catch { /* Worker is already stopped. */ }
    nativeWorker?.terminate();
    source = null;
    signal?.removeEventListener('abort', dispose);
  }
  signal?.addEventListener('abort', dispose, { once: true });
  async function bounded(work, onTimeout, timeout = PREVIEW_LIMITS.timeoutMs) {
    let timer, abort;
    const interrupted = new Promise((_, reject) => {
      timer = setTimeout(() => { reject(failure('RUBRIC_PREVIEW_TIMEOUT', 'This document took too long to preview. Try exporting it as a simpler PDF.')); onTimeout?.(); }, timeout);
      abort = () => reject(abortError());
      if (lifetime.signal.aborted) abort();
      else lifetime.signal.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([work, interrupted]); }
    finally { clearTimeout(timer); lifetime.signal.removeEventListener('abort', abort); }
  }
  try {
    if (kind === 'pdf') {
      if (new TextDecoder().decode(bytes.subarray(0, 1024)).indexOf('%PDF-') < 0) throw failure('RUBRIC_CORRUPT', 'This is not a readable PDF file.');
      const { pdfjs, workerUrl, WorkerImpl = globalThis.Worker } = options;
      if (!pdfjs || !workerUrl || typeof WorkerImpl !== 'function') throw failure('RUBRIC_PREVIEW_BROWSER', 'The PDF preview could not start. Refresh or try a current browser.');
      nativeWorker = new WorkerImpl(workerUrl, { type: 'module' });
      pdfWorker = new pdfjs.PDFWorker({ port: nativeWorker });
      loadingTask = pdfjs.getDocument({ data: bytes, worker: pdfWorker, useWorkerFetch: false, isEvalSupported: false, enableXfa: false,
        disableFontFace: true, useSystemFonts: false, maxImageSize: 16_000_000, canvasMaxAreaInBytes: PREVIEW_LIMITS.pixels * 4 });
      source = await bounded(loadingTask.promise, dispose);
      alive(); pageCount = source.numPages;
    } else if (kind === 'docx') {
      if (typeof options.sanitizeDocx !== 'function' || typeof options.renderDocx !== 'function') throw failure('RUBRIC_PREVIEW_BROWSER', 'The Word preview could not start. Refresh or export the document as PDF.');
      const safe = await options.sanitizeDocx(bytes); alive();
      warnings.push(...(safe.warnings || []));
      const body = dom.createElement('div'), styles = dom.createElement('div');
      await bounded(options.renderDocx(safe.data, body, styles, { className: 'rubric-word', inWrapper: false, ignoreWidth: false, ignoreHeight: false,
        ignoreFonts: true, breakPages: true, ignoreLastRenderedPageBreak: false, useBase64URL: true, renderAltChunks: false,
        renderComments: false, renderChanges: false, renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true, experimental: false }), dispose);
      alive(); sanitizePreviewDom(body); sanitizePreviewDom(styles);
      const pages = [...body.querySelectorAll('section.rubric-word')];
      if (!pages.length) throw failure('RUBRIC_PREVIEW_EMPTY', 'This Word document could not be displayed. Export it as PDF to preview its layout.');
      source = { pages, styles: [...styles.querySelectorAll('style')].map(node => safeStyle(node.textContent)) };
      pageCount = pages.length;
      warnings.push('Word preview may differ from Microsoft Word. Export as PDF for exact pagination and complex graphics.');
    } else {
      const text = decodeDocumentBytes(bytes);
      if (text.length > RUBRIC_LIMITS.textCharacters || /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text)) throw failure('RUBRIC_PREVIEW_TEXT', 'This text file is too large or contains unreadable characters.');
      const lines = text.split(/\r?\n/).flatMap(textLines), pages = [];
      for (let offset = 0; offset < lines.length; offset += 48) pages.push(lines.slice(offset, offset + 48).join('\n'));
      source = { textPages: pages, styles: [] }; pageCount = pages.length;
    }
    if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > PREVIEW_LIMITS.pages) throw failure('RUBRIC_PAGE_LIMIT', 'Choose a rubric with 30 pages or fewer.');
    alive();
  } catch (error) {
    dispose();
    if (error?.name === 'PasswordException') throw failure('RUBRIC_PASSWORD', 'This PDF is password-protected. Save an unlocked copy to preview it.');
    throw error;
  }

  async function render(pageIndex, container, width = 720) {
    alive();
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount || !container?.replaceChildren) throw new TypeError('Choose a valid preview page and container.');
    const old = views.get(container); if (old) releaseView(old);
    const view = { closed: false, element: null, canvas: null, task: null, stop: null }; views.set(container, view);
    const current = () => { alive(); if (view.closed || views.get(container) !== view) throw abortError(); };
    const displayWidth = clampWidth(width);
    try {
      if (kind === 'pdf') {
        const page = await bounded(source.getPage(pageIndex + 1), () => releaseView(view)); current();
        try {
          const base = page.getViewport({ scale: 1 });
          const scale = Math.min(displayWidth * Math.min(2, globalThis.devicePixelRatio || 1) / base.width,
            PREVIEW_LIMITS.side / base.width, PREVIEW_LIMITS.side / base.height, Math.sqrt(PREVIEW_LIMITS.pixels / (base.width * base.height)));
          if (!Number.isFinite(scale) || scale <= 0) throw failure('RUBRIC_PREVIEW_PAGE', 'This PDF page has invalid dimensions.');
          const viewport = page.getViewport({ scale });
          const canvas = dom.createElement('canvas'); view.canvas = canvas; view.element = canvas;
          canvas.width = Math.max(1, Math.floor(viewport.width)); canvas.height = Math.max(1, Math.floor(viewport.height));
          canvas.style.width = `${displayWidth}px`; canvas.style.maxWidth = '100%'; canvas.style.height = 'auto';
          canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', `${name}, page ${pageIndex + 1}`);
          const context = canvas.getContext('2d', { alpha: false });
          if (!context) throw failure('RUBRIC_PREVIEW_BROWSER', 'Your browser could not draw this PDF page.');
          view.task = page.render({ canvasContext: context, viewport, background: 'rgb(255,255,255)' });
          await bounded(view.task.promise, () => releaseView(view)); current();
          container.replaceChildren(canvas);
          return { width: displayWidth, height: displayWidth * base.height / base.width };
        } finally { page.cleanup(); }
      }
      const frame = dom.createElement('iframe'); view.element = frame;
      frame.setAttribute('sandbox', 'allow-same-origin'); frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.setAttribute('tabindex', '-1');
      frame.setAttribute('title', `${name}, page ${pageIndex + 1}`); frame.style.border = '0'; frame.style.width = `${displayWidth}px`; frame.style.maxWidth = '100%';
      const loaded = new Promise((resolve, reject) => {
        const onLoad = () => {
          // Browsers can emit an initial about:blank load before applying
          // srcdoc. Mount only into the document carrying our sandbox policy.
          if (!frame.contentDocument?.querySelector('meta[name="rubric-preview-ready"]')) return;
          cleanup(); resolve();
        };
        const cleanup = () => { frame.removeEventListener('load', onLoad); };
        view.stop = () => { cleanup(); reject(abortError()); };
        frame.addEventListener('load', onLoad);
      });
      frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="rubric-preview-ready" content="true"></head><body></body></html>`;
      container.replaceChildren(frame);
      await bounded(loaded, () => releaseView(view)); current(); view.stop = null;
      const doc = frame.contentDocument;
      if (!doc?.body) throw failure('RUBRIC_PREVIEW_BROWSER', 'The browser blocked this document preview.');
      for (const css of [PAPER, ...source.styles]) { const style = doc.createElement('style'); style.textContent = css; doc.head.append(style); }
      let paper;
      if (kind === 'txt') { paper = doc.createElement('pre'); paper.textContent = source.textPages[pageIndex]; }
      else paper = doc.importNode(source.pages[pageIndex], true);
      paper.classList.add('preview-paper'); doc.body.append(paper);
      // Intrinsic image sizes can arrive after DOM insertion. Resolve them
      // before measuring, so a late image never leaves content cut off.
      await bounded(Promise.all([...paper.querySelectorAll('img')].map(img => typeof img.decode === 'function' ? img.decode().catch(() => {}) : Promise.resolve())), () => releaseView(view));
      current();
      const naturalWidth = Math.max(300, Math.min(2000, paper.getBoundingClientRect().width || 816));
      const scale = displayWidth / naturalWidth;
      paper.style.transform = `scale(${scale})`;
      const height = Math.max(100, Math.ceil(Math.max(paper.scrollHeight || 0, paper.offsetHeight || 0, 1056) * scale));
      if (height > PREVIEW_LIMITS.pageHeight) throw failure('RUBRIC_PREVIEW_PAGE_LIMIT', 'This Word page is too tall to preview safely. Export it as PDF to preserve its page breaks.');
      frame.style.height = `${height}px`;
      current(); return { width: displayWidth, height: parseFloat(frame.style.height) };
    } catch (error) {
      if (views.get(container) === view) { releaseView(view); views.delete(container); }
      throw error;
    }
  }
  return { kind, name, pageCount, warnings: [...new Set(warnings)], render, dispose };
}
