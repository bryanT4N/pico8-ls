import { deepStrictEqual, strictEqual } from 'assert';
import { builtinInfo } from '../parser/builtins';
import { analyzeCode, indexAt, testFile } from '../parser/test/test-utils';
import { builtinMarkdown } from '../hover';
import { builtinSignatureHelp, callContextAt, signatureHelpAt } from '../signature-help';

const lines = (...l: string[]) => l.join('\n');
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

  it('gives no signature in a call it cannot name, rather than the call around it', () => {
    const outer = 'function outer(a, b) end';
    strictEqual(helpAt(lines(outer, 'outer(f(x)(')), undefined);
    strictEqual(helpAt(lines(outer, 'outer(get():hit(')), undefined);
    strictEqual(helpAt(lines(outer, 'outer(make { x = 1 }(')), undefined);
    strictEqual(helpAt(lines(outer, 'outer(t[1](')), undefined);
    strictEqual(helpAt(lines(outer, 'outer(f"s"(')), undefined);
  });

  it('gives no signature for the call around a function body being written', () => {
    const body = 'foreach(t, function(e)';
    strictEqual(helpAt(lines(body, '  local a, b')), undefined);
    const inBody = helpAt(lines(body, '  print(e'))!;
    deepStrictEqual([ inBody.signatures[0].label, inBody.activeParameter ], [ builtinInfo('print')!.sig, 0 ]);
    const after = 'foreach(t, function(e) end, ';
    deepStrictEqual(callContextAt(after, after.length), { path: [ 'foreach' ], colon: false, argument: 2 });
    // The parameter list is not the body.
    const parameters = 'foreach(t, function(e, ';
    deepStrictEqual(callContextAt(parameters, parameters.length), { path: [ 'foreach' ], colon: false, argument: 1 });
  });

  it('takes a block as closed at its end, and a one-line if or while as no block', () => {
    const code = lines('foreach(t, function(e)', '  if e.x then', '    for i = 1, 3 do end', '  elseif e.y then', '    repeat until true', '  end',
      '  if (e.z) e.z = nil', '  while (e.w) e.w -= 1', 'end, ');
    deepStrictEqual(callContextAt(code, code.length), { path: [ 'foreach' ], colon: false, argument: 2 });
  });

  it('finds the call around a one-line if with an elseif or an else, and around an if opened with do that has an elseif', () => {
    for (const shape of [ 'if (e.z) x=1 elseif (e.y) then x=2', 'if (e.z) x=1 elseif (e.y) then', 'if e.z do x=1 elseif e.y do x=2 end',
      'if (e.z) x=1', 'if (e.z) x=1 else x=2', 'if (e.z) x=1 else' ]) {
      const code = lines('foreach(t, function(e)', `  ${shape}`, 'end, ');
      deepStrictEqual(callContextAt(code, code.length), { path: [ 'foreach' ], colon: false, argument: 2 }, shape);
    }
  });

  it('stops at a keyword that starts a statement, unless the keyword is in a closed block', () => {
    for (const t of [ 'foo(1,\nlocal x = (2', 'foo(1,\nlocal x = 2', 'foo(1,\nreturn (2', 'foo(1,\n  goto skip', 'foo(1,\nwhile (a',
      'foo(1,\nfor i = 1, (2', 'foo(1,\nif (a', 'foo(1,\nrepeat x = (2', 'foo(1,\nbreak', 'foo(1, {\n  local', 'print((x)\nlocal y = 1\nz = (a' ]) {
      strictEqual(callContextAt(t, t.length), undefined, t);
    }
    for (const t of [ 'foo(function() local y = 1 end, ', 'foo(function() if a then return end end, ' ]) {
      deepStrictEqual(callContextAt(t, t.length), { path: [ 'foo' ], colon: false, argument: 1 }, t);
    }
    const inBody = 'foo(function()\n  for i = 1, 2 do\n    bar(i, ';
    deepStrictEqual(callContextAt(inBody, inBody.length), { path: [ 'bar' ], colon: false, argument: 1 });
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

  it('gives the receiver of a colon call the first parameter, whatever its name, but not a vararg', () => {
    deepStrictEqual(helpAt(lines('t = { f = function(p, dt) end }', 't:f(')),
      { signatures: [{ label: 't:f(dt)', parameters: [{ label: [ 4, 6 ] }], activeParameter: 0 }], activeSignature: 0, activeParameter: 0 });
    deepStrictEqual(helpAt(lines('t = { g = function(...) end }', 't:g(1, ')),
      { signatures: [{ label: 't:g(...)', parameters: [{ label: [ 4, 7 ] }], activeParameter: 0 }], activeSignature: 0, activeParameter: 0 });
  });

  it('makes active the first signature whose parameters take the argument', () => {
    const methods = (b: string) => lines('a = {}', 'function a:go(x) end', 'b = {}', `function b:go(${b}) end`, 'c = {}', 'c:go(1, 2, ');
    const fixed = helpAt(methods('x, y, z'))!;
    deepStrictEqual([ fixed.signatures.map(signature => signature.label), fixed.activeSignature, fixed.activeParameter ],
      [[ 'a:go(x)', 'b:go(x, y, z)' ], 1, 2 ]);
    const vararg = helpAt(methods('x, ...'))!;
    deepStrictEqual([ vararg.signatures.map(signature => signature.label), vararg.activeSignature, vararg.activeParameter ],
      [[ 'a:go(x)', 'b:go(x, ...)' ], 1, 1 ]);
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
    strictEqual(helpAt(lines('function log(fmt, ...) end', 'log('))!.activeParameter, 0);
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

  it('shows a function from a file included twice once, and each of two definitions', () => {
    const code = lines('#include a.lua', '#include a.lua', 'f(1, ');
    const a = analyzeCode(code, { 'a.lua': 'function f(x, y) end' });
    deepStrictEqual(signatureHelpAt([ a.analysis ], testFile(), code, code.length)!.signatures.map(signature => signature.label), [ 'f(x, y)' ]);
    const branches = helpAt(lines('if x then', '  function g(a) end', 'else', '  function g(a, b) end', 'end', 'g(1, '))!;
    deepStrictEqual(branches.signatures.map(signature => signature.label), [ 'g(a)', 'g(a, b)' ]);
  });

  it('finds the function a call in an included file names in the blocks around it as the file is pasted in', () => {
    const labelsIn = (code: string, file: string) => {
      const a = analyzeCode(code, { 'a.lua': file });
      return [ a.chunk.errors.length, ...signatureHelpAt([ a.analysis ], testFile('a.lua'), file, file.lastIndexOf(')'))!.signatures.map(signature => signature.label) ];
    };
    deepStrictEqual(labelsIn(lines('function g(b, c) end', 'for i = 1, 2 do', '#include a.lua', ''), lines('  local function g(a) end', 'end', 'g(1, 2)')),
      [ 0, 'g(b, c)' ]);
    deepStrictEqual(labelsIn(lines('do', '#include a.lua', 'end'), lines('local function h(x) end', 'end', 'do', '  local function h(y, z) end', '  h(1, 2)')),
      [ 0, 'h(y, z)' ]);
  });

  it('finds the call in a .p8 cart', () => {
    deepStrictEqual(callContextAt(P8, P8.length), { path: [ 'f' ], colon: false, argument: 1 });
    strictEqual(helpAt(P8)!.signatures[0].label, 'f(a, b)');
  });

  it('reads a cart as PICO-8 does, so that a bracket in its header or in a section between its __lua__ sections opens no call', () => {
    const cart = 'pico-8 cartridge // http://www.pico-8.com\nversion 42\n__lua__\nfunction f(a, b) end\n__meta:title__\nprint("me\n__lua__\n';
    const atEnd = (code: string) => callContextAt(cart + code, cart.length + code.length);
    deepStrictEqual([ atEnd('f(1, '), atEnd('x = 1 '), callContextAt(cart, cart.indexOf('me')) ],
      [{ path: [ 'f' ], colon: false, argument: 1 }, undefined, undefined ]);
    strictEqual(helpAt(cart + 'f(1, ')!.signatures[0].label, 'f(a, b)');
    // PICO-8 takes text before pico-8 cartridge on the first line (si.t28.head.code-without-p).
    const header = 'abs( pico-8 cartridge // http://www.pico-8.com\nversion 42\n__lua__\nx = 1 ';
    strictEqual(callContextAt(header, header.length), undefined);
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

  it('takes a call under a local _ENV for a call of the global or the builtin of that name', () => {
    const label = (code: string) => helpAt(code)?.signatures.map(signature => signature.label);
    deepStrictEqual(label(lines('function helper(a) end', 'function upd(_ENV)', '  helper(')), [ 'helper(a)' ]);
    deepStrictEqual(label(lines('function upd(_ENV)', '  function hit(n) end', '  hit(')), [ 'hit(n)' ]);
    deepStrictEqual(label(lines('for _ENV in all(ps) do', '  circ(')), [ builtinInfo('circ')!.sig ]);
  });

  it('gives the signatures of inext, rawequal and ls', () => {
    deepStrictEqual([ 'inext(', 'rawequal(', 'ls(' ].map(call => helpAt(lines('x = 1', call))?.signatures[0].label),
      [ 'inext( tbl, [i] )', 'rawequal( tbl1, tbl2 )', 'ls( [directory] )' ]);
  });

  it('marks no builtin parameter inside a table, and the first inside a string being typed', () => {
    const spr = builtinInfo('spr')!;
    const inTable = helpAt('spr({1, ')!;
    deepStrictEqual([ inTable.signatures[0].label, inTable.activeParameter ], [ spr.sig, spr.params!.length ]);
    const inString = helpAt('print("hel')!;
    deepStrictEqual([ inString.signatures[0].label, inString.activeParameter ], [ builtinInfo('print')!.sig, 0 ]);
  });

  it('gives nothing outside a call or in a definition', () => {
    strictEqual(helpAt(lines('x = 1', 'y = ')), undefined);
    strictEqual(helpAt('function f(a, '), undefined);
  });

  it('gives no signature for a path whose table is not found, and the builtin for a plain name', () => {
    const methods = lines('a = {}', 'entity = {}', 'function entity:f() end');
    strictEqual(helpAt(lines(methods, 'nosuch.f(')), undefined);
    strictEqual(helpAt(lines(methods, 'a.nosuch.f(')), undefined);
    strictEqual(helpAt(lines(methods, 'nosuch.f()', 'x = 1'), 4, 9), undefined);
    strictEqual(helpAt(lines(methods, 'a.nosuch.f()', 'x = 1'), 4, 11), undefined);
    strictEqual(helpAt(lines(methods, 'spr('))!.signatures[0].label, builtinInfo('spr')!.sig);
    // A field that holds no function is not called as a method of another table.
    strictEqual(helpAt(lines(methods, 'obj = {}', 'obj.f = 1', 'obj:f(')), undefined);
  });

  it('gives only builtins with no analysis', () => {
    const spr = lines('function f(a) end', 'spr(1, ');
    deepStrictEqual(signatureHelpAt([], testFile(), spr, spr.length), helpAt(lines('x = 1', 'spr(1, ')));
    const f = lines('function f(a) end', 'f(');
    strictEqual(signatureHelpAt([], testFile(), f, f.length), undefined);
  });

  it('gives a builtin\'s signature help from the call alone', () => {
    deepStrictEqual(builtinSignatureHelp({ path: [ 'spr' ], colon: false, argument: 1 }), helpAt(lines('x = 1', 'spr(1, ')));
    strictEqual(builtinSignatureHelp({ path: [ 'a', 'spr' ], colon: false, argument: 0 }), undefined);
    strictEqual(builtinSignatureHelp({ path: [ 'no_such_builtin' ], colon: false, argument: 0 }), undefined);
  });
});
