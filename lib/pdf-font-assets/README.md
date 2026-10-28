# Local PDF fonts

`vfs.mjs` contains base64 TrueType font data and the full SIL Open Font License notices. The PDF helper imports these bytes only when the user downloads a PDF. It never fetches a font from a third-party host at runtime.

Roboto Regular, Medium, Italic and Medium Italic come from the pinned `pdfmake@0.3.13` package's `build/vfs_fonts.js`. `coverage.mjs` contains the intersection of the character maps of those four faces, plus the maps of the three fallback fonts below. If the fonts or pdfmake version change, regenerate the coverage table from the actual font files; do not assume that an entire Unicode block is covered.

The fallback fonts derive from these official Noto sources, downloaded on 2026-10-28:

- Noto Sans Symbols 2: https://notofonts.github.io/symbols/fonts/NotoSansSymbols2/full/ttf/NotoSansSymbols2-Regular.ttf
  - Source SHA-256: `dac469477e407e5499c05b4530b729c9dc38c5e4c982af732bc4b3a0f6ef9f97`.
  - Project and license: https://github.com/notofonts/symbols and https://github.com/notofonts/symbols/blob/main/OFL.txt.
- Noto Emoji: https://raw.githubusercontent.com/google/fonts/main/ofl/notoemoji/NotoEmoji%5Bwght%5D.ttf
  - Source SHA-256: `de6c18832938afc99caf132b39d6a30a19bac7f2e812e28db2535b4608d27551`.
  - Project and license: https://github.com/google/fonts/tree/main/ofl/notoemoji and https://github.com/google/fonts/blob/main/ofl/notoemoji/OFL.txt.
- Noto Sans Symbols: https://notofonts.github.io/symbols/fonts/NotoSansSymbols/full/ttf/NotoSansSymbols-Regular.ttf
  - Source SHA-256: `a0faf9edcc79d99d4c7ec8336da86464c7146ab2bbc481581da2500215366ff1`.
  - Shares the Noto Symbols project and the license in `OFL-NotoSansSymbols2.txt`.

All fallback fonts use SIL OFL 1.1; unmodified license notices are retained beside this file and in the bundled font-data module. The derived font families are renamed **Rehearsal Symbols**, **Rehearsal Emoji**, and **Rehearsal Arrows**. They do not represent endorsement by the Noto authors.

FontTools 4.68.0 produced the static derived fonts:

1. Instantiate Noto Emoji at weight 400 with `fontTools.varLib.instancer.instantiateVariableFont`.
2. Subset Noto Symbols 2 to mapped characters in U+2190–U+2BFF, Noto Symbols to mapped characters in U+2190–U+21FF, and Noto Emoji to its original mapped characters. Preserve layout closure, name records, and the missing-glyph outline (`name_IDs=['*']`, `name_legacy=True`, `name_languages=['*']`, `notdef_outline=True`).
3. Rename family/full/PostScript/typographic family names to the corresponding Rehearsal family, with typographic subfamily Regular. Preserve copyright and license name records.
4. Serialize the derived bytes into `vfs.mjs`, preserving full license notices. Generate sorted character-map ranges using fontkit 2.0.4, filtering out glyph zero.

Derived font verification:

| Font | Bytes | SHA-256 |
| --- | ---: | --- |
| RehearsalSymbols.ttf | 136,880 | `ec0b67a7c3be6cb432dbadf6593223b5927fadfefce4881fa7420b245ca6b594` |
| RehearsalEmoji.ttf | 862,980 | `55e7f5e1c56768eed0c93b03527ef73606b6569c347b1e7a7e493ab3ce270596` |
| RehearsalArrows.ttf | 6,824 | `cdc3d5c0cf90a9c44efc5caf586c7db6ae58007e844db75bab5bc345ddb68c9a` |

These are monochrome PDF fonts, not color emoji. Roboto covers Latin, Greek and Cyrillic characters in its actual character map, including curly quotation marks, accented Latin letters, combining acute marks, and ≥/≤. The fallbacks cover the annotation star, rocket emoji and common arrows →/←/↑/↓/↗, plus their included symbol/emoji maps. This is intentionally not universal script coverage. Unsupported characters or mixed-font grapheme sequences produce `PDF_UNSUPPORTED_CHARACTER` instead of a blank or substituted glyph. The helper preserves the original text and never transliterates it. PDF text extraction may normalize equivalent composed/decomposed characters during font shaping.

Run the maintained regression checks with `node --test tests/pdf-fonts.test.mjs`; they are also included in `pnpm test`.
