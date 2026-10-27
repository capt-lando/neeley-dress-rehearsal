import test from 'node:test';
import assert from 'node:assert/strict';
import * as zip from 'fflate';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { prepareDocxPreview, DOCX_PREVIEW_LIMITS } from '../lib/rubric-preview-input.mjs';

class StrictParser extends DOMParser { constructor() { super({ onError() { throw Error('Invalid XML'); } }); } }
const deps = { ...zip, DOMParserImpl: StrictParser, XMLSerializerImpl: XMLSerializer };
const utf8 = value => new TextEncoder().encode(value), decode = data => new TextDecoder().decode(data);
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const xml = body => `<?xml version="1.0"?><w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:a="${A}"><w:body>${body}</w:body></w:document>`;
const paragraph = text => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const relation = (id, type, target, mode = '') => `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ''}/>`;
const rels = body => `<Relationships xmlns="${PKG}">${body}</Relationships>`;
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9b0AAAAASUVORK5CYII=', 'base64'));
const archive = (body = paragraph('Rubric'), extra = {}) => zip.zipSync({ 'word/document.xml': utf8(xml(body)), ...extra });
const prepare = input => prepareDocxPreview(input, deps);
const parts = result => zip.unzipSync(new Uint8Array(result.data));

test('visual DOCX preparation preserves real tables, text, styles, headers, and embedded images', () => {
  const result = prepare(archive(`<w:tbl><w:tr><w:tc>${paragraph('Criteria')}</w:tc><w:tc>${paragraph('Excellent')}</w:tc></w:tr></w:tbl><w:drawing><a:blip r:embed="photo"/></w:drawing>`, {
    'word/styles.xml': utf8(`<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Normal"><w:rPr><w:rFonts w:ascii="Times New Roman"/><w:b/></w:rPr></w:style></w:styles>`),
    'word/header1.xml': utf8(`<w:hdr xmlns:w="${W}">${paragraph('Instructor rubric')}</w:hdr>`),
    'word/media/image1.png': png,
    'word/_rels/document.xml.rels': utf8(rels(relation('photo', 'image', 'media/image1.png') + relation('style', 'styles', 'styles.xml') + relation('header', 'header', 'header1.xml'))),
  }));
  assert.ok(result.data instanceof ArrayBuffer); assert.deepEqual(result.warnings, []);
  const output = parts(result);
  assert.match(decode(output['word/document.xml']), /<w:tbl>.*Criteria.*Excellent.*r:embed="photo"/);
  assert.match(decode(output['word/styles.xml']), /Times New Roman/);
  assert.match(decode(output['word/header1.xml']), /Instructor rubric/);
  assert.deepEqual(output['word/media/image1.png'], png);
  assert.match(decode(output['word/_rels/document.xml.rels']), /Target="\/word\/media\/image1.png"/);
  assert.match(decode(output['[Content_Types].xml']), /wordprocessingml.header\+xml/);
});

test('remote relationships, links, active objects and embedded fonts never reach the renderer', () => {
  const result = prepare(archive(`<w:hyperlink r:id="remote">${paragraph('Visible link text')}</w:hyperlink><w:altChunk r:id="html"/><w:object><w:t>OLE</w:t></w:object><w:drawing><a:blip r:link="remoteImage"/></w:drawing>`, {
    'word/_rels/document.xml.rels': utf8(rels(relation('remote', 'hyperlink', 'https://evil.invalid/click', 'External') + relation('remoteImage', 'image', 'https://evil.invalid/pixel', 'External') + relation('html', 'aFChunk', 'evil.html') + relation('embedded', 'oleObject', 'embeddings/object.bin'))),
    'word/fontTable.xml': utf8(`<w:fonts xmlns:w="${W}" xmlns:r="${R}"><w:font w:name="Calibri"><w:embedRegular r:id="font"/></w:font></w:fonts>`),
    'word/fonts/embedded.odttf': utf8('font'), 'word/embeddings/object.bin': utf8('object'),
    'word/evil.html': utf8('<script>alert(1)</script>'), 'word/vbaProject.bin': utf8('macro'),
    '[Content_Types].xml': utf8('<malicious/>'), '_rels/.rels': utf8(rels(relation('bad', 'officeDocument', 'https://evil.invalid/document', 'External'))),
  }));
  const output = parts(result), body = decode(output['word/document.xml']);
  assert.match(body, /Visible link text/); assert.doesNotMatch(body, /hyperlink|altChunk|object|r:link/);
  for (const data of Object.values(output)) assert.doesNotMatch(decode(data), /evil\.invalid|<script|embedRegular|macro/);
  assert.equal(output['word/fonts/embedded.odttf'], undefined);
  assert.equal(output['word/embeddings/object.bin'], undefined);
  assert.ok(result.warnings.some(value => /External links/.test(value)));
  assert.ok(result.warnings.some(value => /Embedded objects/.test(value)));
});

