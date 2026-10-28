import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fontRuns, loadPdfFonts } from '../lib/pdf-fonts.mjs';
import { PDF_FONT_COVERAGE } from '../lib/pdf-font-assets/coverage.mjs';

const require = createRequire(import.meta.url);

test('font runs retain every literal character and select local fallbacks', () => {
  const source = '  Hi, I’m Maya. 🚀\nCafe\u0301s & cafés need longer hours.\n\nLet’s practice.\t ★';
  const runs = fontRuns(source);
  assert.equal(runs.map(run => run.text).join(''), source);
  assert.equal(runs.find(run => run.text.includes('🚀')).font, 'RehearsalEmoji');
  assert.equal(runs.find(run => run.text.includes('★')).font, 'RehearsalSymbols');
  assert.equal(runs.find(run => run.text.includes('Cafe\u0301s')).font, 'Roboto');
  assert.deepEqual(fontRuns(''), []);
  assert.deepEqual(fontRuns('<script>alert("literal")</script>'), [{ text: '<script>alert("literal")</script>', font: 'Roboto' }]);
});

test('emoji graphemes remain together and unsupported scripts fail explicitly', () => {
  for (const text of ['🚀', '👩‍💻', '❤️', '👍🏽']) {
    assert.deepEqual(fontRuns(text), [{ text, font: 'RehearsalEmoji' }]);
  }
  for (const text of ['中文', '\uD800', '\u0000']) {
    assert.throws(() => fontRuns(text), error => error.code === 'PDF_UNSUPPORTED_CHARACTER' && /U\+[0-9A-F]+/.test(error.message));
  }
});

test('coverage tables match the actual installed faces and immutable asset hashes', async () => {
  const fontkit = createRequire(require.resolve('pdfmake'))('fontkit');
  const roboto = require('pdfmake/build/vfs_fonts.js');
  const { default: fallback } = await import('../lib/pdf-font-assets/vfs.mjs');
  const fonts = {
    Roboto: Object.values(roboto).map(bytes => fontkit.create(Buffer.from(bytes, 'base64'))),
    RehearsalSymbols: [fontkit.create(Buffer.from(fallback['RehearsalSymbols.ttf'], 'base64'))],
    RehearsalEmoji: [fontkit.create(Buffer.from(fallback['RehearsalEmoji.ttf'], 'base64'))],
    RehearsalArrows: [fontkit.create(Buffer.from(fallback['RehearsalArrows.ttf'], 'base64'))],
  };
  for (const [name, faces] of Object.entries(fonts)) {
    const declared = PDF_FONT_COVERAGE[name].flatMap(([first, last]) => Array.from({ length: last - first + 1 }, (_, index) => first + index));
    const actual = faces[0].characterSet.filter(codePoint => faces.every(face => face.hasGlyphForCodePoint(codePoint))).sort((a, b) => a - b);
    assert.deepEqual(declared, actual, `${name} coverage must never advertise missing glyphs`);
  }
  assert.equal(createHash('sha256').update(Buffer.from(fallback['RehearsalSymbols.ttf'], 'base64')).digest('hex'), 'ec0b67a7c3be6cb432dbadf6593223b5927fadfefce4881fa7420b245ca6b594');
  assert.equal(createHash('sha256').update(Buffer.from(fallback['RehearsalEmoji.ttf'], 'base64')).digest('hex'), '55e7f5e1c56768eed0c93b03527ef73606b6569c347b1e7a7e493ab3ce270596');
  assert.equal(createHash('sha256').update(Buffer.from(fallback['RehearsalArrows.ttf'], 'base64')).digest('hex'), 'cdc3d5c0cf90a9c44efc5caf586c7db6ae58007e844db75bab5bc345ddb68c9a');
});

test('concurrent exports install fonts once per PDF writer', async () => {
  const calls = [];
  const writer = { addVirtualFileSystem: value => calls.push(['vfs', Object.keys(value)]), addFonts: value => calls.push(['fonts', Object.keys(value)]) };
  await Promise.all([loadPdfFonts(writer), loadPdfFonts(writer), loadPdfFonts(writer)]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1].length, 7);
  assert.deepEqual(calls[1][1], ['Roboto', 'RehearsalSymbols', 'RehearsalEmoji', 'RehearsalArrows']);
});

test('a failed font installation can be retried without retaining failure state', async () => {
  let attempts = 0;
  const writer = { addVirtualFileSystem() {}, addFonts() { if (++attempts === 1) throw new Error('retryable'); } };
  await assert.rejects(loadPdfFonts(writer), /retryable/);
  await loadPdfFonts(writer);
  assert.equal(attempts, 2);
  await assert.rejects(loadPdfFonts({}), /PDF writer is unavailable/);
});

test('real embedded-font PDF includes accents, star, non-BMP rocket, arrows and inequalities', async () => {
  const pdfMake = require('pdfmake/build/pdfmake.js');
  await loadPdfFonts(pdfMake);
  const source = 'Hi, I’m Maya. 🚀\nCafe\u0301s & cafés need longer hours.\n\nLet’s practice. ★ → ← ↑ ↓ ↗ ≥ ≤';
  const bytes = await pdfMake.createPdf({ content: [{ text: fontRuns(source) }], defaultStyle: { font: 'Roboto' } }).getBuffer();
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, isEvalSupported: false });
  try {
    const doc = await loading.promise;
    const content = await (await doc.getPage(1)).getTextContent();
    const extracted = content.items.map(item => item.str).join('').normalize('NFC');
    for (const expected of ['I’m Maya.', '🚀', 'Cafés', 'cafés', '★', '→', '←', '↑', '↓', '↗', '≥', '≤']) assert.ok(extracted.includes(expected), expected);
    assert.equal(new Set(content.items.filter(item => item.str).map(item => item.fontName)).size, 4);
  } finally { await loading.destroy(); }
});
