// The code PICO-8 reads from a file: a cart's __lua__ sections, or the text of any other file less its lone CRs. It is
// kept as runs of the file's text, so that each place in the code has its place in the file. The text is the file's as
// an editor has it, without the BOM it may start with (fileText).

// The code from at on is the text from from on, up to the next run; a line break PICO-8 reads in place of a lone CR in a
// cart is at the CR.
export type Run = { at: number, from: number };

export type Code = {
  text: string,
  code: string,
  runs: Run[],
  cart: boolean,
  // The line that ends a cart's code by starting another section, as __gfx__ does: where it starts in the text, and the
  // length of the start that makes it one.
  end?: { index: number, length: number },
  // Set when a CR that ends a cart takes the line break before it, which ends the code.
  lostLineBreak?: boolean,
};

const SECTIONS = [ '__lua__', '__gfx__', '__gff__', '__label__', '__map__', '__sfx__', '__music__', '__meta:' ];

// PICO-8 takes a file as a cart, whatever its name, when its first line, from its first p on, starts with
// "pico-8 cartridge" (si.pin.kind.txt.text-before-header.0, si.pin.head.blank-first, si.pin.kind.p8.header-mid-line1.1).
// In any other file it drops each CR that no LF follows: "--<CR>x = = 1" is a comment, and "pri<CR>nth()" calls printh
// (si.t28.cr-dropped.*).
export function readCode(text: string): Code {
  let p = 0;
  while (p < text.length && text[p] !== 'p' && text[p] !== '\n' && text[p] !== '\r') {
    p++;
  }
  if (text.startsWith('pico-8 cartridge', p)) {
    return cartCode(text);
  }
  const runs: Run[] = [{ at: 0, from: 0 }];
  let code = '';
  let from = 0;
  for (let cr = text.indexOf('\r'); cr >= 0; cr = text.indexOf('\r', cr + 1)) {
    if (text.charCodeAt(cr + 1) !== 10) {
      code += text.slice(from, cr);
      from = cr + 1;
      runs.push({ at: code.length, from });
    }
  }
  return { text, code: from === 0 ? text : code + text.slice(from), runs, cart: false };
}

// A text read as code of its own, by none of the rules of a file.
export function textCode(text: string): Code {
  return { text, code: text, runs: [{ at: 0, from: 0 }], cart: false };
}

// Where a place in the text is in the code, the end of a run counting as in it, or undefined for a place the code
// leaves out, such as a cart's header and its other sections.
export function codeIndexOf(code: Code, index: number): number | undefined {
  const { runs } = code;
  if (runs[0].from > index) {
    return undefined;
  }
  let low = 0;
  let high = runs.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (runs[middle].from <= index) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const run = runs[low];
  const length = (low + 1 < runs.length ? runs[low + 1].at : code.code.length) - run.at;
  return index - run.from <= length ? run.at + index - run.from : undefined;
}

// A cart's lines as PICO-8 reads them: a lone CR is a line break that takes the character after it with it, and a CR
// that ends the file takes itself and the character before it (si.pin.cr.mid, si.line.cr-alone, si.pin.cr.eof). The
// first line is the header and the second the version, whatever it holds (si.pin.head.junk-line2,
// si.tab.cart.no-version.1). The code is the lines of every section that a line starting with __lua__ starts, up to a
// line that starts as another section does (si.pin.head.two-lua-tabs-2, si.t28.section.main.gfxx,
// si.t28.section.main.meta, si.t28.section.main.meta-no-colon).
function cartCode(text: string): Code {
  // The runs of the text that the code is made of, each with an LF after it when it ends at a lone CR.
  const pieces: { from: number, to: number, lf: boolean }[] = [];
  // Where the text of the last line of code ends, before its line break.
  let lastLineEnd = 0;
  let lastWasCode = false;
  let end: Code['end'];
  let lostLineBreak = false;
  let inCode = false;
  let codeStart = text.length;
  for (let i = 0, line = 0; i < text.length; line++) {
    let j = i;
    while (j < text.length && text.charCodeAt(j) !== 10 && text.charCodeAt(j) !== 13) {
      j++;
    }
    // The text of the line ends at to, and the code takes it up to taken: with its line break, or with an LF in place of
    // a lone CR (lf), and then the next line starts past the character after the CR.
    let to = j;
    let taken = j;
    let after = j;
    let lf = false;
    if (text.charCodeAt(j) === 10 || text.charCodeAt(j + 1) === 10) {
      taken = after = text.charCodeAt(j) === 10 ? j + 1 : j + 2;
    } else if (j + 1 < text.length) {
      lf = true;
      after = j + 2;
    } else if (j + 1 === text.length) {
      if (j === i) {
        const last = pieces[pieces.length - 1];
        if (lastWasCode && last) {
          last.to = lastLineEnd;
          last.lf = false;
          lostLineBreak = true;
        }
        break;
      }
      to = taken = j - 1;
      after = text.length;
    }
    lastWasCode = false;
    const section = line < 2 || text.charCodeAt(i) !== 95 || text.charCodeAt(i + 1) !== 95 ? undefined
      : SECTIONS.find(word => to - i >= word.length && text.startsWith(word, i));
    if (section === '__lua__') {
      inCode = true;
      end = undefined;
      if (pieces.length === 0) {
        codeStart = after;
      }
    } else if (section !== undefined) {
      if (inCode) {
        end = { index: i, length: section.length };
      }
      inCode = false;
    } else if (inCode) {
      const last = pieces[pieces.length - 1];
      if (last && !last.lf && last.to === i) {
        last.to = taken;
        last.lf = lf;
      } else {
        pieces.push({ from: i, to: taken, lf });
      }
      lastLineEnd = to;
      lastWasCode = true;
    }
    i = after;
  }
  // A long string or comment that the section stops ends with the line before it.
  if (end) {
    const last = pieces[pieces.length - 1];
    if (last) {
      last.to = lastLineEnd;
      last.lf = false;
    }
  }

  let code = '';
  const runs: Run[] = [];
  for (const { from, to, lf } of pieces) {
    runs.push({ at: code.length, from });
    code += text.slice(from, to) + (lf ? '\n' : '');
  }
  if (runs.length === 0) {
    runs.push({ at: 0, from: codeStart });
  }
  return { text, code, runs, cart: true, end, lostLineBreak };
}

