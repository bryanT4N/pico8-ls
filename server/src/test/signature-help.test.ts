import { deepStrictEqual, strictEqual } from 'assert';
import { builtinInfo } from '../parser/builtins';
import { analyzeCode, indexAt, testFile } from '../parser/test/test-utils';
import { builtinMarkdown } from '../hover';
import { callContextAt, signatureHelpAt } from '../signature-help';

const lines = (...l: string[]) => l.join('\n');
// Signature help at line and column, or at the end of the code.
function helpAt(code: string, line?: number, column?: number) {
  const a = analyzeCode(code);
  return signatureHelpAt([ a.analysis ], testFile(), code, line === undefined ? code.length : indexAt(a, line, column!));
}
const P8 = 'pico-8 cartridge // http://www.pico-8.com\nversion 42\n__lua__\nfunction f(a, b) end\nf(1, ';

describe('signatureHelpAt', () => {
  it('finds the call around the cursor', () => {
    const contextAtEnd = (t: string) => callContextAt(t, t.length);
    deepStrictEqual(contextAtEnd('foo(a, '), { path: [ 'foo' ], colon: false, argument: 1 });
    deepStrictEqual(contextAtEnd('foo(a, g(b, c), '), { path: [ 'foo' ], colon: false, argument: 2 });
    deepStrictEqual(contextAtEnd('foo(a, "x, (y", '), { path: [ 'foo' ], colon: false, argument: 2 });
    deepStrictEqual(contextAtEnd('x = foo(bar(1), [[a,(b]], '), { path: [ 'foo' ], colon: false, argument: 2 });
    deepStrictEqual(contextAtEnd('obj:m('), { path: [ 'obj', 'm' ], colon: true, argument: 0 });
    deepStrictEqual(contextAtEnd('a.b.c(1,\n  -- note (x, y\n  2, '), { path: [ 'a', 'b', 'c' ], colon: false, argument: 2 });
    deepStrictEqual(contextAtEnd('foo({1, 2}, '), { path: [ 'foo' ], colon: false, argument: 1 });
    deepStrictEqual(contextAtEnd('foo({1, 2, '), { path: [ 'foo' ], colon: false, argument: null });
    deepStrictEqual(contextAtEnd('print(t[i, '), { path: [ 'print' ], colon: false, argument: null });
    for (const t of [ 'function f(a, ', 'x = (a, ', 'get():hit(', 'a:b.c(' ]) {
      strictEqual(contextAtEnd(t), undefined, t);
    }
  });

  it('looks past a grouping parenthesis to the call around it', () => {
    const t = 'spr(n, (x + ';
    deepStrictEqual(callContextAt(t, t.length), { path: [ 'spr' ], colon: false, argument: 1 });
  });

  it('shows a user function with its doc and parameter docs', () => {
    const code = lines('x = 1', '-- creates a deep copy', '-- @param obj the table to copy', '-- @return the copy', 'function deep_copy(obj, depth) return obj end',
      'deep_copy(t, ');
    deepStrictEqual(helpAt(code), {
      signatures: [{
        label: 'deep_copy(obj, depth)',
        documentation: { kind: 'markdown', value: 'creates a deep copy\n\n*@return* \u2014 the copy' },
        parameters: [{ label: [ 10, 13 ], documentation: { kind: 'markdown', value: 'the table to copy' } }, { label: [ 15, 20 ] }],
        activeParameter: 1,
      }],
      activeSignature: 0,
      activeParameter: 1,
    });
  });

  it('follows the call\'s colon or dot for self', () => {
    deepStrictEqual(helpAt(lines('vector = {}', 'function vector:dot(v2) return 0 end', 'vector:dot(')),
      { signatures: [{ label: 'vector:dot(v2)', parameters: [{ label: [ 11, 13 ] }], activeParameter: 0 }], activeSignature: 0, activeParameter: 0 });
    deepStrictEqual(helpAt(lines('player = { update = function(self, dt) end }', 'player:update(')),
      { signatures: [{ label: 'player:update(dt)', parameters: [{ label: [ 14, 16 ] }], activeParameter: 0 }], activeSignature: 0, activeParameter: 0 });
    deepStrictEqual(helpAt(lines('vector = {}', 'function vector:dot(v2) return 0 end', 'vector.dot(vector, ')), {
      signatures: [{ label: 'vector.dot(self, v2)', parameters: [{ label: [ 11, 15 ] }, { label: [ 17, 19 ] }], activeParameter: 1 }],
      activeSignature: 0,
      activeParameter: 1,
    });
  });

  it('lets a vararg take the remaining arguments, and marks no parameter inside a table', () => {
    deepStrictEqual(helpAt(lines('function log(fmt, ...) end', 'log("a", 1, 2, ')), {
      signatures: [{ label: 'log(fmt, ...)', parameters: [{ label: [ 4, 7 ] }, { label: [ 9, 12 ] }], activeParameter: 1 }],
      activeSignature: 0,
      activeParameter: 1,
    });
    deepStrictEqual(helpAt(lines('function spawn(props, n) end', 'spawn({ x = 1, ')), {
      signatures: [{ label: 'spawn(props, n)', parameters: [{ label: [ 6, 11 ] }, { label: [ 13, 14 ] }], activeParameter: 2 }],
      activeSignature: 0,
      activeParameter: 2,
    });
  });

  it('finds the call through nesting and over several lines', () => {
    const nested = helpAt(lines('function outer(a, b) end', 'function inner(x) end', 'outer(inner(1), '))!;
    deepStrictEqual([ nested.signatures.length, nested.signatures[0].label, nested.activeParameter ], [ 1, 'outer(a, b)', 1 ]);
    const spread = helpAt(lines('function f(a, b, c) end', 'f(1,', '  -- note (x, y', '  2, '))!;
    deepStrictEqual([ spread.signatures.length, spread.signatures[0].label, spread.activeParameter ], [ 1, 'f(a, b, c)', 2 ]);
  });

  it('lists every method of that name for a method the table does not define', () => {
    const code = lines('entity = {}', '-- changes state', 'function entity:become(state) end', 'bee = {}', 'function bee:become(s) end', 'guy = {}',
      'function guy:update()', '  self:become(', 'end');
    deepStrictEqual(helpAt(code, 8, 14), {
      signatures: [
        {
          label: 'entity:become(state)',
          documentation: { kind: 'markdown', value: 'changes state' },
          parameters: [{ label: [ 14, 19 ] }],
          activeParameter: 0,
        },
        { label: 'bee:become(s)', parameters: [{ label: [ 11, 12 ] }], activeParameter: 0 },
      ],
      activeSignature: 0,
      activeParameter: 0,
    });
  });

  it('finds the function while the call is being typed', () => {
    const inMethod = helpAt(lines('entity = {}', 'function entity:become(state) end', 'guy = {}', 'function guy:update()', '  self:become('))!;
    deepStrictEqual([ inMethod.signatures.length, inMethod.signatures[0].label, inMethod.activeParameter ], [ 1, 'entity:become(state)', 0 ]);
    const beforeEnd = helpAt(lines('function f(a, b) end', 'function g()', '  f(1, ', 'end'), 3, 7)!;
    deepStrictEqual([ beforeEnd.signatures[0].label, beforeEnd.activeParameter ], [ 'f(a, b)', 1 ]);
  });

  it('finds the call in a .p8 cart', () => {
    deepStrictEqual(callContextAt(P8, P8.length), { path: [ 'f' ], colon: false, argument: 1 });
    strictEqual(helpAt(P8)!.signatures[0].label, 'f(a, b)');
  });

  it('shows builtins as before, and a user function of the same name instead', () => {
    const builtin = helpAt(lines('x = 1', 'print(sub(s, 1, 2), '))!;
    const print = builtinInfo('print')!;
    strictEqual(builtin.signatures[0].label, print.sig);
    deepStrictEqual(builtin.signatures[0].documentation, { kind: 'markdown', value: builtinMarkdown('print', print) });
    deepStrictEqual(builtin.signatures[0].parameters![0], { label: 'text', documentation: 'text: The Lua string of characters to print.' });
    strictEqual(builtin.activeParameter, 1);
    strictEqual(helpAt(lines('function print(s) end', 'print('))!.signatures[0].label, 'print(s)');
  });

  it('gives nothing outside a call or in a definition', () => {
    strictEqual(helpAt(lines('x = 1', 'y = ')), undefined);
    strictEqual(helpAt('function f(a, '), undefined);
  });

  it('gives no signature for a path whose table is not found, and the builtin for a plain name', () => {
    const methods = lines('a = {}', 'entity = {}', 'function entity:f() end');
    strictEqual(helpAt(lines(methods, 'nosuch.f(')), undefined);
    strictEqual(helpAt(lines(methods, 'a.nosuch.f(')), undefined);
    strictEqual(helpAt(lines(methods, 'spr('))!.signatures[0].label, builtinInfo('spr')!.sig);
  });
});
