import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { prepareRubricPreview, sanitizePreviewDom, PREVIEW_LIMITS } from '../lib/rubric-preview.mjs';

const file = (name, text) => new File([text], name);
const later = () => new Promise(resolve => setImmediate(resolve));
function environment({ initialBlankLoad = false } = {}) {
  const { document } = parseHTML('<html><head></head><body></body></html>');
  const createElement = document.createElement.bind(document);
  document.createElement = name => {
    const node = createElement(name);
    if (name === 'canvas') node.getContext = () => ({});
    if (name === 'iframe') {
      Object.defineProperty(node, 'contentDocument', { writable: true, value: parseHTML('<html><head></head><body></body></html>').document });
      Object.defineProperty(node, 'srcdoc', { set(value) {
        this._srcdoc = value;
        queueMicrotask(async () => {
          if (initialBlankLoad) { node.dispatchEvent(new document.defaultView.Event('load')); await later(); }
          node.contentDocument = parseHTML(value).document;
          node.dispatchEvent(new document.defaultView.Event('load'));
        });
      }, get() { return this._srcdoc; } });
    }
    return node;
  };
  const container = document.createElement('div'); document.body.append(container);
  return { document, container };
}
function pdf(overrides = {}) {
  const seen = { terminated: 0, destroyed: 0, renders: [], cleanups: 0, requested: [], cancel: 0 };
  const pages = {
    getViewport({ scale }) { return { width: 600 * scale, height: 900 * scale }; },
    render(options) { seen.renders.push(options); return { promise: overrides.renderPromise || Promise.resolve(), cancel() { seen.cancel++; } }; },
    cleanup() { seen.cleanups++; }, ...overrides.page,
  };
  const document = { numPages: overrides.numPages || 2, async getPage(index) { seen.requested.push(index); return pages; } };
  return { seen, workerUrl: '/worker.mjs', WorkerImpl: class { terminate() { seen.terminated++; } }, pdfjs: {
    PDFWorker: class { destroy() {} },
    getDocument(options) { seen.options = options; return { promise: overrides.loadPromise || Promise.resolve(document), destroy() { seen.destroyed++; return Promise.resolve(); } }; },
  } };
}

test('PDF previews scanned pages visually without extracting text or accessing a URL', async () => {
  const dom = environment(), engine = pdf();
  const preview = await prepareRubricPreview(file('scan.pdf', '%PDF-1.7\nscan'), { ...dom, ...engine });
  assert.equal(preview.pageCount, 2); await preview.render(1, dom.container, 240);
  assert.equal(dom.container.firstElementChild.localName, 'canvas');
  assert.deepEqual(engine.seen.requested, [2]);
  assert.equal(engine.seen.options.isEvalSupported, false); assert.equal(engine.seen.options.enableXfa, false);
  assert.equal(engine.seen.options.useWorkerFetch, false); assert.equal(engine.seen.options.url, undefined);
  assert.equal(engine.seen.cleanups, 1); preview.dispose();
  assert.equal(engine.seen.terminated, 1); assert.equal(dom.container.childElementCount, 0);
});

test('PDF canvas dimensions are bounded for enormous pages and high display widths', async () => {
  const dom = environment(), engine = pdf({ page: { getViewport({ scale }) { return { width: 100000 * scale, height: 100000 * scale }; } } });
  const preview = await prepareRubricPreview(file('large.pdf', '%PDF-1.7'), { ...dom, ...engine });
  await preview.render(0, dom.container, 50000); const canvas = dom.container.firstElementChild;
  assert.ok(canvas.width <= PREVIEW_LIMITS.side); assert.ok(canvas.height <= PREVIEW_LIMITS.side);
  assert.ok(canvas.width * canvas.height <= PREVIEW_LIMITS.pixels); preview.dispose();
});

test('PDF rejects extreme aspect ratios and nonfinite page sizes before allocating a canvas', async () => {
  for (const [width, height] of [[1, 1_000_000], [0, 100], [Infinity, 100], [NaN, 100], [-100, -100]]) {
    const dom = environment(), engine = pdf({ page: { getViewport({ scale }) { return { width: width * scale, height: height * scale }; } } });
    const preview = await prepareRubricPreview(file('hostile.pdf', '%PDF-1.7'), { ...dom, ...engine });
    await assert.rejects(preview.render(0, dom.container), { code: 'RUBRIC_PREVIEW_PAGE' });
    assert.equal(engine.seen.renders.length, 0); assert.equal(dom.container.childElementCount, 0); preview.dispose();
  }
});