// PICO-8 splits a cart's code, without its last line break, at each line -->8 between two line breaks, the first first,
// so that of two such lines in a row only the first is one (si.tab.spot.twice.2, si.tab.spot.last.1); it splits the text
// of any other file as if it ended in a line break (si.t28.tabs-of-lua.last-no-lf, si.t28.tabs-of-lua.two-at-end).
export function tabsOf(code: Code): Code[] {
  let body = code.code;
  if (code.cart) {
    body = body.replace(/\r?\n$/, '');
  }
  const tabs: Code[] = [];
  const separator = code.cart ? /\r?\n-->8\r?\n/g : /\r?\n-->8(?:\r?\n|$)/g;
  let from = 0;
  for (let found = separator.exec(body); found; found = separator.exec(body)) {
    tabs.push(slice(code, from, found.index));
    from = found.index + found[0].length;
  }
  tabs.push({ ...slice(code, from, body.length), end: code.end });
  return tabs;
}

// The characters that PICO-8 counts as one each in code, by the code point: the glyphs of P8SCII as it writes them in a
// file, and others it reads as one of its characters (5.chars.glyph-*). Some glyphs are written with a U+FE0F after the
// code point, and count as one with it.
const GLYPHS = new Set([ ...'¹²³⁴⁵⁶⁷⁸ᵇᶜᵉᶠ▮■□⁙⁘‖◀▶「」¥•、。゛゜○█▒🐱░✽●♥☉웃⌂😐♪◆\u2026★⧗ˇ∧❎▤▥◜◝'
  + 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんっゃゅょ'
  + 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンッャュョ' ].map(glyph => glyph.codePointAt(0)!)
  .concat(Array.from({ length: 26 }, (_, k) => 0x1d622 + k)));
const BEFORE_VARIATION_SELECTOR = new Set([ 0x2b05, 0x2b06, 0x2b07, 0x27a1, 0x1f17e ]);

// PICO-8's count of the characters of code: a line break is one, a CRLF too, a glyph one, and any other character that
// is not ASCII its bytes in UTF-8 (5.chars.*). Undefined when the code has a U+FFFD: the text has one for each byte of
// the file that is not UTF-8, which PICO-8 counts one, and for the character itself, which it counts 3.
export function characterCount(code: string): number | undefined {
  let count = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code.charCodeAt(i);
    if (c < 0x80) {
      count += c === 13 && code.charCodeAt(i + 1) === 10 ? 0 : 1;
      continue;
    }
    const point = code.codePointAt(i)!;
    if (point > 0xffff) {
      i++;
    }
    if (point === 0xfffd) {
      return undefined;
    }
    if (BEFORE_VARIATION_SELECTOR.has(point) && code.charCodeAt(i + 1) === 0xfe0f) {
      i++;
      count++;
    } else {
      count += GLYPHS.has(point) ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    }
  }
  return count;
}

// The code of the tabs one after the other, with nothing between them.
export function joined(tabs: Code[]): Code {
  let code = '';
  const runs: Run[] = [];
  for (const tab of tabs) {
    for (const run of tab.runs) {
      runs.push({ at: run.at + code.length, from: run.from });
    }
    code += tab.code;
  }
  const last = tabs[tabs.length - 1];
  return { text: last.text, code, runs, cart: last.cart, end: last.end };
}

function slice(code: Code, from: number, to: number): Code {
  let k = code.runs.length - 1;
  while (code.runs[k].at > from) {
    k--;
  }
  const runs = [{ at: 0, from: code.runs[k].from + from - code.runs[k].at }];
  for (k++; k < code.runs.length && code.runs[k].at < to; k++) {
    runs.push({ at: code.runs[k].at - from, from: code.runs[k].from });
  }
  return { text: code.text, code: code.code.slice(from, to), runs, cart: code.cart };
}
