// The text PICO-8 writes for each byte of a string, as printh writes it and as a .p8 file holds it, and reads back as
// that byte (4.str.chr, 4.str.glyphs-*). Byte 0, which printh cannot write, is the character 0.
export const P8SCII_TEXT: readonly string[] = [
  '\0', '\u00b9', '\u00b2', '\u00b3', '\u2074', '\u2075', '\u2076', '\u2077',
  '\u2078', '\t', '\n', '\u1d47', '\u1d9c', '\r', '\u1d49', '\u1da0',
  '\u25ae', '\u25a0', '\u25a1', '\u2059', '\u2058', '\u2016', '\u25c0', '\u25b6',
  '\u300c', '\u300d', '\u00a5', '\u2022', '\u3001', '\u3002', '\u309b', '\u309c',
  ' ', '!', '"', '#', '$', '%', '&', '\'',
  '(', ')', '*', '+', ',', '-', '.', '/',
  '0', '1', '2', '3', '4', '5', '6', '7',
  '8', '9', ':', ';', '<', '=', '>', '?',
  '@', 'A', 'B', 'C', 'D', 'E', 'F', 'G',
  'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O',
  'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W',
  'X', 'Y', 'Z', '[', '\\', ']', '^', '_',
  '`', 'a', 'b', 'c', 'd', 'e', 'f', 'g',
  'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o',
  'p', 'q', 'r', 's', 't', 'u', 'v', 'w',
  'x', 'y', 'z', '{', '|', '}', '~', '\u25cb',
  '\u2588', '\u2592', '\u{1f431}', '\u2b07\ufe0f', '\u2591', '\u273d', '\u25cf', '\u2665',
  '\u2609', '\uc6c3', '\u2302', '\u2b05\ufe0f', '\u{1f610}', '\u266a', '\u{1f17e}\ufe0f', '\u25c6',
  '\u2026', '\u27a1\ufe0f', '\u2605', '\u29d7', '\u2b06\ufe0f', '\u02c7', '\u2227', '\u274e',
  '\u25a4', '\u25a5', '\u3042', '\u3044', '\u3046', '\u3048', '\u304a', '\u304b',
  '\u304d', '\u304f', '\u3051', '\u3053', '\u3055', '\u3057', '\u3059', '\u305b',
  '\u305d', '\u305f', '\u3061', '\u3064', '\u3066', '\u3068', '\u306a', '\u306b',
  '\u306c', '\u306d', '\u306e', '\u306f', '\u3072', '\u3075', '\u3078', '\u307b',
  '\u307e', '\u307f', '\u3080', '\u3081', '\u3082', '\u3084', '\u3086', '\u3088',
  '\u3089', '\u308a', '\u308b', '\u308c', '\u308d', '\u308f', '\u3092', '\u3093',
  '\u3063', '\u3083', '\u3085', '\u3087', '\u30a2', '\u30a4', '\u30a6', '\u30a8',
  '\u30aa', '\u30ab', '\u30ad', '\u30af', '\u30b1', '\u30b3', '\u30b5', '\u30b7',
  '\u30b9', '\u30bb', '\u30bd', '\u30bf', '\u30c1', '\u30c4', '\u30c6', '\u30c8',
  '\u30ca', '\u30cb', '\u30cc', '\u30cd', '\u30ce', '\u30cf', '\u30d2', '\u30d5',
  '\u30d8', '\u30db', '\u30de', '\u30df', '\u30e0', '\u30e1', '\u30e2', '\u30e4',
  '\u30e6', '\u30e8', '\u30e9', '\u30ea', '\u30eb', '\u30ec', '\u30ed', '\u30ef',
  '\u30f2', '\u30f3', '\u30c3', '\u30e3', '\u30e5', '\u30e7', '\u25dc', '\u25dd',
];

// The texts that PICO-8 reads as one byte that is not ASCII, by the code unit each starts with, the longest first:
// those it writes for the bytes, and the letters U+1D622 to U+1D63B, which it reads as the bytes 65 to 90, A to Z
// (4.puny.string).
const GLYPHS = new Map<number, { text: string, byte: number }[]>();
const readAs = (text: string, byte: number) => {
  const first = text.charCodeAt(0);
  GLYPHS.set(first, [ ...GLYPHS.get(first) ?? [], { text, byte }].sort((a, b) => b.text.length - a.text.length));
};
P8SCII_TEXT.forEach((text, byte) => {
  if (text.charCodeAt(0) >= 0x80) {
    readAs(text, byte);
  }
});
for (let k = 0; k < 26; k++) {
  readAs(String.fromCodePoint(0x1d622 + k), 65 + k);
}

// PICO-8 reads the code as bytes: a text of GLYPHS as its byte, and any other character as its UTF-8 bytes, as an
// e-acute is 195 169 (4.str.glyphs-*, 4.str.others). The bytes for the code at index, and the length they take.
export function bytesAt(code: string, index: number): { bytes: number[], length: number } {
  const unit = code.charCodeAt(index);
  if (unit < 0x80) {
    return { bytes: [ unit ], length: 1 };
  }
  const glyph = GLYPHS.get(unit)?.find(({ text }) => code.startsWith(text, index));
  if (glyph) {
    return { bytes: [ glyph.byte ], length: glyph.text.length };
  }
  const character = String.fromCodePoint(code.codePointAt(index)!);
  return { bytes: [ ...Buffer.from(character, 'utf8') ], length: character.length };
}

// The code as the text of the bytes PICO-8 holds for it.
export function pico8Text(code: string): string {
  // Found with a loop, which is faster than a regular expression on the short texts of names (ByName).
  let same = 0;
  while (same < code.length && isOwnText(code.charCodeAt(same))) {
    same++;
  }
  if (same === code.length) {
    return code;
  }
  let text = code.slice(0, same);
  for (let i = same; i < code.length;) {
    const { bytes, length } = bytesAt(code, i);
    text += bytes.map(byte => P8SCII_TEXT[byte]).join('');
    i += length;
  }
  return text;
}

// Whether the character is the text of its own byte, as ASCII is but for 127 and the controls P8SCII has glyphs for.
function isOwnText(c: number): boolean {
  return c >= 32 ? c < 127 : c === 0 || c === 9 || c === 10 || c === 13;
}

// A map by name, as PICO-8 tells names, and the keys of a table, apart: by the bytes it holds for them, so that
// U+1D622 is the name A, and t.é is t["é"] (4.puny.name, 4.name.e-acute-key).
export class ByName<T> {
  private readonly map = new Map<string, T>();

  get(name: string): T | undefined {
    return this.map.get(pico8Text(name));
  }

  set(name: string, value: T): void {
    this.map.set(pico8Text(name), value);
  }

  has(name: string): boolean {
    return this.map.has(pico8Text(name));
  }

  values(): IterableIterator<T> {
    return this.map.values();
  }

  get size(): number {
    return this.map.size;
  }
}

// The text of the first byte PICO-8 holds for the code at index, which a message quotes alone after a \.
export function firstByteText(code: string, index: number): string {
  return P8SCII_TEXT[bytesAt(code, index).bytes[0]];
}
