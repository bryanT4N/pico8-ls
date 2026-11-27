import { deepStrictEqual } from 'assert';
import { outlineFor } from '../symbols';
import { NO_OUTLINE_OPTIONS, OutlineOptions, outlineOptionsFrom } from '../outline/model';
import { outlineLines, outlineLinesWithRanges } from './outline-utils';
import { ALL_OUTLINE_OPTIONS, analyzeCode, testFile } from './test-utils';

const lines = (...l: string[]) => l.join('\n');
// The outline of name (the main file by default) with these options.
function outlineWith(code: string, options: Partial<OutlineOptions>, { files, name, ranges }: { files?: Record<string, string>, name?: string, ranges?: boolean } = {}): string[] {
  const { analysis, texts } = analyzeCode(code, files);
  const file = testFile(name);
  const symbols = outlineFor(analysis, file, { ...NO_OUTLINE_OPTIONS, ...options }, name ? texts[name] : code);
  return ranges ? outlineLinesWithRanges(symbols) : outlineLines(symbols);
}

describe('outline options', () => {
  it('lists each function\'s parameters first, and not ...', () => {
    deepStrictEqual(outlineWith(lines('function move(p, dx, ...)', '  local speed = 2', 'end', 'obj = {}', 'function obj:m(a) end', 'function obj.n(self, b) end',
      'foreach(es, function(e) end)'), { showParameters: true }),
    [ 'move(p,dx,...) [Function]', '  p [Variable]', '  dx [Variable]', '  speed [Variable]', 'obj [Table]', '  m(a) [Method]', '    a [Variable]',
      '  n(self,b) [Method]', '    self [Variable]', '    b [Variable]', '<anonymous function>(e) [Function]', '  e [Variable]' ]);
  });

  it('lists loop variables under their function, or under their for with blocks', () => {
    const code = lines('function update()', '  for i = 1, #enemies do', '    local e = enemies[i]', '  end', '  for k, v in pairs(t) do end', 'end', 'for j = 1, 2 do end');
    deepStrictEqual(outlineWith(code, { showLoopVariables: true }),
      [ 'update() [Function]', '  i [Variable]', '  e [Variable]', '  k [Variable]', '  v [Variable]', 'j [Variable]' ]);
    deepStrictEqual(outlineWith(code, { showLoopVariables: true, showBlocks: true }),
      [ 'update() [Function]', '  for i = 1, #enemies [Block]', '    i [Variable]', '    e [Variable]', '  for k, v in pairs(t) [Block]', '    k [Variable]',
        '    v [Variable]', 'for j = 1, 2 [Block]', '  j [Variable]' ]);
  });

  it('makes a block a node only when it holds something listed', () => {
    deepStrictEqual(outlineWith(lines('function update_enemies()', '  for i=1,#enemies do', '    local e = enemies[i]', '    if e.hp <= 0 then',
      '      local fx = 1', '    end', '  end', '  while alive do step() end', 'end'), { showBlocks: true }),
    [ 'update_enemies() [Function]', '  for i=1,#enemies [Block]', '    e [Variable]', '    if e.hp <= 0 [Block]', '      fx [Variable]' ]);
  });

  it('names a block after its first line, up to its do or then', () => {
    deepStrictEqual(outlineWith(lines('function f()', '  for k,v in pairs(t) do local a end', '  while  alive   do local b end', '  repeat local c until c',
      '  do local d end', '  if (x > 0) then local e end', '  if a and', '     b then local g end',
      '  if this_is_a_really_long_condition_name and another then local h end', 'end'), { showBlocks: true }),
    [ 'f() [Function]', '  for k,v in pairs(t) [Block]', '    a [Variable]', '  while alive [Block]', '    b [Variable]', '  repeat [Block]', '    c [Variable]',
      '  do [Block]', '    d [Variable]', '  if (x > 0) [Block]', '    e [Variable]', '  if a and [Block]', '    g [Variable]',
      '  if this_is_a_really_long_condition_name\u2026 [Block]', '    h [Variable]' ]);
  });

  it('names a block by its keyword when it has no text to read the header from', () => {
    const { analysis } = analyzeCode(lines('function f()', '  if x > 0 then local a end', 'end'));
    const blocks = { ...NO_OUTLINE_OPTIONS, showBlocks: true };
    const expected = [ 'f() [Function]', '  if [Block]', '    a [Variable]' ];
    deepStrictEqual(outlineLines(outlineFor(analysis, testFile(), blocks)), expected);
    deepStrictEqual(outlineLines(outlineFor(analysis, testFile(), blocks, 'function f()')), expected);
  });

  it('lists the branches of an if side by side, each up to the next, and repeat up to its until', () => {
    deepStrictEqual(outlineWith(lines('function g(x, y)', '  if x > 0 then', '    local p = 1', '  elseif y then', '    local q = 2', '  else', '    local r = 3',
      '  end', '  repeat', '    local n = 1', '  until n > 3', 'end'), { showBlocks: true }, { ranges: true }),
    [ 'g(x,y) [Function] 1:0-12:3 1:9-1:10', '  if x > 0 [Block] 2:2-4:2 2:2-2:4', '    p [Variable] 3:4-3:15 3:10-3:11', '  elseif y [Block] 4:2-6:2 4:2-4:8',
      '    q [Variable] 5:4-5:15 5:10-5:11', '  else [Block] 6:2-8:5 6:2-6:6', '    r [Variable] 7:4-7:15 7:10-7:11', '  repeat [Block] 9:2-11:13 9:2-9:8',
      '    n [Variable] 10:4-10:15 10:10-10:11' ]);
  });

  it('puts what a block defines under it, and a global assigned in a function at the top', () => {
    deepStrictEqual(outlineWith(lines('if debug then', '  score = 0', '  local function dbg() end', 'end', 'function _init()', '  if a then',
      '    function g2() x = 1 end', '  end', 'end'), { showBlocks: true }),
    [ 'if debug [Block]', '  score [Variable]', '  dbg() [Function]', '_init() [Function]', '  if a [Block]', '    g2() [Function]', 'x [Variable]' ]);
  });

  it('puts a callback in a loop header or an if condition inside the block', () => {
    deepStrictEqual(outlineWith(lines('function f()', '  for x in all(filter(t, function(e) return e.alive end)) do', '    local y = x', '  end',
      '  if any(t, function(e) return e.hp > 0 end) then', '  elseif any(t, function(e) return e.dead end) then', '  end',
      '  while any(t, function(e) return e end) do end', '  for i = 1, count(t, function(e) return e end) do end', 'end',
      'for k, v in pairs({ go = function(self) local q = 1 end }) do end'), { showBlocks: true }),
    [ 'f() [Function]', '  for x in all(filter(t, function(e) retu\u2026 [Block]', '    <anonymous function>(e) [Function]', '    y [Variable]',
      '  if any(t, function(e) return e.hp > 0 e\u2026 [Block]', '    <anonymous function>(e) [Function]',
      '  elseif any(t, function(e) return e.dead\u2026 [Block]', '    <anonymous function>(e) [Function]',
      '  while any(t, function(e) return e end) [Block]', '    <anonymous function>(e) [Function]',
      '  for i = 1, count(t, function(e) return \u2026 [Block]', '    <anonymous function>(e) [Function]',
      'for k, v in pairs({ go = function(self)\u2026 [Block]', '  go(self) [Method]', '    q [Variable]' ]);
  });

  it('leaves a field set in a block under its table', () => {
    deepStrictEqual(outlineWith('function f() for i=1,2 do f.x = 1 end end', { showBlocks: true }), [ 'f() [Function]', '  x [Field]' ]);
  });

  it('names a block in a CRLF cart from its first line', () => {
    deepStrictEqual(outlineWith('pico-8 cartridge // http://www.pico-8.com\r\nversion 42\r\n__lua__\r\nfunction f()\r\n  for i = 1,\r\n      3 do local x = i end\r\nend\r\n',
      { showBlocks: true }, { ranges: true }),
    [ 'f() [Function] 4:0-7:3 4:9-4:10', '  for i = 1, [Block] 5:2-6:26 5:2-5:5', '    x [Variable] 6:11-6:22 6:17-6:18' ]);
  });

  it('leaves the blocks of the including file out of an included file\'s outline', () => {
    const code = 'if debug then\n  #include dbg.lua\nend\nfor i = 1, 2 do\n  local q = i\nend';
    const files = { 'dbg.lua': 'local x = 1\nfor j = 1, 2 do local y = j end' };
    deepStrictEqual(outlineWith(code, ALL_OUTLINE_OPTIONS, { files }), [ 'for i = 1, 2 [Block]', '  i [Variable]', '  q [Variable]' ]);
    deepStrictEqual(outlineWith(code, ALL_OUTLINE_OPTIONS, { files, name: 'dbg.lua' }), [ 'x [Variable]', 'for j = 1, 2 [Block]', '  j [Variable]', '  y [Variable]' ]);
  });

  it('ends a branch whose next branch is in an included file at the end of the file, and lists what it defines under it', () => {
    const code = lines('if a then', '  x = 1', '#include b.lua', '  y = 2', 'end', 'z = 3');
    deepStrictEqual(outlineWith(code, { showBlocks: true }, { files: { 'b.lua': 'elseif b then\n  w = 1\n' }, ranges: true }),
      [ 'if a [Block] 1:0-6:5 1:0-1:2', '  x [Variable] 2:2-2:7 2:2-2:3', 'y [Variable] 4:2-4:7 4:2-4:3', 'z [Variable] 6:0-6:5 6:0-6:1' ]);
  });

  it('lists the loop variables and blocks of a file #included in a function at the top of its outline', () => {
    const code = lines('function f()', '  if a then', '    #include lib.lua', '  end', 'end');
    const files = { 'lib.lua': lines('for i = 1, 2 do', '  for k, v in pairs(t) do local y = v end', 'end', 'local z = 1') };
    deepStrictEqual(outlineWith(code, { showLoopVariables: true }, { files, name: 'lib.lua' }),
      [ 'i [Variable]', 'k [Variable]', 'v [Variable]', 'y [Variable]', 'z [Variable]' ]);
    deepStrictEqual(outlineWith(code, ALL_OUTLINE_OPTIONS, { files, name: 'lib.lua' }),
      [ 'for i = 1, 2 [Block]', '  i [Variable]', '  for k, v in pairs(t) [Block]', '    k [Variable]', '    v [Variable]', '    y [Variable]', 'z [Variable]' ]);
    deepStrictEqual(outlineWith(code, ALL_OUTLINE_OPTIONS), [ 'f() [Function]' ]);
  });

  it('reads the options from the settings, each true only when it is true', () => {
    deepStrictEqual(outlineOptionsFrom({ showParameters: true, showBlocks: 'yes' }), { showParameters: true, showLoopVariables: false, showBlocks: false });
    deepStrictEqual(outlineOptionsFrom(undefined), NO_OUTLINE_OPTIONS);
    deepStrictEqual(outlineOptionsFrom(null), NO_OUTLINE_OPTIONS);
  });
});
