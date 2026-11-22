import * as assert from 'assert';
import { outlineOf } from './outline-utils';

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
  });
});
