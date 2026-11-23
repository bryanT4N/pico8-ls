import { deepEquals, parse, getTestFileContents, TestFilesResolver } from './test-utils';
import { FoldingRangeVisitor } from '../folding-range-visitor';
import { FoldingRange } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getFoldingRegions, getSectionFoldingRegions } from '../folding-regions';

function getFoldingRanges(code: string): FoldingRange[] {
  const ast = parse(code);
  const visitor = new FoldingRangeVisitor();
  visitor.visit(ast);
  return visitor.ranges;
}

const lines = (...l: string[]) => l.join('\n');
const P8 = 'pico-8 cartridge // http://www.pico-8.com\nversion 43\n__lua__\n';

function foldingRegionsOf(filename: string, code: string) {
  const textDocument = TextDocument.create(filename, filename.endsWith('.p8') ? 'pico-8' : 'pico-8-lua', 0, code);
  return getFoldingRegions(textDocument, parse(code).comments || []);
}

describe('Folding Ranges', () => {
  it('creates a folding range for an if statement', () => {
    const code = `
if (a) then
  print(a)
end
`.trim();
    const ranges = getFoldingRanges(code);
    deepEquals(ranges, [
      { startLine: 0, endLine: 1 },
    ]);
  });

  it('creates folding ranges for an if/elseif/else statement', () => {
    const code = `
if c1 then
  print(1)
elseif c2 then
  print(2)
else
  print(3)
end
`.trim();
    const ranges = getFoldingRanges(code);
    deepEquals(ranges, [
      { startLine: 0, endLine: 1 },
      { startLine: 2, endLine: 3 },
      { startLine: 4, endLine: 5 },
    ]);
  });

  it('creates a folding range for a while statement', () => {
    const code = `
while true do
  print(a)
end
`.trim();
    const ranges = getFoldingRanges(code);
    deepEquals(ranges, [
      { startLine: 0, endLine: 2 },
    ]);
  });

  it('creates a folding range for a do statement', () => {
    const code = `
do
  print(a)
end
`.trim();
    const ranges = getFoldingRanges(code);
    deepEquals(ranges, [
      { startLine: 0, endLine: 2 },
    ]);
  });

  it('creates a folding range for a repeat statement', () => {
    const code = `
repeat
  print(a)
until true
`.trim();
    const ranges = getFoldingRanges(code);
    deepEquals(ranges, [
      { startLine: 0, endLine: 2 },
    ]);
  });

  it('creates a folding range for a for numeric statement', () => {
    const code = `
for i=1,10 do
  print(i)
end
`.trim();
    const ranges = getFoldingRanges(code);
    deepEquals(ranges, [
      { startLine: 0, endLine: 2 },
    ]);
  });

  it('creates a folding range for a for generic statement', () => {
    const code = `
for k,v in pairs(t) do
  print(k,v)
end
`.trim();
    const ranges = getFoldingRanges(code);
    deepEquals(ranges, [
      { startLine: 0, endLine: 2 },
    ]);
  });

  it('creates a folding range for a function declaration', () => {
    const code = `
function my_func(a, b)
  return a+b
end
`.trim();
    const ranges = getFoldingRanges(code);
    deepEquals(ranges, [
      { startLine: 0, endLine: 2 },
    ]);
  });

  it('creates folding ranges for multi-line table constructors', () => {
    const code = `
t = {
  a = {},
  b = {
    c = 2,
  },
  d = foo(
    1),
}
`.trim();
    const ranges = getFoldingRanges(code);
    deepEquals(ranges, [
      { startLine: 0, endLine: 7 },
      { startLine: 2, endLine: 4 },
      { startLine: 5, endLine: 6 },
    ]);
  });

  it('creates folding ranges for multi-line assignments', () => {
    const code = `
local x = foo(
  1,
  2)
y = [[
text
]]
`.trim();
    const ranges = getFoldingRanges(code);
    deepEquals(ranges, [
      { startLine: 0, endLine: 2 },
      { startLine: 3, endLine: 5 },
    ]);
  });

  it('creates folding ranges for nested blocks', () => {
    const code = `
function my_func()
  if true then
    while true do
      print("hello")
    end
  end
end
`.trim();
    const ranges = getFoldingRanges(code);
    deepEquals(ranges, [
      { startLine: 0, endLine: 6 },
      { startLine: 1, endLine: 4 },
      { startLine: 2, endLine: 4 },
    ]);
  });

  it('does not create folding ranges for single line blocks', () => {
    const code = 'if true then print("hello") end';
    const ranges = getFoldingRanges(code);
    deepEquals(ranges, []);
  });

  it('creates folding ranges for blocks indented with tabs', () => {
    const code = `
if true then
	if true then
		print("hello")
	end
end
`.trim();
    const ranges = getFoldingRanges(code);
    deepEquals(ranges, [
      { startLine: 0, endLine: 3 },
      { startLine: 1, endLine: 2 },
    ]);
  });
});

