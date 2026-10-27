import { RUBRIC_LIMITS, RubricDocumentError, decodeDocumentBytes } from './rubric-document.mjs';

// Only these rebuilt parts reach the visual renderer. In particular, the
// original package manifest, macros, embedded fonts, and arbitrary ZIP members
// are never handed to its ZIP reader.
export const DOCX_PREVIEW_LIMITS = Object.freeze({
  expandedBytes: 16 * 1024 * 1024, xmlBytes: 4 * 1024 * 1024,
  mediaBytes: 12 * 1024 * 1024, imagePixels: 24_000_000,
  totalImagePixels: 48_000_000, imageDimension: 12_000,
  nodes: 100_000, depth: 128, attributes: 128,
});
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const WS = 'http://purl.oclc.org/ooxml/wordprocessingml/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const RS = 'http://purl.oclc.org/ooxml/officeDocument/relationships';
const PACKAGE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const prototypeNames = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);
const namespaces = new Set([W, WS, R, RS, PACKAGE, CONTENT,
  'http://schemas.openxmlformats.org/drawingml/2006/main',
  'http://purl.oclc.org/ooxml/drawingml/main',
  'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  'http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing',
  'http://schemas.openxmlformats.org/drawingml/2006/picture',
  'http://purl.oclc.org/ooxml/drawingml/picture',
  MC,
]);
const xmlPart = /^word\/(?:document|styles|numbering|settings|fontTable|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$|^word\/theme\/theme\d+\.xml$/;
const relPart = /^word\/_rels\/(?:document|styles|numbering|settings|fontTable|header\d+|footer\d+|footnotes|endnotes|comments)\.xml\.rels$|^word\/theme\/_rels\/theme\d+\.xml\.rels$/;
const imagePart = /^word\/media\/[a-zA-Z0-9_. -]+\.(?:png|jpe?g)$/i;
const utf8 = value => new TextEncoder().encode(value);
const problem = (code, message) => new RubricDocumentError(code, `${message} The rubric text can still be used without a visual preview.`);
const corrupt = () => problem('RUBRIC_PREVIEW_CORRUPT', 'This Word file could not be safely previewed.');
const limit = () => problem('RUBRIC_PREVIEW_LIMIT', 'This Word file is too large or complex to preview.');
const children = node => Array.from(node.childNodes || []).filter(child => child.nodeType === 1);
const word = node => node.namespaceURI === W || node.namespaceURI === WS;
const warnings = Object.freeze({
  external: 'External links and linked content are disabled in this preview.',
  unsupported: 'Advanced Word features, such as charts, SmartArt, equations, or legacy drawings, may use a fallback image or be omitted from this preview. The original file is unchanged.',
  images: 'Only embedded PNG and JPEG images are shown; other image formats are omitted from this preview.',
  active: 'Embedded objects, active content, and embedded fonts are omitted from this preview.',
});

function collectParts(bytes, zip, warn) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > RUBRIC_LIMITS.fileBytes) throw limit();
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 3 || bytes[3] !== 4) throw corrupt();
  let count = 0, expanded = 0, xmlBytes = 0, mediaBytes = 0, failure;
  const seen = new Set(), parts = new Map(), streams = [];
  const fail = error => { failure ||= error; };
  try {
    const archive = new zip.Unzip(entry => {
      if (++count > RUBRIC_LIMITS.zipEntries) throw limit();
      const name = entry.name;
      if (typeof name !== 'string' || name.length > 255 || /[\\\u0000-\u001f\u007f]/.test(name) || name.startsWith('/') || name.split('/').some(part => part === '..' || part === '.')) throw corrupt();
      if (seen.has(name.toLowerCase())) throw corrupt();
      seen.add(name.toLowerCase());
      const isXml = xmlPart.test(name) || relPart.test(name), isImage = imagePart.test(name);
      if (!isXml && !isImage) {
        if (/\.(?:svg|emf|wmf|gif|bmp|tiff?|webp)$/i.test(name)) warn('images');
        if (/^word\/(?:charts|diagrams)\//.test(name)) warn('unsupported');
        if (/(?:^|\/)(?:embeddings|fonts|activeX)\/|vbaProject|altChunk/i.test(name)) warn('active');
        return;
      }
      if (![0, 8].includes(entry.compression)) throw corrupt();
      if (entry.originalSize !== undefined && (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0 || entry.originalSize > (isXml ? DOCX_PREVIEW_LIMITS.xmlBytes : DOCX_PREVIEW_LIMITS.mediaBytes))) throw limit();
      const part = { name, chunks: [], size: 0, complete: false };
      parts.set(name, part); streams.push(entry);
      entry.ondata = (error, chunk, final) => {
        if (failure) return;
        if (error || !(chunk instanceof Uint8Array)) { fail(corrupt()); return; }
        part.size += chunk.length; expanded += chunk.length;
        if (isXml) xmlBytes += chunk.length; else mediaBytes += chunk.length;
        if (expanded > DOCX_PREVIEW_LIMITS.expandedBytes || xmlBytes > DOCX_PREVIEW_LIMITS.xmlBytes || mediaBytes > DOCX_PREVIEW_LIMITS.mediaBytes) { fail(limit()); return; }
        part.chunks.push(chunk);
        if (final) {
          part.complete = true;
          if (entry.originalSize !== undefined && part.size !== entry.originalSize) fail(corrupt());
        }
      };
      entry.start();
    });
    archive.register(zip.UnzipInflate);
    // Small input pushes bound each inflater allocation even when a malicious
    // member lies about its uncompressed size.
    for (let offset = 0; offset < bytes.length; offset += 1024) {
      archive.push(bytes.subarray(offset, offset + 1024), offset + 1024 >= bytes.length);
      if (failure) throw failure;
    }
    if (!parts.has('word/document.xml') || [...parts.values()].some(part => !part.complete)) throw corrupt();
    return new Map([...parts.values()].map(part => {
      const data = new Uint8Array(part.size); let offset = 0;
      for (const chunk of part.chunks) { data.set(chunk, offset); offset += chunk.length; }
      return [part.name, data];
    }));
  } catch (error) { throw error instanceof RubricDocumentError ? error : corrupt(); }
  finally { for (const stream of streams) { try { stream.terminate(); } catch {} } }
}

