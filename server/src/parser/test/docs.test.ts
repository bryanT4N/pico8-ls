import { deepStrictEqual, strictEqual } from 'assert';
import { Doc, Documentation, documentationOf, parseDoc } from '../analysis/docs';
import { analyzeCode, symbolAt } from './test-utils';

const lines = (...l: string[]) => l.join('\n');
// The doc of the symbol at line and column of filename (the main file when left out).
function docAt(code: string, line: number, column: number, files?: Record<string, string>, filename?: string): Doc | undefined {
  const a = analyzeCode(code, files);
  return documentationOf(a.analysis, symbolAt(a, line, column, filename)!).doc;
}
const text = (doc: Doc | undefined) => doc?.description;
function documentationAt(code: string, line: number, column: number): Documentation {
  const a = analyzeCode(code);
  return documentationOf(a.analysis, symbolAt(a, line, column)!);
}

describe('doc comments', () => {
  it('takes the comment block right above a definition', () => {
    strictEqual(text(docAt(lines('x = 1', '-- distance between', '-- two numbers', 'function dist(a, b) return abs(a - b) end',
      'print(dist(1, 2))'), 5, 6)), 'distance between\ntwo numbers');
  });

  it('takes nothing across a blank line', () => {
    strictEqual(text(docAt(lines('x = 1', '-- the player', '', 'function p() end'), 4, 9)), undefined);
  });

  it('reads ---, //, --[[ ]] and --[[-- blocks', () => {
    strictEqual(text(docAt(lines('x = 1', '--- Moves a thing.', '-- More text.', 'function move() end'), 4, 9)), 'Moves a thing.\nMore text.');
    strictEqual(text(docAt(lines('x = 1', '// slash comment', 'function f() end'), 3, 9)), 'slash comment');
    strictEqual(text(docAt(lines('x = 1', '--[[ a long', 'comment ]]', 'function f() end'), 4, 9)), 'a long\ncomment');
    strictEqual(text(docAt(lines('x = 1', '--[[--', ' Summary.', ']]', 'function f() end'), 5, 9)), 'Summary.');
  });

  it('drops banner rows and turns blank comment lines into paragraph breaks', () => {
    strictEqual(text(docAt(lines('x = 1', '----------------', '-- makes an enemy', 'function make_enemy() end'), 4, 9)), 'makes an enemy');
    strictEqual(text(docAt(lines('x = 1', '-- first', '--', '-- second', 'function f() end'), 5, 9)), 'first\n\nsecond');
  });

  it('does not take a section heading, a tab name or a file title', () => {
    strictEqual(text(docAt(lines('x = 1', '-------------', '-- enemies', '-------------', 'enemy = {}'), 5, 0)), undefined);
    strictEqual(text(docAt(lines('x = 1', '-->8', '-- player', 'function make_player() end'), 4, 9)), undefined);
    strictEqual(text(docAt(lines('-- my game', '-- by me', 'function _init() end'), 3, 9)), undefined);
    strictEqual(text(docAt(lines('#include lib.lua', 'x = helper()'), 2, 4, { 'lib.lua': lines('-- helpers', 'function helper() end') })), undefined);
    strictEqual(text(docAt(lines('-- #region player', '-- makes a player', 'function make_player() end'), 3, 9)), 'makes a player');
  });

  it('does not take a one-line heading between two runs of separators', () => {
    strictEqual(text(docAt(lines('x = 1', '-- ==== player ====', 'function make_player() end'), 3, 9)), undefined);
    strictEqual(text(docAt(lines('x = 1', '-- ---- enemies ----', 'enemy = {}'), 3, 0)), undefined);
    strictEqual(text(docAt(lines('x = 1', '---- enemies ----', 'enemy = {}'), 3, 0)), undefined);
    strictEqual(text(docAt(lines('x = 1', '-- waits --- then fires', 'function fire() end'), 3, 9)), 'waits --- then fires');
    strictEqual(text(docAt(lines('x = 1', '-- - then waits...', 'function wait() end'), 3, 9)), '- then waits...');
  });

  it('reads a long run of separators inside a line quickly', () => {
    const long = 'a' + '-'.repeat(100000) + 'b';
    strictEqual(text(docAt(lines('x = 1', '-- ' + long, 'function f() end'), 3, 9)), long);
  });

  it('takes a comment block after leading #include lines, which are code', () => {
    strictEqual(text(docAt(lines('#include lib.lua', '-- adds two numbers', 'function add(a, b) return a + b end'), 3, 9,
      { 'lib.lua': 'x = 1' })), 'adds two numbers');
  });

  it('does not take commented-out code', () => {
    strictEqual(text(docAt(lines('x = 1', '-- DEBUG:', '--printh(x)', 'speed = 2'), 4, 0)), undefined);
    strictEqual(text(docAt(lines('x = 1', '-- speed = 3', 'speed = 2'), 3, 0)), undefined);
    strictEqual(text(docAt(lines('x = 1', 't = {', '  -- DEBUG:', '  --frames = 0,', '  speed = 2,', '}'), 5, 2)), undefined);
    strictEqual(text(docAt(lines('x = 1', '--#include other.lua', 'y = 2'), 3, 0)), undefined);
    strictEqual(text(docAt(lines('x = 1', '--?x', 'function f() end'), 3, 9)), undefined);
    strictEqual(text(docAt(lines('x = 1', '--?"hi"', 'function f() end'), 3, 9)), undefined);
    strictEqual(text(docAt(lines('x = 1', '--local y', 'function f() end'), 3, 9)), undefined);
    strictEqual(text(docAt(lines('x = 1', '--return', 'function f() end'), 3, 9)), undefined);
    strictEqual(text(docAt(lines('x = 1', '-- calls fn for each item', '-- e.g. each(t, print)', 'function each(t, fn) end'), 4, 9)),
      'calls fn for each item\ne.g. each(t, print)');
    strictEqual(text(docAt(lines('x = 1', '-- calls "update"', 'function f() end'), 3, 9)), 'calls "update"');
  });

  it('uses the same rule in function bodies, but not for the function itself', () => {
    strictEqual(text(docAt(lines('function f()', '  -- sprite position', '  local sp = 1', '  return sp', 'end'), 4, 9)), 'sprite position');
    strictEqual(text(docAt(lines('x = 1', 'function f()', '  -- does f', 'end'), 2, 9)), undefined);
  });

  it('takes an end-of-line comment of a variable, table or field', () => {
    strictEqual(text(docAt(lines('x = 1', 'speed = 2 -- pixels per frame', 'print(speed)'), 3, 6)), 'pixels per frame');
    strictEqual(text(docAt(lines('x = 1', 'player = {', '  hp = 3, -- hit points', '}', 'print(player.hp)'), 5, 13)), 'hit points');
    const table = lines('x = 1', 't = { k = 1 } -- the table', 'print(t.k)');
    strictEqual(text(docAt(table, 3, 6)), 'the table');
    strictEqual(text(docAt(table, 3, 8)), undefined);
    const two = lines('x = 1', 'a = 1 b = 2 -- about b', 'print(a, b)');
    strictEqual(text(docAt(two, 3, 6)), undefined);
    strictEqual(text(docAt(two, 3, 9)), 'about b');
    strictEqual(text(docAt(lines('x = 1', '-----------', '-- tuning', '-----------', 'speed = 2 -- pixels per frame', 'print(speed)'), 6, 6)),
      'pixels per frame');
  });

  it('reads an end-of-line --- comment as a block reads it', () => {
    strictEqual(text(docAt(lines('x = 1', 'speed = 2 --- pixels per frame', 'print(speed)'), 3, 6)), 'pixels per frame');
  });

  it('takes no end-of-line comment of a function, and no --[[ ]] one', () => {
    strictEqual(text(docAt(lines('x = 1', 'function f() end -- one line', 'f()'), 3, 0)), undefined);
    strictEqual(text(docAt(lines('x = 1', 'y = 2 --[[prot]]', 'print(y)'), 3, 6)), undefined);
  });

  it('gives no doc to a loop variable, and the statement\'s doc to each of its names', () => {
    strictEqual(text(docAt(lines('x = 1', '-- each enemy', 'for e in all(es) do print(e) end'), 3, 4)), undefined);
    const screen = lines('x = 1', '-- the screen size', 'w, h = 128, 128', 'print(w, h)');
    strictEqual(text(docAt(screen, 4, 6)), 'the screen size');
    strictEqual(text(docAt(screen, 4, 9)), 'the screen size');
  });

  it('takes the doc of the first place Go to Definition goes to that has one', () => {
    strictEqual(text(docAt(lines('x = 1', '-- the score', 'score = 0', 'function f()', '  -- reset', '  score = 0', 'end', 'print(score)'), 8, 6)),
      'the score');
    // A later assignment in the same file is not a place Go to Definition goes to.
    strictEqual(text(docAt(lines('x = 1', 'score = 0', '-- points so far', 'score = 0', 'print(score)'), 5, 6)), undefined);
    strictEqual(text(docAt(lines('#include lib.lua', 'shared = 5', 'print(shared)'), 3, 6,
      { 'lib.lua': lines('x = 1', '-- shared state', 'shared = 0') })), 'shared state');
    strictEqual(text(docAt(lines('local f', 'x = 1', '-- does f', 'f = function(a) end', 'f(1)'), 5, 0)), 'does f');
    // A local given a function goes to the function only, not to its declaration.
    strictEqual(text(docAt(lines('x = 1', '-- the updater', 'local update', 'update = function() end', 'update()'), 5, 0)), undefined);
  });

  it('takes the doc where Go to Definition goes for a field first set with +=', () => {
    const { definition, doc } = documentationAt(lines('p = {}', 'function p:update()', '  -- the speed', '  self.spd += 1', '  self.spd = 0', 'end',
      'print(p.spd)'), 7, 8);
    strictEqual(text(doc), 'the speed');
    strictEqual(definition!.nameLoc.start.line, 4);
  });

  it('gives the function definition, or else the first plain place Go to Definition goes to, when there is no doc', () => {
    const defined = documentationAt(lines('x = 1', 'f = nil', 'function f(a) end', 'f(1)'), 4, 0);
    strictEqual(defined.doc, undefined);
    strictEqual(defined.definition!.nameLoc.start.line, 3);
    const assigned = documentationAt(lines('x = 1', 'speed = 2', 'function f()', '  speed = 3', 'end', 'print(speed)'), 6, 6);
    strictEqual(assigned.doc, undefined);
    strictEqual(assigned.definition!.nameLoc.start.line, 2);
  });

  it('takes text the parser throws on as no code', () => {
    const nested = '('.repeat(100000);
    strictEqual(text(docAt(lines('x = 1', '-- ' + nested, 'speed = 2'), 3, 0)), nested);
  });

  it('documents a parameter with its function\'s @param, and self with its table\'s doc', () => {
    strictEqual(text(docAt(lines('x = 1', '-- moves p', '-- @param p the thing', 'function move(p) return p end'), 4, 14)), 'the thing');
    strictEqual(text(docAt(lines('x = 1', '-- the vector class', 'v = {}', 'function v:len() return self.x end'), 4, 24)), 'the vector class');
  });

  it('reads the comments of included files', () => {
    const lib = lines('x = 1', '-- distance between', '-- two numbers', 'function dist(a, b) return abs(a - b) end');
    strictEqual(text(docAt(lines('#include lib.lua', 'print(dist(1, 2))'), 2, 6, { 'lib.lua': lib })), 'distance between\ntwo numbers');
    strictEqual(text(docAt(lines('#include lib.lua', '#include lib.lua', 'dist()'), 3, 0,
      { 'lib.lua': lines('x = 1', '-- the distance', 'function dist() end') })), 'the distance');
    strictEqual(text(docAt(lines('#include lib.lua', '#include lib.lua', 'dist()'), 3, 0,
      { 'lib.lua': lines('x = 1', '-- the distance', '-- in pixels', 'function dist() end') })), 'the distance\nin pixels');
  });

  it('reads CRLF files', () => {
    const code = lines('x = 1', '-- distance between', '-- two numbers', 'function dist(a, b) return 0 end', 'speed = 2 -- pixels per frame',
      '--[[ a long', 'comment ]]', 'function f() end', 'print(dist, speed, f)').replace(/\n/g, '\r\n');
    strictEqual(text(docAt(code, 9, 6)), 'distance between\ntwo numbers');
    strictEqual(text(docAt(code, 9, 12)), 'pixels per frame');
    strictEqual(text(docAt(code, 9, 19)), 'a long\ncomment');
  });

  it('reads a .p8 cart', () => {
    const cart = lines('pico-8 cartridge // http://www.pico-8.com', 'version 42', '__lua__', '-- my game', '-- by me', 'function _init() end',
      '-- moves the player', 'function move() end', '-->8', '-- player', 'function make_player() end', '__gfx__', '0000');
    strictEqual(text(docAt(cart, 6, 9)), undefined);
    strictEqual(text(docAt(cart, 8, 9)), 'moves the player');
    strictEqual(text(docAt(cart, 11, 9)), undefined);
  });

  it('parses LDoc tags', () => {
    deepStrictEqual(parseDoc(lines('Moves a thing.', '', 'More.', '@param p the thing', '@param dx how far,', '  in pixels', '@return the new x',
      '@returns table', '@see move_to')), { description: 'Moves a thing.\n\nMore.', tags: [
      { name: 'param', param: 'p', text: 'the thing' },
      { name: 'param', param: 'dx', text: 'how far,\nin pixels' },
      { name: 'return', text: 'the new x' },
      { name: 'return', text: 'table' },
      { name: 'see', text: 'move_to' },
    ] });
  });

  it('reads ---@param as an LDoc @param', () => {
    deepStrictEqual(docAt(lines('x = 1', '---Spawns an enemy', '---@param x number where', '---@return table', 'function spawn(x) end'), 5, 9),
      { description: 'Spawns an enemy', tags: [{ name: 'param', param: 'x', text: 'number where' }, { name: 'return', text: 'table' }] });
  });
});
