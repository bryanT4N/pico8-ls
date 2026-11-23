import * as assert from 'assert';
import { outlineOf } from './outline-utils';
import { parse, deepEquals, bounds } from './test-utils';

const lines = (...l: string[]) => l.join('\n');

describe('outline', () => {
  describe('functions and globals', () => {
    it('lists global functions with their signatures, once per definition', () => {
      assert.strictEqual(outlineOf('function draw() end\nfunction update(dt) end\nfunction draw() end'),
        lines('draw() [Function]', 'update(dt) [Function]', 'draw() [Function]'));
    });

    it('lists each global once, at its first assignment, even inside a function', () => {
      assert.strictEqual(outlineOf('function _init()\n  score = 0\n  lives = 3\nend\nscore = 1'),
        lines('_init() [Function]', 'score [Variable]', 'lives [Variable]'));
    });

    it('lists every function assigned to a global', () => {
      assert.strictEqual(outlineOf('x = function(a) end\nx = function(b) end\ny = 1\ny = function() end'),
        lines('x(a) [Function]', 'x(b) [Function]', 'y [Variable]', 'y() [Function]'));
    });

    it('puts a global function declared inside a function at the top level', () => {
      assert.strictEqual(outlineOf('function _init()\n  function helper() end\nend'),
        lines('_init() [Function]', 'helper() [Function]'));
    });

    it('formats varargs in signatures', () => {
      assert.strictEqual(outlineOf('function f(a, ...) end'), 'f(a,...) [Function]');
    });

    it('lists labels where they are', () => {
      assert.strictEqual(outlineOf('::top::\nfunction f()\n  ::again::\nend'),
        lines('top [Label]', 'f() [Function]', '  again [Label]'));
    });

    it('gives a function its full range around the ? print shorthand (issue #17)', () => {
      const { errors, symbols } = parse(lines('', 'function debug_draw()', 'circfill(mx,my,lmb>0 and 2 or 1,7)',
        'local f,g = flags[fmx+fmy*128], switch[fmx+fmy*128]', '?fmx.." "..fmy,1,122,12', 'end'));
      deepEquals(errors, []);
      deepEquals(symbols[0], { name: 'debug_draw', type: 'Function', loc: bounds(2, 0, 6, 3) });
    });
  });

  describe('scopes', () => {
    it('lists locals under their function, including those in blocks', () => {
      assert.strictEqual(outlineOf(lines(
        'function f()', '  local a = 1', '  if a then', '    local b = 2', '  end',
        '  for i = 1, 3 do', '    local c = i', '  end', 'end')),
      lines('f() [Function]', '  a [Variable]', '  b [Variable]', '  c [Variable]'));
    });

    it('does not list parameters or loop variables, but resolves assignments to them', () => {
      assert.strictEqual(outlineOf(lines(
        'function f(a, b)', '  a = a + 1', '  for i = 1, 2 do i = 3 end',
        '  for k, v in pairs(t) do v = 0 end', 'end')),
      'f(a,b) [Function]');
    });

    it('lists file-level locals at the top level', () => {
      assert.strictEqual(outlineOf('local speed = 2\nfunction f()\n  speed = 3\nend'),
        lines('speed [Variable]', 'f() [Function]'));
    });

    it('lists one entry per local declaration', () => {
      assert.strictEqual(outlineOf(lines('function f()', '  local x = 1', '  x = 2', '  do local x = 3 end', 'end')),
        lines('f() [Function]', '  x [Variable]', '  x [Variable]'));
    });

    it('keeps a local apart from a global with the same name', () => {
      assert.strictEqual(outlineOf('x = 1\nfunction f()\n  local x = 2\n  x = 3\nend'),
        lines('x [Variable]', 'f() [Function]', '  x [Variable]'));
    });

    it('lists local functions and functions assigned to locals', () => {
      assert.strictEqual(outlineOf('function f()\n  local function g() end\n  local h = function(a) end\nend'),
        lines('f() [Function]', '  g() [Function]', '  h(a) [Function]'));
    });

    it('lists a function assigned to a parameter', () => {
      assert.strictEqual(outlineOf('function f(cb)\n  cb = function() end\n  function cb(x) end\nend'),
        lines('f(cb) [Function]', '  cb() [Function]', '  cb(x) [Function]'));
    });

    it('lists callbacks as anonymous functions, with their locals', () => {
      assert.strictEqual(outlineOf(lines('function _update()', '  foreach(enemies, function(e)',
        '    local speed = 1', '  end)', 'end')),
      lines('_update() [Function]', '  <anonymous function>(e) [Function]', '    speed [Variable]'));
    });

    it('puts the locals of a function assigned to a global under it', () => {
      assert.strictEqual(outlineOf('x = function()\n  local y = 1\nend'), lines('x() [Function]', '  y [Variable]'));
    });

    it('does not see a local inside its own initializer', () => {
      assert.strictEqual(outlineOf('local co = cocreate(function()\n  co = nil\nend)'),
        lines('co [Variable]', '<anonymous function>() [Function]', 'co [Variable]'));
      assert.strictEqual(outlineOf('local f = function()\n  f = function() end\nend'),
        lines('f() [Function]', 'f() [Function]'));
    });

    it('falls back to the local it shadows in the same scope', () => {
      assert.strictEqual(outlineOf('local x = 1\nlocal x = function()\n  x = function() end\nend'),
        lines('x [Variable]', 'x() [Function]', '  x() [Function]'));
    });
  });
});