function imagePixels(name, data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let width, height;
  if (/\.png$/i.test(name)) {
    if (data.length < 33 || ![137,80,78,71,13,10,26,10].every((n, i) => data[i] === n) || view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) throw corrupt();
    width = view.getUint32(16); height = view.getUint32(20);
    // Animated PNGs can multiply decoded memory despite a modest canvas size.
    for (let offset = 8; offset + 12 <= data.length;) {
      const length = view.getUint32(offset), type = view.getUint32(offset + 4);
      if (length > data.length - offset - 12) throw corrupt();
      if (type === 0x6163544c) throw problem('RUBRIC_PREVIEW_IMAGE', 'Animated images are not supported in the Word preview.');
      offset += length + 12;
      if (type === 0x49454e44) break;
    }
  } else {
    if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) throw corrupt();
    let offset = 2;
    while (offset < data.length) {
      if (data[offset++] !== 0xff) throw corrupt();
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > data.length) throw corrupt();
      const length = view.getUint16(offset);
      if (length < 2 || length > data.length - offset) throw corrupt();
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8 || data[offset + 2] !== 8) throw corrupt();
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5); break;
      }
      offset += length;
    }
  }
  if (!width || !height || width > DOCX_PREVIEW_LIMITS.imageDimension || height > DOCX_PREVIEW_LIMITS.imageDimension || width * height > DOCX_PREVIEW_LIMITS.imagePixels) throw limit();
  return width * height;
}

function parseXml(data, DOMParserImpl, budget) {
  const xml = decodeDocumentBytes(data);
  if (/<\s*!(?:DOCTYPE|ENTITY)\b/i.test(xml) || /<\?(?!xml(?:\s|\?>))/i.test(xml)) throw corrupt();
  let document;
  try { document = new DOMParserImpl().parseFromString(xml, 'application/xml'); } catch { throw corrupt(); }
  if (!document?.documentElement || document.doctype || document.getElementsByTagName('parsererror').length) throw corrupt();
  const stack = [[document.documentElement, 0]];
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (++budget.nodes > DOCX_PREVIEW_LIMITS.nodes || depth > DOCX_PREVIEW_LIMITS.depth || (node.attributes?.length || 0) > DOCX_PREVIEW_LIMITS.attributes) throw limit();
    for (const child of Array.from(node.childNodes || [])) {
      if (child.nodeType === 7 || child.nodeType === 10 || child.nodeType === 5) throw corrupt();
      if (child.nodeType === 1) stack.push([child, depth + 1]);
      else if (++budget.nodes > DOCX_PREVIEW_LIMITS.nodes) throw limit();
    }
  }
  return document;
}