describe('Folding Ranges (PICO-8)', () => {
  it('should create folding regions for -->8 tabs', () => {
    const code = `
__lua__
-- tab 1
function a() end
-->8
-- tab 2
function b() end
-->8
-- tab 3
function c() end
__gfx__
`;
    const textDocument = TextDocument.create('test.p8', 'pico-8', 0, code);
    const { comments } = parse(code);
    const regions = getFoldingRegions(textDocument, comments || []);

    deepEquals(regions, [
      { name: '0: tab 1', startLine: 2, endLine: 3 },
      { name: '1: tab 2', startLine: 5, endLine: 6 },
      { name: '2: tab 3', startLine: 8, endLine: 9 },
    ]);
  });

  it('should create folding regions for #region and #endregion markers', () => {
    const code = `
-- #region My Region
local a = 1
local b = 2
-- #endregion

-- #region Another Region
function foo()
  -- #region Nested Region
  print("hello")
  -- #endregion
end
-- #endregion
`.trim();
    const textDocument = TextDocument.create('test.lua', 'pico-8-lua', 0, code);
    const { comments } = parse(code);
    const regions = getFoldingRegions(textDocument, comments || []);

    deepEquals(regions, [
      { name: 'My Region', startLine: 0, endLine: 3 },
      { name: 'Another Region', startLine: 5, endLine: 11 },
      { name: 'Nested Region', startLine: 7, endLine: 9 },
    ]);
  });

  it('should create folding regions when #region has a label and #endregion does not', () => {
    const code = `
-- #region MyLabeledRegion
local a = 1
-- #endregion
`.trim();
    const textDocument = TextDocument.create('test.lua', 'pico-8-lua', 0, code);
    const { comments } = parse(code);
    const regions = getFoldingRegions(textDocument, comments || []);

    deepEquals(regions, [
      { name: 'MyLabeledRegion', startLine: 0, endLine: 2 },
    ]);
  });

  it('should create folding regions when #region has no label and #endregion has a label', () => {
    const code = `
-- #region
local a = 1
-- #endregion MyEndRegion
`.trim();
    const textDocument = TextDocument.create('test.lua', 'pico-8-lua', 0, code);
    const { comments } = parse(code);
    const regions = getFoldingRegions(textDocument, comments || []);

    deepEquals(regions, [
      { name: 'MyEndRegion', startLine: 0, endLine: 2 },
    ]);
  });

  it('should prioritize #region label over #endregion label if both exist', () => {
    const code = `
-- #region StartLabel
local a = 1
-- #endregion EndLabel
`.trim();
    const textDocument = TextDocument.create('test.lua', 'pico-8-lua', 0, code);
    const { comments } = parse(code);
    const regions = getFoldingRegions(textDocument, comments || []);

    deepEquals(regions, [
      { name: 'StartLabel', startLine: 0, endLine: 2 },
    ]);
  });

  it('should handle deeply nested #region and #endregion markers with labels', () => {
    const code = `
-- #region Outer
  -- #region Middle
    -- #region Inner
    local x = 1
    -- #endregion Inner
  -- #endregion Middle
-- #endregion Outer
`.trim();
    const textDocument = TextDocument.create('test.lua', 'pico-8-lua', 0, code);
    const { comments } = parse(code);
    const regions = getFoldingRegions(textDocument, comments || []);

    deepEquals(regions, [
      { name: 'Outer', startLine: 0, endLine: 6 },
      { name: 'Middle', startLine: 1, endLine: 5 },
      { name: 'Inner', startLine: 2, endLine: 4 },
    ]);
  });

  it('should create a folding region to the end of the file if #region is not closed', () => {
    const code = `
-- #region UnclosedRegion
local a = 1
local b = 2
`.trim();
    const textDocument = TextDocument.create('test.lua', 'pico-8-lua', 0, code);
    const { comments } = parse(code);
    const regions = getFoldingRegions(textDocument, comments || []);

    deepEquals(regions, [
      { name: 'UnclosedRegion', startLine: 0, endLine: 2 },
    ]);
  });

  it('should create folding regions for tabs.p8 using TestFilesResolver', () => {
    const filename = 'tabs.p8';
    const code = getTestFileContents(filename);
    const textDocument = TextDocument.create(filename, 'pico-8', 0, code);
    const { comments } = parse(code);

    const expectedFoldingRanges: FoldingRange[] = [
      { startLine: 3, endLine: 32 },   // tab 0: __lua__ ... -->8
      { startLine: 5, endLine: 7 },    // function _init()
      { startLine: 9, endLine: 11 },   // function _update()
      { startLine: 13, endLine: 27 },  // function _draw()
      { startLine: 16, endLine: 17 },  // if draw_tab == 0 then
      { startLine: 18, endLine: 19 },  // elseif draw_tab == 1 then
      { startLine: 20, endLine: 21 },  // elseif draw_tab == 2 then
      { startLine: 22, endLine: 23 },  // elseif draw_tab == 3 then
      { startLine: 24, endLine: 25 },  // elseif draw_tab == 4 then
      { startLine: 29, endLine: 32 },  // function draw_0()
      { startLine: 34, endLine: 39 },  // tab 1: -->8 ... -->8
      { startLine: 36, endLine: 39 },  // function draw_1()
      { startLine: 41, endLine: 48 },  // tab 2: -->8 ... -->8
      { startLine: 45, endLine: 48 },  // function draw_2()
      { startLine: 50, endLine: 54 },  // tab 3: -->8 ... -->8
      { startLine: 51, endLine: 54 },  // function draw_3()
      { startLine: 56, endLine: 62 },  // tab 4: -->8 ... end of __lua__ section
      { startLine: 58, endLine: 61 },  // function draw_4()
    ];

    const regions = getFoldingRegions(textDocument, comments || []);
    const luaRanges = getFoldingRanges(code);

    const combinedRanges = [ ...regions, ...luaRanges ];

    // Sort the combined ranges for consistent comparison
    combinedRanges.sort((a, b) => {
      if (a.startLine !== b.startLine) {
        return a.startLine - b.startLine;
      }
      return a.endLine - b.endLine;
    });

    // Filter out regions that are not of type FoldingRange (e.g., PICO-8 tab regions)
    // and only compare startLine and endLine.
    const actualFoldingRanges = combinedRanges
      .filter(r => r.startLine !== undefined && r.endLine !== undefined)
      .map(r => ({ startLine: r.startLine, endLine: r.endLine }));

    deepEquals(actualFoldingRanges, expectedFoldingRanges);
  });

  it('ends an unclosed #region at the end of the __lua__ section', () => {
    deepEquals(foldingRegionsOf('test.p8', P8 + lines('function a() end', '-- #region open', 'function b() end', '__gfx__', '0000')), [
      { name: 'open', startLine: 4, endLine: 5 },
    ]);
  });

  it('ends an unclosed #region at the end of its tab', () => {
    const code = P8 + lines('function a() end', '-->8', '-- #region typing', 'function b() end', '-->8', 'function c() end', '__gfx__');
    deepEquals(foldingRegionsOf('test.p8', code), [
      { name: '0: tab', startLine: 3, endLine: 3, kind: 'tab' },
      { name: '1: #region typing', startLine: 5, endLine: 6, kind: 'tab' },
      { name: 'typing', startLine: 5, endLine: 6, kind: 'region' },
      { name: '2: tab', startLine: 8, endLine: 8, kind: 'tab' },
    ]);
  });

  it('folds a #region closed in a later tab over the lines written', () => {
    const code = P8 + lines('function a() end', '-->8', '-- #region r', 'function b() end', '-->8', 'function c() end', '-- #endregion', '__gfx__');
    deepEquals(foldingRegionsOf('test.p8', code), [
      { name: '0: tab', startLine: 3, endLine: 3, kind: 'tab' },
      { name: '1: #region r', startLine: 5, endLine: 6, kind: 'tab' },
      { name: 'r', startLine: 5, endLine: 9, kind: 'region' },
      { name: '2: tab', startLine: 8, endLine: 9, kind: 'tab' },
    ]);
  });

  it('names a tab after the comment on its first line only', () => {
    deepEquals(foldingRegionsOf('test.p8', P8 + lines('-- main tab', 'f()', '-->8', 'function e() end', 'x = 1 -- later', '__gfx__')), [
      { name: '0: main tab', startLine: 3, endLine: 4 },
      { name: '1: tab', startLine: 6, endLine: 7 },
    ]);
  });

  it('does not name a tab after a comment that follows code', () => {
    deepEquals(foldingRegionsOf('test.lua', lines('x = 1 -- not a name', '-->8', 'y = 2 -- nor this')), [
      { name: '0: tab', startLine: 0, endLine: 0 },
      { name: '1: tab', startLine: 2, endLine: 2 },
    ]);
  });

  it('names a tab after the first line of a long comment', () => {
    deepEquals(foldingRegionsOf('test.p8', P8 + lines('f()', '-->8', '--[[ a', 'b ]]', 'g()', '__gfx__')), [
      { name: '0: tab', startLine: 3, endLine: 3 },
      { name: '1: a', startLine: 5, endLine: 7 },
    ]);
  });

  it('names a tab after the first line of a long comment in a CRLF file', () => {
    const code = [ 'pico-8 cartridge // http://www.pico-8.com', 'version 43', '__lua__', 'f()', '-->8', '--[[ third tab', 'comments', ']]', 'g()', '__gfx__' ].join('\r\n');
    deepEquals(foldingRegionsOf('test.p8', code), [
      { name: '0: tab', startLine: 3, endLine: 3 },
      { name: '1: third tab', startLine: 5, endLine: 8 },
    ]);
  });

  it('leaves out empty tabs but keeps counting', () => {
    deepEquals(foldingRegionsOf('test.p8', P8 + lines('-->8', 'function a() end', '-->8', '-->8', 'function b() end', '__gfx__', '0000')), [
      { name: '1: tab', startLine: 4, endLine: 4 },
      { name: '3: tab', startLine: 7, endLine: 7 },
    ]);
  });

  it('does not count a -->8 after code as a tab', () => {
    deepEquals(foldingRegionsOf('test.lua', lines('function a() end', 'x = 1 -->8', 'function b() end')), []);
  });

  it('gives a .lua file a tab 0 before its first -->8', () => {
    deepEquals(foldingRegionsOf('test.lua', lines('function f() end', '-->8', 'function g() end')), [
      { name: '0: tab', startLine: 0, endLine: 0 },
      { name: '1: tab', startLine: 2, endLine: 2 },
    ]);
  });

  it('names tab 0 of a .lua file after its first line', () => {
    deepEquals(foldingRegionsOf('test.lua', lines('-- setup', 'function f() end', '-->8', '-- enemies', 'function g() end')), [
      { name: '0: setup', startLine: 0, endLine: 1 },
      { name: '1: enemies', startLine: 3, endLine: 4 },
    ]);
  });

  it('only counts region markers that start a line and are followed by a space', () => {
    const code = lines('x = 1 -- #region trailing', 'y = 2', '-- #endregion', '--#regionfoo', 'z = 1', '--#endregion', '--#region ok', 'w = 1', '--#endregion');
    deepEquals(foldingRegionsOf('test.lua', code), [
      { name: 'ok', startLine: 6, endLine: 8 },
    ]);
  });

  it('does not reorder the comments it is given', () => {
    const code = '-- a\nx = 1\n-- b\n-->8\n-- c';
    const c = parse(code).comments!;
    const comments = [ c[2], c[0], c[3], c[1] ];
    getFoldingRegions(TextDocument.create('test.lua', 'pico-8-lua', 0, code), comments);
    deepEquals(comments.map(comment => comment.raw), [ '-->8', '-- a', '-- c', '-- b' ]);
  });
});

