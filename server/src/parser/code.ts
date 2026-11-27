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
  return { text, code, runs, cart: true, end };
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