function sourceForRels(name) { return name.replace(/(^|\/)\_rels\//, '$1').replace(/\.rels$/, ''); }
function resolveTarget(source, target) {
  if (!target || /[\\\u0000-\u0020\u007f:?#%]/.test(target)) return null;
  const path = target.startsWith('/') ? [] : source.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!path.length) return null; path.pop(); }
    else path.push(part);
  }
  return path.join('/');
}
const relationTargets = {
  styles: /^word\/styles\.xml$/, numbering: /^word\/numbering\.xml$/, settings: /^word\/settings\.xml$/,
  fontTable: /^word\/fontTable\.xml$/, theme: /^word\/theme\/theme\d+\.xml$/,
  header: /^word\/header\d+\.xml$/, footer: /^word\/footer\d+\.xml$/,
  footnotes: /^word\/footnotes\.xml$/, endnotes: /^word\/endnotes\.xml$/, comments: /^word\/comments\.xml$/,
  image: imagePart,
};
function sanitizeRelationships(name, document, parts, warn) {
  const root = document.documentElement;
  if (root.namespaceURI !== PACKAGE || root.localName !== 'Relationships') throw corrupt();
  const ids = new Set(), kept = new Set();
  for (const node of children(root)) {
    const id = node.getAttribute('Id'), type = node.getAttribute('Type'), target = node.getAttribute('Target');
    if (!id || ids.has(id)) throw corrupt();
    ids.add(id);
    const kind = type?.startsWith(`${R}/`) ? type.slice(R.length + 1) : type?.startsWith(`${RS}/`) ? type.slice(RS.length + 1) : '';
    const resolved = resolveTarget(sourceForRels(name), target);
    const mode = node.getAttribute('TargetMode');
    if (node.namespaceURI !== PACKAGE || node.localName !== 'Relationship' || mode && mode !== 'Internal' || !relationTargets[kind]?.test(resolved || '') || !parts.has(resolved)) {
      if (mode?.toLowerCase() === 'external' || /^(?:[a-z]+:|\/\/)/i.test(target || '') || kind === 'hyperlink') warn('external');
      else if (['chart', 'diagramData', 'diagramDrawing', 'diagramLayout', 'diagramColors', 'diagramQuickStyle'].includes(kind)) warn('unsupported');
      else if (['oleObject', 'package', 'aFChunk', 'font', 'attachedTemplate'].includes(kind)) warn('active');
      node.parentNode.removeChild(node); continue;
    }
    // Rebuild relationship attributes rather than forwarding extra XML fields.
    for (const attribute of Array.from(node.attributes || [])) node.removeAttributeNode(attribute);
    node.setAttribute('Id', id); node.setAttribute('Type', `${R}/${kind}`);
    node.setAttribute('Target', `/${resolved}`); kept.add(id);
  }
  return kept;
}
function unwrap(node) { const parent = node.parentNode; while (node.firstChild) parent.insertBefore(node.firstChild, node); parent.removeChild(node); }
function supportedAlternative(node) {
  const stack = [node];
  while (stack.length) {
    const item = stack.pop();
    if (!namespaces.has(item.namespaceURI)) return false;
    stack.push(...children(item));
  }
  return true;
}
function sanitizeDocument(name, document, validIds, warn) {
  const visibleContent = /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/.test(name);
  const stack = [document.documentElement];
  while (stack.length) {
    const node = stack.pop(), tag = node.localName;
    if (node.namespaceURI === MC && tag === 'AlternateContent') {
      const alternatives = children(node), choice = alternatives.find(item => item.localName === 'Choice' && supportedAlternative(item));
      const selected = choice || alternatives.find(item => item.localName === 'Fallback' && supportedAlternative(item)) || alternatives.find(item => item.localName === 'Fallback') || alternatives[0];
      if (!choice && visibleContent) warn('unsupported');
      if (selected) {
        const descendants = children(selected);
        while (selected.firstChild) node.parentNode.insertBefore(selected.firstChild, node);
        stack.push(...descendants);
      }
      node.parentNode.removeChild(node); continue;
    }
    if (!namespaces.has(node.namespaceURI) || word(node) && ['altChunk','object','control','subDoc','attachedTemplate','embedRegular','embedBold','embedItalic','embedBoldItalic','instrText','fldChar'].includes(tag)) {
      if (['altChunk','object','control','subDoc','attachedTemplate','embedRegular','embedBold','embedItalic','embedBoldItalic'].includes(tag)) warn('active');
      else if (!namespaces.has(node.namespaceURI) && visibleContent) warn('unsupported');
      if (node === document.documentElement) throw corrupt();
      node.parentNode.removeChild(node); continue;
    }
    const descendants = children(node);
    if (word(node) && ['hyperlink', 'fldSimple'].includes(tag)) {
      if (tag === 'hyperlink') warn('external');
      unwrap(node); stack.push(...descendants); continue;
    }
    for (const attribute of Array.from(node.attributes || [])) {
      if (attribute.namespaceURI === 'http://www.w3.org/2000/xmlns/') continue;
      const value = attribute.value;
      if ([R, RS].includes(attribute.namespaceURI)) {
        if (!validIds.has(value)) node.removeAttributeNode(attribute);
        continue;
      }
      if (attribute.namespaceURI && !namespaces.has(attribute.namespaceURI) && attribute.namespaceURI !== 'http://www.w3.org/XML/1998/namespace' ||
          value.length > 2048 || prototypeNames.has(value) || /[\u0000-\u001f\u007f{}<>;\\]|url\s*\(|@import|expression\s*\(/i.test(value) || !namespaces.has(value) && /(?:javascript|vbscript|data|https?|file):/i.test(value) || /^on/i.test(attribute.localName)) {
        node.removeAttributeNode(attribute); continue;
      }
      // Font family names become CSS; permit ordinary names but no CSS syntax.
      if (['rFonts', 'font', 'latin', 'ea', 'cs'].includes(tag) && /['"()\[\]]/.test(value)) node.removeAttributeNode(attribute);
      if (word(node) && tag === 'pgSz' && ['w','h'].includes(attribute.localName) && (!/^\d+$/.test(value) || Number(value) > 57600 || Number(value) < 1)) node.removeAttributeNode(attribute);
    }
    stack.push(...descendants);
  }
}

function contentType(name) {
  if (/^word\/theme\//.test(name)) return 'application/vnd.openxmlformats-officedocument.theme+xml';
  let kind = name.split('/').at(-1).slice(0, -4);
  if (kind === 'document') kind = 'document.main';
  else if (/^header\d+$/.test(kind)) kind = 'header';
  else if (/^footer\d+$/.test(kind)) kind = 'footer';
  return `application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml`;
}

/** Rebuild a local DOCX containing only bounded, inert preview resources. */
export function prepareDocxPreview(bytes, { Unzip, UnzipInflate, zipSync, DOMParserImpl = globalThis.DOMParser, XMLSerializerImpl = globalThis.XMLSerializer } = {}) {
  if ([Unzip, UnzipInflate, zipSync, DOMParserImpl, XMLSerializerImpl].some(value => typeof value !== 'function')) throw problem('RUBRIC_PREVIEW_BROWSER', 'Word preview needs a current browser.');
  const notices = new Set(), warn = kind => notices.add(warnings[kind]);
  const parts = collectParts(bytes, { Unzip, UnzipInflate }, warn);
  const documents = new Map(), budget = { nodes: 0 }; let pixels = 0;
  for (const [name, data] of parts) {
    if (imagePart.test(name)) { pixels += imagePixels(name, data); if (pixels > DOCX_PREVIEW_LIMITS.totalImagePixels) throw limit(); }
    else documents.set(name, parseXml(data, DOMParserImpl, budget));
  }
  const body = documents.get('word/document.xml')?.documentElement;
  if (!word(body || {}) || body.localName !== 'document') throw corrupt();
  const relationships = new Map();
  for (const [name, document] of documents) if (relPart.test(name)) relationships.set(sourceForRels(name), sanitizeRelationships(name, document, parts, warn));
  const serializer = new XMLSerializerImpl(), output = Object.create(null);
  for (const [name, data] of parts) {
    const document = documents.get(name);
    if (document) {
      if (!relPart.test(name)) sanitizeDocument(name, document, relationships.get(name) || new Set(), warn);
      output[name] = utf8(serializer.serializeToString(document));
    } else output[name] = data;
  }
  output['_rels/.rels'] = utf8(`<Relationships xmlns="${PACKAGE}"><Relationship Id="document" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`);
  output['[Content_Types].xml'] = utf8(`<Types xmlns="${CONTENT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="jpeg" ContentType="image/jpeg"/>${[...documents.keys()].filter(name => xmlPart.test(name)).map(name => `<Override PartName="/${name}" ContentType="${contentType(name)}"/>`).join('')}</Types>`);
  const archive = zipSync(output, { level: 0 });
  if (archive.byteLength > DOCX_PREVIEW_LIMITS.expandedBytes + 1024 * 1024) throw limit();
  return { data: archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength), warnings: [...notices] };
}