describe('Cartridge section folding regions', () => {
  it('creates a folding region for each cartridge section', () => {
    const code = `pico-8 cartridge // http://www.pico-8.com
version 29
__lua__
function a() end
__gfx__
00000000
11111111
__label__
22222222
__gff__
33333333
__map__
44444444
__sfx__
55555555
__music__
00 41424344
`;
    const textDocument = TextDocument.create('test.p8', 'pico-8', 0, code);

    deepEquals(getSectionFoldingRegions(textDocument), [
      { name: '__lua__', startLine: 2, endLine: 3 },
      { name: '__gfx__', startLine: 4, endLine: 6 },
      { name: '__label__', startLine: 7, endLine: 8 },
      { name: '__gff__', startLine: 9, endLine: 10 },
      { name: '__map__', startLine: 11, endLine: 12 },
      { name: '__sfx__', startLine: 13, endLine: 14 },
      { name: '__music__', startLine: 15, endLine: 17 },
    ]);
  });

  it('skips sections that have no content to fold', () => {
    const code = `__lua__
function a() end
__gfx__
__map__
44444444
`;
    const textDocument = TextDocument.create('test.p8', 'pico-8', 0, code);

    deepEquals(getSectionFoldingRegions(textDocument), [
      { name: '__lua__', startLine: 0, endLine: 1 },
      { name: '__map__', startLine: 3, endLine: 5 },
    ]);
  });

  it('returns no regions for a plain .lua file', () => {
    const code = 'function a() end\nfunction b() end\n';
    const textDocument = TextDocument.create('test.lua', 'pico-8-lua', 0, code);

    deepEquals(getSectionFoldingRegions(textDocument), []);
  });
});