test('ordinary field results survive while executable field instructions are removed', () => {
  const output = parts(prepare(archive(`<w:fldSimple w:instr="INCLUDEPICTURE https://evil.invalid/pixel">${paragraph('Shown result')}</w:fldSimple><w:p><w:r><w:instrText>DDEAUTO evil</w:instrText><w:fldChar w:fldCharType="begin"/><w:t>Page 1</w:t></w:r></w:p>`)));
  const text = decode(output['word/document.xml']);
  assert.match(text, /Shown result/); assert.match(text, /Page 1/);
  assert.doesNotMatch(text, /INCLUDEPICTURE|DDEAUTO|fldSimple|fldChar|instrText/);
});

test('unused Word settings do not produce a false chart or equation warning', () => {
  const result = prepare(archive(paragraph('Ordinary table rubric'), {
    'word/settings.xml': utf8(`<w:settings xmlns:w="${W}" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><m:mathPr><m:mathFont m:val="Cambria Math"/></m:mathPr><o:shapedefaults/><w14:docId w14:val="123"/><w14:defaultImageDpi w14:val="300"/></w:settings>`),
  }));
  assert.deepEqual(result.warnings, []);
  assert.doesNotMatch(decode(parts(result)['word/settings.xml']), /<m:mathPr|<o:shapedefaults|<w14:docId/);
});

test('an unsupported native graphic keeps its supported embedded raster fallback', () => {
  const result = prepare(archive(`<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="c"><w:drawing><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="chart"/></w:drawing></mc:Choice><mc:Fallback><w:drawing><a:blip r:embed="fallback"/></w:drawing></mc:Fallback></mc:AlternateContent>`, {
    'word/media/fallback.png': png,
    'word/_rels/document.xml.rels': utf8(rels(relation('chart', 'chart', 'charts/chart1.xml') + relation('fallback', 'image', 'media/fallback.png'))),
    'word/charts/chart1.xml': utf8('<chart/>'),
  }));
  const output = parts(result), body = decode(output['word/document.xml']);
  assert.doesNotMatch(body, /<c:chart|AlternateContent|mc:Choice/);
  assert.match(body, /r:embed="fallback"/); assert.deepEqual(output['word/media/fallback.png'], png);
  assert.ok(result.warnings.some(value => /fallback image/.test(value)));
});

test('unsupported charts, SmartArt, vectors, and alternative image formats are visibly disclosed and omitted', () => {
  const result = prepare(archive(`<w:drawing><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="chart"/></w:drawing>`, {
    'word/charts/chart1.xml': utf8('<chart/>'), 'word/diagrams/data1.xml': utf8('<diagram/>'),
    'word/media/picture.svg': utf8('<svg onload="alert(1)"/>'), 'word/media/picture.emf': utf8('vector'),
    'word/_rels/document.xml.rels': utf8(rels(relation('chart', 'chart', 'charts/chart1.xml') + relation('svg', 'image', 'media/picture.svg'))),
  }));
  const output = parts(result);
  assert.equal(output['word/charts/chart1.xml'], undefined); assert.equal(output['word/media/picture.svg'], undefined);
  assert.doesNotMatch(decode(output['word/document.xml']), /<c:chart/);
  assert.ok(result.warnings.some(value => /charts, SmartArt/.test(value)));
  assert.ok(result.warnings.some(value => /PNG and JPEG/.test(value)));
});

test('XML doctypes, entities, processing instructions, malformed XML, and foreign roots are rejected', () => {
  for (const value of [
    `<!DOCTYPE x [<!ENTITY x SYSTEM "https://evil.invalid">]>${xml(paragraph('&x;'))}`,
    `<?xml-stylesheet href="https://evil.invalid/style"?>${xml(paragraph('text'))}`,
    `<w:document xmlns:w="${W}"><w:body></w:document>`, '<svg xmlns="http://www.w3.org/2000/svg"/>',
  ]) assert.throws(() => prepare(zip.zipSync({ 'word/document.xml': utf8(value) })), { code: 'RUBRIC_PREVIEW_CORRUPT' });
});

