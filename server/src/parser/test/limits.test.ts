import * as assert from 'assert';
import { formatError, parse, TestFilesResolver } from './test-utils';

const HEAD = 'pico-8 cartridge // http://www.pico-8.com\nversion 42\n__lua__\n';
const cartErrors = (code: string, files: Record<string, string> = {}) =>
  parse(HEAD + code, { filename: 'main.p8', includeFileResolver: new TestFilesResolver(files) }).errors.map(formatError);

// x={1,...,8200} and printh("ok") are 8,206 tokens.
const over = (line: string) => `x={${Array.from({ length: 8200 }, (_, k) => k + 1).join(',')}}\n${line}\nprinth("ok")`;
const numbers = (n: number) => `x={${Array.from({ length: n }, (_, k) => k + 1).join(',')}}\nprinth("ok")`;
// #include a.lua (a 65519-character comment), --x and printh("ok") are 65538 characters to PICO-8 with #include files.
const charsWith = (line: string, files: Record<string, string>) =>
  cartErrors(`#include a.lua\n--x\n${line}printh("ok")\n`, { 'a.lua': `--${'a'.repeat(65516)}\n`, ...files });

describe('PICO-8 limits of a cart', () => {
  // The totals PICO-8 0.2.7 prints for each line after x={1,...,8200}.
  const TOKENS: [string, number][] = [
    [ '', 8206 ], [ 'a=1', 8209 ], [ 'a=-1', 8209 ], [ 'a=- 1', 8210 ], [ 'a=b-1', 8211 ], [ 'f(-1)', 8209 ], [ 'a=- -1', 8210 ], [ 'a=~1', 8209 ],
    [ 'a=b..-1', 8212 ], [ 'a={1;-1}', 8212 ], [ 'a=b.c', 8210 ], [ 'b:c()', 8209 ], [ 'f(1,2)', 8210 ], [ 'a=t[1]', 8211 ], [ 'a={b=1,[2]=3}', 8216 ],
    [ 'function f(...) a=... end', 8213 ], [ 'if a then elseif b then else end', 8213 ], [ 'for k,v in pairs(t) do end', 8214 ], [ 'repeat until a', 8209 ],
    [ 'local a,b', 8208 ], [ 'a=1;', 8209 ], [ '-- comment', 8206 ], [ '?"a",1', 8209 ], [ 'a+=1', 8209 ], [ 'goto l\n::l::', 8209 ], [ 'if (a) b=1', 8212 ],
    [ 'do end', 8207 ], [ 'a=⬅️', 8209 ], [ 'a="\\z\n  x"', 8211 ], [ 'x=#include y=1', 8208 ], [ 's="#include x" y=1', 8212 ], [ 'a=1 `', 8210 ],
  ];
  for (const [ line, total ] of TOKENS) {
    it(`counts the tokens of ${JSON.stringify(line)} as PICO-8 does`, () => {
      assert.match(cartErrors(over(line))[0], new RegExp(`program too large: ${total} / 8192 tokens$`));
    });
  }

  it('reports the 8,193rd token, and counts the tokens of a cart only', () => {
    assert.deepStrictEqual(cartErrors(numbers(8186)), []);
    assert.deepStrictEqual(cartErrors(numbers(8187)), [ 'main.p8 5:7 program too large: 8193 / 8192 tokens' ]);
    assert.deepStrictEqual(cartErrors(over('a=-1')), [ 'main.p8 4:39841 program too large: 8209 / 8192 tokens' ]);
    assert.deepStrictEqual(parse(numbers(9000)).errors, []);
  });

  it('counts the tokens of the files the #include lines paste in, in their place, but not the lines', () => {
    assert.deepStrictEqual(cartErrors(over('#include inc.lua'), { 'inc.lua': 'a=1\n' }), [ 'main.p8 4:39841 program too large: 8209 / 8192 tokens' ]);
    assert.deepStrictEqual(cartErrors('a=\n#include v.lua\nb=-1', { 'v.lua': '-1\n' + numbers(8184) }), [ 'v.lua 3:7 program too large: 8196 / 8192 tokens' ]);
    assert.deepStrictEqual(cartErrors('#include v.lua\nb=1', { 'v.lua': numbers(8184) + '\n#include w.lua' })[0], 'main.p8 5:2 program too large: 8193 / 8192 tokens');
  });

  it('reports too many tokens besides the errors Lua finds, each at its place', () => {
    assert.deepStrictEqual(cartErrors('x = = 1\n' + numbers(8183)), [
      'main.p8 4:4 <expression> expected near \'=\'',
      'main.p8 6:7 program too large: 8193 / 8192 tokens',
    ]);
  });

  it('reports code longer than PICO-8 loads, a line break and a glyph each one character and any other character its bytes', () => {
    assert.deepStrictEqual(cartErrors(`--${'a'.repeat(65520)}\nprinth("ok")\n`), []);
    assert.deepStrictEqual(cartErrors(`--${'a'.repeat(65521)}\nprinth("ok")\n`), [ 'main.p8 5:0 the code is longer than PICO-8 loads: 65537 / 65536 characters' ]);
    assert.deepStrictEqual(cartErrors(`--${'a'.repeat(65520)}\r\nprinth("ok")\r\n`), []);
    assert.deepStrictEqual(cartErrors(`--${'a'.repeat(65521)}\r\nprinth("ok")\r\n`), [ 'main.p8 5:0 the code is longer than PICO-8 loads: 65537 / 65536 characters' ]);
    assert.deepStrictEqual(cartErrors(`--${'a'.repeat(65420)}${'⬅️'.repeat(100)}\nprinth("ok")\n`), []);
    assert.deepStrictEqual(cartErrors(`--${'a'.repeat(65420)}${'⬅️'.repeat(101)}\nprinth("ok")\n`), [ 'main.p8 5:0 the code is longer than PICO-8 loads: 65537 / 65536 characters' ]);
    assert.deepStrictEqual(cartErrors(`--${'é'.repeat(32760)}\nprinth("ok")\n`), []);
    assert.deepStrictEqual(cartErrors(`--${'é'.repeat(32761)}\nprinth("ok")\n`), [ 'main.p8 5:0 the code is longer than PICO-8 loads: 65538 / 65536 characters' ]);
    assert.deepStrictEqual(cartErrors(`--${'a'.repeat(65218)}${'⬅'.repeat(101)}\nprinth("ok")\n`), [ 'main.p8 5:0 the code is longer than PICO-8 loads: 65537 / 65536 characters' ]);
  });

  it('counts the end of a cart\'s code as PICO-8 loads it: the line break before a section, 2 more without one at the end of the file, and 1 or 2 for a CR there', () => {
    assert.deepStrictEqual(cartErrors(`--${'a'.repeat(65519)}\nprinth("ok")`), []);
    assert.deepStrictEqual(cartErrors(`--${'a'.repeat(65520)}\nprinth("ok")`), [ 'main.p8 5:0 the code is longer than PICO-8 loads: 65537 / 65536 characters' ]);
    assert.deepStrictEqual(cartErrors(`--${'a'.repeat(65520)}\nprinth("ok")\n__gfx__\n00`), []);
    assert.deepStrictEqual(cartErrors(`--${'a'.repeat(65521)}\nprinth("ok")\n__gfx__\n00`), [ 'main.p8 5:0 the code is longer than PICO-8 loads: 65537 / 65536 characters' ]);
    assert.deepStrictEqual(cartErrors(`--${'a'.repeat(65520)}\nprinth("ok")\n\r`), []);
    assert.deepStrictEqual(cartErrors(`--${'a'.repeat(65521)}\nprinth("ok")\n\r`), [ 'main.p8 5:0 the code is longer than PICO-8 loads: 65537 / 65536 characters' ]);
    assert.deepStrictEqual(cartErrors(`--${'a'.repeat(65519)}\nprinth("ok") \r`), []);
    assert.deepStrictEqual(cartErrors(`--${'a'.repeat(65520)}\nprinth("ok") \r`), [ 'main.p8 5:0 the code is longer than PICO-8 loads: 65537 / 65536 characters' ]);
  });

  it('reports code longer than PICO-8 runs with each #include line replaced by a cart\'s tabs joined, or a .lua\'s code and 2 more when it takes the last tab', () => {
    assert.deepStrictEqual(cartErrors('#include big.lua\nprinth("ok")\n', { 'big.lua': `--${'a'.repeat(65518)}\n` }), []);
    assert.deepStrictEqual(cartErrors('#include big.lua\nprinth("ok")\n', { 'big.lua': `--${'a'.repeat(65519)}\n` }),
      [ 'main.p8 4:0 program exceeds char limit: 65537 / 65536 chars' ]);
    assert.deepStrictEqual(cartErrors('#include big.lua\nprinth("ok")\n#include e.lua', { 'big.lua': `--${'a'.repeat(65514)}\n`, 'e.lua': '' }), []);
    assert.deepStrictEqual(cartErrors('#include big.lua\nprinth("ok")\n#include e.lua', { 'big.lua': `--${'a'.repeat(65515)}\n`, 'e.lua': '' }),
      [ 'main.p8 4:0 program exceeds char limit: 65537 / 65536 chars' ]);
    const cart = `${HEAD}x=1\n-->8\n--${'a'.repeat(65518)}\n`;
    assert.deepStrictEqual(cartErrors('#include c.p8\nprinth("ok")\n', { 'c.p8': cart }), []);
    assert.deepStrictEqual(cartErrors('#include c.p8:1\nprinth("ok")\n', { 'c.p8': cart + '--a\n' }),
      [ 'main.p8 4:0 program exceeds char limit: 65537 / 65536 chars' ]);
    assert.deepStrictEqual(cartErrors('#include b.lua:0\nprinth("ok")\n', { 'b.lua': `--${'a'.repeat(65521)}\n-->8\n` }), []);
  });

  it('counts an #included file as a cart by its header, as a .lua when its path has .lua in it, and else as its characters and 1 more', () => {
    assert.deepStrictEqual(cartErrors('#include e.lua\nprinth("ok")\n', { 'e.lua': `${HEAD}--${'a'.repeat(65521)}\n` }), []);
    assert.deepStrictEqual(cartErrors('#include e.lua\nprinth("ok")\n', { 'e.lua': `${HEAD}--${'a'.repeat(65522)}\n` }),
      [ 'main.p8 4:0 program exceeds char limit: 65537 / 65536 chars' ]);
    const plain = (n: number) => ({ 'e.txt': 'x=1\n--8\ny=2\n', 'a.lua': `--${'a'.repeat(n)}\n` });
    assert.deepStrictEqual(cartErrors('#include a.lua\n--x\n#include e.txt\nprinth("ok")\n', plain(65500)), []);
    assert.deepStrictEqual(cartErrors('#include a.lua\n--x\n#include e.txt\nprinth("ok")\n', plain(65501)),
      [ 'main.p8 4:0 program exceeds char limit: 65537 / 65536 chars' ]);
    // The count PICO-8 prints for each.
    for (const [ line, files, count ] of [
      [ '#include e.txt\n', { 'e.txt': '' }, 65540 ], [ '#include e.txt\n', { 'e.txt': 'x=1' }, 65543 ], [ '#include e.txt\n', { 'e.txt': 'x=1\r\n' }, 65544 ],
      [ '#include e.txt\n', { 'e.txt': '--\r\r\r\n' }, 65543 ], [ '#include e.txt\n', { 'e.txt': '--⬅️é\n' }, 65546 ], [ '#include e\n', { 'e': 'x=1\n' }, 65544 ],
      [ '#include e.p8\n', { 'e.p8': 'x=1\n' }, 65544 ], [ '#include e.lua.txt\n', { 'e.lua.txt': 'x=1\n' }, 65545 ], [ '#include e.LUA\n', { 'e.LUA': 'x=1\n' }, 65545 ],
      [ '#include e.txt\n', { 'e.txt': `${HEAD}x=1\n` }, 65542 ], [ '#include e.lua\n', { 'e.lua': `${HEAD}x=1\n-->8\ny=2\n` }, 65545 ],
    ] as [string, Record<string, string>, number][]) {
      assert.deepStrictEqual(charsWith(line, files), [ `main.p8 4:0 program exceeds char limit: ${count} / 65536 chars` ], JSON.stringify(files));
    }
  });

  it('leaves the count with #include files out for a file taken whole that has a line -->8, which PICO-8 counts in a way not known', () => {
    assert.deepStrictEqual(charsWith('#include e.txt\n', { 'e.txt': 'x=1\n-->8\ny=2\n' }), []);
    assert.deepStrictEqual(charsWith('#include e.txt\n', { 'e.txt': 'x=1\n--8\ny=2\n' }), [ 'main.p8 4:0 program exceeds char limit: 65552 / 65536 chars' ]);
  });

  it('leaves the character counts out for code that has a U+FFFD, which stands for a byte that is not UTF-8 as well as for itself', () => {
    assert.deepStrictEqual(cartErrors(`--\ufffd${'a'.repeat(65530)}\nprinth("ok")\n`), []);
    assert.deepStrictEqual(charsWith('#include e.txt\n', { 'e.txt': '--\ufffd\n' }), []);
  });
});