test('PDF abort cancels rendering, destroys worker, and prevents late mounting', async () => {
  let done; const renderPromise = new Promise(resolve => { done = resolve; });
  const controller = new AbortController(), dom = environment(), engine = pdf({ renderPromise });
  const preview = await prepareRubricPreview(file('pending.pdf', '%PDF-1.7'), { ...dom, ...engine, signal: controller.signal });
  const pending = preview.render(0, dom.container, 250); await later(); controller.abort(); done();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(dom.container.childElementCount, 0);
  assert.equal(engine.seen.cancel, 1); assert.equal(engine.seen.terminated, 1);
  await assert.rejects(preview.render(0, dom.container), { name: 'AbortError' });
});

test('a failed full-page render preserves the independent existing thumbnail', async () => {
  const dom = environment(), engine = pdf(); const full = dom.document.createElement('div');
  const preview = await prepareRubricPreview(file('two.pdf', '%PDF-1.7'), { ...dom, ...engine });
  await preview.render(0, dom.container, 200); const thumbnail = dom.container.firstElementChild;
  full.replaceChildren = () => { throw Error('Cannot mount'); };
  await assert.rejects(preview.render(1, full), /Cannot mount/);
  assert.equal(dom.container.firstElementChild, thumbnail); assert.ok(thumbnail.width > 0);
  preview.dispose(); assert.equal(thumbnail.width, 0);
});

test('manual disposal promptly rejects pending work and clears both views', async () => {
  const dom = environment(), engine = pdf(), full = dom.document.createElement('div');
  const preview = await prepareRubricPreview(file('two.pdf', '%PDF-1.7'), { ...dom, ...engine });
  await preview.render(0, dom.container, 200); await preview.render(1, full, 700);
  const thumbnail = dom.container.firstElementChild, page = full.firstElementChild;
  preview.dispose(); assert.equal(thumbnail.width, 0); assert.equal(page.width, 0);
  assert.equal(dom.container.childElementCount, 0); assert.equal(full.childElementCount, 0);

  const pendingEngine = pdf({ renderPromise: new Promise(() => {}) });
  const pendingPreview = await prepareRubricPreview(file('pending.pdf', '%PDF-1.7'), { ...dom, ...pendingEngine });
  const pending = pendingPreview.render(0, dom.container); await later(); pendingPreview.dispose();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(pendingEngine.seen.cancel, 1);
});

test('a stale PDF render cannot replace or remove the newer page in the same view', async () => {
  const dom = environment(); let completeOld, count = 0;
  const engine = pdf({ page: { render() {
    return { promise: ++count === 1 ? new Promise(resolve => { completeOld = resolve; }) : Promise.resolve(), cancel() {} };
  } } });
  const preview = await prepareRubricPreview(file('two.pdf', '%PDF-1.7'), { ...dom, ...engine });
  const old = preview.render(0, dom.container); await later(); await preview.render(1, dom.container);
  const current = dom.container.firstElementChild; completeOld();
  await assert.rejects(old, { name: 'AbortError' }); assert.equal(dom.container.firstElementChild, current); assert.ok(current.width > 0);
  preview.dispose();
});

test('limits and canceled inputs reject before document rendering', async () => {
  const dom = environment(), engine = pdf({ numPages: 31 });
  await assert.rejects(prepareRubricPreview(file('many.pdf', '%PDF-1.7'), { ...dom, ...engine }), { code: 'RUBRIC_PAGE_LIMIT' });
  assert.equal(engine.seen.destroyed, 1);
  await assert.rejects(prepareRubricPreview(file('fake.pdf', '<html>'), { ...dom, ...pdf() }), { code: 'RUBRIC_CORRUPT' });
  await assert.rejects(prepareRubricPreview(file('notes.txt', 'x'), { ...dom, signal: AbortSignal.abort() }), { name: 'AbortError' });
});