test('ZIP output is bounded by actual inflation even when metadata lies', () => {
  const data = archive(paragraph('x'.repeat(DOCX_PREVIEW_LIMITS.xmlBytes)));
  new DataView(data.buffer).setUint32(22, 10, true);
  assert.throws(() => prepare(data), { code: 'RUBRIC_PREVIEW_LIMIT' });
  const mismatch = archive(); new DataView(mismatch.buffer).setUint32(22, 10, true);
  assert.throws(() => prepare(mismatch), { code: 'RUBRIC_PREVIEW_CORRUPT' });
  const ignored = prepare(archive(paragraph('Only this text'), { 'word/embeddings/huge.bin': new Uint8Array(20 * 1024 * 1024) }));
  assert.equal(parts(ignored)['word/embeddings/huge.bin'], undefined);
  assert.ok(ignored.data.byteLength < 5000);
});

test('ZIP traversal, ambiguous case duplicates, excess entries, and unsupported compression are rejected', () => {
  for (const name of ['../word/document.xml', 'word/../../evil.xml', '/word/styles.xml', 'word\\styles.xml', 'WORD/document.xml']) {
    assert.throws(() => prepare(archive(undefined, { [name]: utf8('bad') })), { code: 'RUBRIC_PREVIEW_CORRUPT' });
  }
  const many = Object.fromEntries(Array.from({ length: 1024 }, (_, index) => [`ignored/${index}`, new Uint8Array()]));
  assert.throws(() => prepare(archive(undefined, many)), { code: 'RUBRIC_PREVIEW_LIMIT' });
  const compressed = archive(); new DataView(compressed.buffer).setUint16(8, 99, true);
  assert.throws(() => prepare(compressed), { code: 'RUBRIC_PREVIEW_CORRUPT' });
});

test('all XML parts share the complexity budget; deep XML and oversized attribute lists are rejected', () => {
  assert.throws(() => prepare(archive('<w:p>'.repeat(129) + '<w:t>x</w:t>' + '</w:p>'.repeat(129))), { code: 'RUBRIC_PREVIEW_LIMIT' });
  const attrs = Array.from({ length: 129 }, (_, index) => `a${index}="x"`).join(' ');
  assert.throws(() => prepare(archive(`<w:p ${attrs}/>`)), { code: 'RUBRIC_PREVIEW_LIMIT' });
});

test('image signatures and decoded dimensions are bounded before renderer image loading', () => {
  assert.throws(() => prepare(archive(undefined, { 'word/media/image.png': utf8('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>') })), { code: 'RUBRIC_PREVIEW_CORRUPT' });
  const huge = png.slice(); new DataView(huge.buffer).setUint32(16, 12000); new DataView(huge.buffer).setUint32(20, 12000);
  assert.throws(() => prepare(archive(undefined, { 'word/media/image.png': huge })), { code: 'RUBRIC_PREVIEW_LIMIT' });
  const truncated = png.slice(0, 25);
  assert.throws(() => prepare(archive(undefined, { 'word/media/image.png': truncated })), { code: 'RUBRIC_PREVIEW_CORRUPT' });
  const frame = new Uint8Array(12); new DataView(frame.buffer).setUint32(4, 0x6163544c);
  const animated = new Uint8Array(png.length + frame.length); animated.set(png.subarray(0, 33)); animated.set(frame, 33); animated.set(png.subarray(33), 45);
  assert.throws(() => prepare(archive(undefined, { 'word/media/image.png': animated })), { code: 'RUBRIC_PREVIEW_IMAGE' });
});