describe('Folding ranges with #include', () => {
  const rangesOf = (code: string, files: Record<string, string>) => {
    const visitor = new FoldingRangeVisitor();
    visitor.visit(parse(code, { includeFileResolver: new TestFilesResolver(files) }));
    return visitor.ranges;
  };

  it('folds only the main file\'s own blocks', () => {
    const main = [ '-- main.lua', '#include inc.lua', 'a = 1', 'b = 2', 'c = 3', 'd = 4', 'function main_fn()', '  return 1', 'end' ].join('\n');
    const inc = [ '-- inc.lua', '', 'function inc_fn()', '  if x then', '    y()', '  end', 'end', 't = {', '  a = 1,', '}' ].join('\n');
    deepEquals(rangesOf(main, { 'inc.lua': inc }), [{ startLine: 6, endLine: 8 }]);
  });

  it('ignores a multi-line statement at the end of an included file', () => {
    const main = [ ...Array.from({ length: 30 }, (_, i) => `v${i + 1} = ${i + 1}`), '#include inc.lua', 'print(v1)' ].join('\n');
    deepEquals(rangesOf(main, { 'inc.lua': 'x = 1\ny = 2 +\n  3' }), []);
  });

  it('folds a function whose body includes a file, but not the included lines', () => {
    deepEquals(rangesOf('function f()\n#include body.lua\nend', { 'body.lua': 'if a then\n  b()\nend' }), [{ startLine: 0, endLine: 2 }]);
  });
});