test('TXT is a readable paper page with inert literal HTML and bounded pagination', async () => {
  const dom = environment(); const preview = await prepareRubricPreview(file('notes.txt', '<script>alert(1)</script>\nCriterion A\n  Excellent'), dom);
  await preview.render(0, dom.container, 220); const frame = dom.container.firstElementChild;
  assert.equal(frame.getAttribute('sandbox'), 'allow-same-origin');
  assert.equal(frame.getAttribute('tabindex'), '-1');
  assert.match(frame.srcdoc, /script-src 'none'/); assert.match(frame.srcdoc, /connect-src 'none'/);
  assert.equal(frame.contentDocument.querySelector('script'), null);
  assert.equal(frame.contentDocument.querySelector('pre').textContent, '<script>alert(1)</script>\nCriterion A\n  Excellent');
  const paperCss = frame.contentDocument.querySelector('style').textContent;
  assert.match(paperCss, /html,body\{[^}]*height:100%/);
  assert.match(paperCss, /\.preview-paper\{position:relative/);
  preview.dispose(); assert.equal(dom.container.childElementCount, 0);
  const long = await prepareRubricPreview(file('long.txt', 'x'.repeat(20000)), dom);
  assert.ok(long.pageCount > 1); long.dispose();
});

test('an initial blank iframe load cannot erase the mounted document preview', async () => {
  const dom = environment({ initialBlankLoad: true });
  const preview = await prepareRubricPreview(file('notes.txt', 'Actual rubric text'), dom);
  await preview.render(0, dom.container, 184); await later();
  const content = dom.container.firstElementChild.contentDocument;
  assert.equal(content.querySelector('pre').textContent, 'Actual rubric text');
  assert.ok(content.querySelector('meta[name="rubric-preview-ready"]'));
  preview.dispose();
});

test('TXT line wrapping keeps ordinary words whole and original indentation', async () => {
  const dom = environment();
  const preview = await prepareRubricPreview(file('notes.txt', `  ${'word '.repeat(15)}sequence continues`), dom);
  await preview.render(0, dom.container);
  const rendered = dom.container.firstElementChild.contentDocument.querySelector('pre').textContent;
  assert.match(rendered, /^  word/); assert.match(rendered, /\nsequence continues$/);
  assert.doesNotMatch(rendered, /seq\nuence/); preview.dispose();
});

test('DOCX passes safe renderer settings and preserves formatted tables and embedded images', async () => {
  const dom = environment(); let called = false;
  const preview = await prepareRubricPreview(file('rubric.docx', 'PKfixture'), { ...dom,
    sanitizeDocx: bytes => ({ data: bytes.buffer, warnings: ['A native chart needs a PDF export.'] }),
    renderDocx: async (data, body, styles, options) => {
      called = true; assert.equal(options.renderAltChunks, false); assert.equal(options.ignoreFonts, true); assert.equal(options.useBase64URL, true);
      body.innerHTML = '<section class="rubric-word" style="width:816px"><h1>Rubric</h1><table><tr><th>Criteria</th><th>Excellent</th></tr><tr><td>Evidence</td><td>Strong examples</td></tr></table><img src="data:image/png;base64,AAAA"></section>';
      styles.innerHTML = '<style>.rubric-word table{border-collapse:collapse}</style>';
    },
  });
  assert.ok(called); assert.equal(preview.pageCount, 1); assert.match(preview.warnings.join(' '), /native chart/);
  await preview.render(0, dom.container, 220); const inside = dom.container.firstElementChild.contentDocument;
  assert.equal(inside.querySelectorAll('table td').length, 2); assert.equal(inside.querySelector('img').src, 'data:image/png;base64,AAAA');
  assert.match(inside.querySelector('section').style.transform, /scale/); preview.dispose();
});

test('DOCX output hardening removes active markup, external media, and CSS URLs', () => {
  const dom = environment(), root = dom.document.createElement('div');
  root.innerHTML = '<script>bad()</script><iframe src="https://bad.invalid"></iframe><a href="javascript:bad()" onclick="bad()">Text</a><img src="https://bad.invalid/tracker"><img src="data:image/svg+xml;base64,AAAA"><style>@import "https://bad.invalid";p{background:url(https://bad.invalid)}</style><p style="color:red;background:url(https://bad.invalid)">Safe text</p>';
  sanitizePreviewDom(root);
  assert.equal(root.querySelector('script,iframe,img'), null);
  assert.equal(root.querySelector('a').getAttribute('href'), null); assert.equal(root.querySelector('a').getAttribute('onclick'), null);
  assert.doesNotMatch(root.innerHTML, /bad\.invalid/); assert.match(root.textContent, /Safe text/);
});

test('preview markup stress removes active content and adjacent CSS URLs without slow scanning of long values', () => {
  const dom = environment(), root = dom.document.createElement('div');
  root.innerHTML = '<style>.word{font-family:' + 'a'.repeat(200_000) + ';background:url(https://bad.invalid/one);cursor:url(https://bad.invalid/two),auto;color:purple}</style>' +
    Array.from({ length: 500 }, (_, i) => `<p onclick="alert(${i})">Criterion ${i}</p><svg><foreignObject><iframe src="https://bad.invalid/frame"></iframe></foreignObject><a xlink:href="javascript:bad()">Link</a></svg><img src="data:image/svg+xml;base64,AAAA"><object data="https://bad.invalid/object"></object><form action="https://bad.invalid/send"><input value="private"></form>`).join('');
  sanitizePreviewDom(root);
  assert.equal(root.querySelectorAll('p').length, 500);
  assert.equal(root.querySelector('iframe,object,form,input,img,foreignObject'), null);
  assert.doesNotMatch(root.innerHTML, /bad\.invalid|javascript:|onclick|xlink:href/);
  assert.match(root.querySelector('style').textContent, /color:purple/);
});

test('an exceptionally tall Word page reports a limit instead of silently clipping', async () => {
  const dom = environment(), full = dom.document.createElement('div');
  const prototype = dom.document.defaultView.HTMLElement.prototype;
  const originalHeight = Object.getOwnPropertyDescriptor(prototype, 'scrollHeight');
  Object.defineProperty(prototype, 'scrollHeight', { configurable: true, get() { return this.localName === 'section' ? 50_000 : 0; } });
  try {
    const preview = await prepareRubricPreview(file('long.docx', 'PKfixture'), { ...dom,
      sanitizeDocx: bytes => ({ data: bytes.buffer, warnings: [] }),
      renderDocx: async (_data, body) => { body.innerHTML = '<section class="rubric-word"><p>Long document</p></section>'; },
    });
    await preview.render(0, dom.container, 184); const thumbnail = dom.container.firstElementChild;
    await assert.rejects(preview.render(0, full, 760), { code: 'RUBRIC_PREVIEW_PAGE_LIMIT' });
    assert.equal(dom.container.firstElementChild, thumbnail); assert.equal(full.childElementCount, 0);
    preview.dispose();
  } finally {
    if (originalHeight) Object.defineProperty(prototype, 'scrollHeight', originalHeight); else delete prototype.scrollHeight;
  }
});

test('wide Word pages scale their actual width instead of clipping and extreme widths fail explicitly', async () => {
  const dom = environment(), prototype = dom.document.defaultView.HTMLElement.prototype;
  const original = prototype.getBoundingClientRect; let width = 3840;
  prototype.getBoundingClientRect = function () { return this.localName === 'section' ? { width } : original.call(this); };
  try {
    const preview = await prepareRubricPreview(file('wide.docx', 'PKfixture'), { ...dom,
      sanitizeDocx: bytes => ({ data: bytes.buffer, warnings: [] }),
      renderDocx: async (_data, body) => { body.innerHTML = '<section class="rubric-word"><p>Wide document</p></section>'; },
    });
    await preview.render(0, dom.container, 760);
    assert.equal(dom.container.firstElementChild.contentDocument.querySelector('section').style.transform, `scale(${760 / 3840})`);
    width = PREVIEW_LIMITS.pageWidth + 1;
    await assert.rejects(preview.render(0, dom.container, 760), { code: 'RUBRIC_PREVIEW_PAGE_LIMIT' });
    assert.equal(dom.container.childElementCount, 0); preview.dispose();
  } finally { prototype.getBoundingClientRect = original; }
});