test('unsafe font CSS, prototype-shaped identifiers, event attributes, and giant page dimensions are removed', () => {
  const output = parts(prepare(archive(`<w:p w:styleId="__proto__" onclick="alert(1)"><w:rPr><w:rFonts w:ascii="A'bad" w:hAnsi="url(&quot;https://evil.invalid/font&quot;)"/></w:rPr><w:r><w:t>Safe text</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="999999999999" w:h="15840"/></w:sectPr>`)));
  const text = decode(output['word/document.xml']);
  assert.doesNotMatch(text, /__proto__|onclick|A'bad|evil\.invalid|999999999999/); assert.match(text, /w:h="15840"/); assert.match(text, /Safe text/);
});

test('relationship targets must resolve to an existing safe part of the correct type', () => {
  const result = prepare(archive('<w:drawing><a:blip r:embed="wrong"/><a:blip r:embed="outside"/><a:blip r:embed="encoded"/><a:blip r:embed="safe"/></w:drawing>', {
    'word/media/image1.png': png,
    'word/_rels/document.xml.rels': utf8(rels(relation('wrong','image','document.xml') + relation('outside','image','../../image1.png') + relation('encoded','image','media/%2e%2e/image1.png') + relation('safe','image','./media/image1.png'))),
  }));
  const text = decode(parts(result)['word/document.xml']);
  assert.doesNotMatch(text, /r:embed="(?:wrong|outside|encoded)"/); assert.match(text, /r:embed="safe"/);
});

test('prototype-named relationship types are rejected as unsupported without invoking inherited properties', () => {
  for (const type of [...Object.getOwnPropertyNames(Object.prototype), 'prototype']) {
    const output = parts(prepare(archive('<w:drawing><a:blip r:embed="hostile"/></w:drawing>', {
      'word/media/image.png': png,
      'word/_rels/document.xml.rels': utf8(rels(relation('hostile', type, 'media/image.png'))),
    })));
    assert.doesNotMatch(decode(output['word/document.xml']), /r:embed/);
    assert.doesNotMatch(decode(output['word/_rels/document.xml.rels']), /Id="hostile"/);
  }
});

test('XML entity and processing-instruction attacks are rejected in UTF-8 and both UTF-16 byte orders', () => {
  for (const value of [`<!DOCTYPE x [<!ENTITY exploit SYSTEM "file:///private">]>${xml(paragraph('&exploit;'))}`, `<?xml-stylesheet href="https://bad.invalid"?>${xml(paragraph('text'))}`]) {
    const little = new Uint8Array(Buffer.from('\ufeff' + value, 'utf16le')), big = little.slice();
    for (let index = 0; index < big.length; index += 2) [big[index], big[index + 1]] = [big[index + 1], big[index]];
    for (const bytes of [utf8(value), little, big]) assert.throws(() => prepare(zip.zipSync({ 'word/document.xml': bytes })), { code: 'RUBRIC_PREVIEW_CORRUPT' });
  }
});

test('the image memory budget is shared across all embedded raster files', () => {
  const raster = png.slice(); new DataView(raster.buffer).setUint32(16, 6000); new DataView(raster.buffer).setUint32(20, 4000);
  assert.throws(() => prepare(archive(undefined, { 'word/media/one.png': raster, 'word/media/two.png': raster, 'word/media/three.png': raster })), { code: 'RUBRIC_PREVIEW_LIMIT' });
});

test('400 deterministic malformed archive mutations either fail safely or rebuild a bounded inert package', t => {
  const seed = archive(paragraph('Safe rubric'), {
    'word/media/image.png': png,
    'word/_rels/document.xml.rels': utf8(rels(relation('image', 'image', 'media/image.png') + relation('remote', 'hyperlink', 'https://bad.invalid/tracker', 'External'))),
    'word/active.html': utf8('<script>alert(1)</script>'),
  });
  let rejected = 0, accepted = 0, random = 0x13e92a71;
  const next = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random; };
  for (let index = 0; index < 400; index++) {
    let input = seed.slice();
    if (index % 3 === 0) input = input.subarray(0, next() % input.length);
    else for (let flip = 0; flip < 1 + index % 5; flip++) input[next() % input.length] ^= 1 << (next() % 8);
    let result;
    try { result = prepare(input); }
    catch (error) { assert.equal(error.name, 'RubricDocumentError'); rejected++; continue; }
    accepted++; assert.ok(result.data.byteLength <= DOCX_PREVIEW_LIMITS.expandedBytes + 1024 * 1024);
    const output = parts(result);
    assert.equal(output['word/active.html'], undefined);
    for (const [name, value] of Object.entries(output)) {
      assert.doesNotMatch(name, /(?:^|\/)\.\.(?:\/|$)|\\|^\//);
      if (name.endsWith('.xml') || name.endsWith('.rels')) assert.doesNotMatch(decode(value), /bad\.invalid|<!DOCTYPE|<!ENTITY|<script/);
    }
  }
  assert.ok(rejected > 100); assert.ok(accepted > 0);
  t.diagnostic(`${rejected} malformed archives rejected; ${accepted} safely rebuilt; no active or remote content retained.`);
});

test('preview validates real input size and required reader support', () => {
  assert.throws(() => prepare(new Uint8Array(5 * 1024 * 1024 + 1)), { code: 'RUBRIC_PREVIEW_LIMIT' });
  assert.throws(() => prepareDocxPreview(archive(), { ...deps, DOMParserImpl: undefined }), { code: 'RUBRIC_PREVIEW_BROWSER' });
});
