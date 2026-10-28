import { PDF_FONT_COVERAGE } from './pdf-font-assets/coverage.mjs';

const installed = new WeakMap();
const fontOrder = ['Roboto', 'RehearsalArrows', 'RehearsalSymbols', 'RehearsalEmoji'];
const graphemes = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;

function hasCharacter(font, codePoint) {
  // PDF layout handles these source whitespace characters, not font glyphs.
  if (codePoint === 9 || codePoint === 10 || codePoint === 13) return true;
  // A font's empty control glyph is not usable visible character coverage.
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint <= 0x9f) || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return false;
  const ranges = PDF_FONT_COVERAGE[font];
  let low = 0, high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1, [first, last] = ranges[middle];
    if (codePoint < first) high = middle - 1;
    else if (codePoint > last) low = middle + 1;
    else return true;
  }
  return false;
}

/** Literal text runs; unsupported characters fail explicitly instead of exporting tofu. */
export function fontRuns(text) {
  const source = String(text ?? ''), output = [];
  const pieces = graphemes ? graphemes.segment(source) : Array.from(source, segment => ({ segment }));
  for (const { segment } of pieces) {
    const codePoints = Array.from(segment, character => character.codePointAt(0));
    const font = fontOrder.find(name => codePoints.every(codePoint => hasCharacter(name, codePoint)));
    if (!font) {
      const codePoint = codePoints.find(value => !fontOrder.some(name => hasCharacter(name, value))) ?? codePoints[0];
      const code = `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
      throw Object.assign(new Error(`This PDF cannot display the character or character sequence containing ${code}. Your transcript has not been changed.`), {
        code: 'PDF_UNSUPPORTED_CHARACTER', codePoint,
      });
    }
    const previous = output.at(-1);
    if (previous?.font === font) previous.text += segment;
    else output.push({ text: segment, font });
  }
  return output;
}

/** Font bytes are loaded only when an export is requested; no remote font URLs. */
export async function loadPdfFonts(pdfMake) {
  if (!pdfMake || typeof pdfMake.addVirtualFileSystem !== 'function' || typeof pdfMake.addFonts !== 'function') {
    throw new TypeError('The PDF writer is unavailable. Please retry the download.');
  }
  if (!installed.has(pdfMake)) {
    const loading = (async () => {
      const [robotoModule, fallbackModule] = await Promise.all([
        import('pdfmake/build/vfs_fonts.js'), import('./pdf-font-assets/vfs.mjs'),
      ]);
      pdfMake.addVirtualFileSystem({ ...(robotoModule.default || robotoModule), ...fallbackModule.default });
      const fallback = name => ({ normal: name, bold: name, italics: name, bolditalics: name });
      pdfMake.addFonts({
        Roboto: {
          normal: 'Roboto-Regular.ttf', bold: 'Roboto-Medium.ttf',
          italics: 'Roboto-Italic.ttf', bolditalics: 'Roboto-MediumItalic.ttf',
        },
        RehearsalSymbols: fallback('RehearsalSymbols.ttf'),
        RehearsalEmoji: fallback('RehearsalEmoji.ttf'),
        RehearsalArrows: fallback('RehearsalArrows.ttf'),
      });
    })();
    installed.set(pdfMake, loading);
    loading.catch(() => { if (installed.get(pdfMake) === loading) installed.delete(pdfMake); });
  }
  await installed.get(pdfMake);
}
