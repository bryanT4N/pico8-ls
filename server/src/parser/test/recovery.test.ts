import * as assert from 'assert';
import { Identifier } from '../expressions';
import { AssignmentStatement, DoStatement, FunctionDeclaration } from '../statements';
import { Bounds } from '../types';
import { analyzeCode, deepEqualsAST, formatError, parse, parseInChild, symbolAt, TestFilesResolver } from './test-utils';
import { outlineLines } from './outline-utils';

const lines = (...l: string[]) => l.join('\n');

function check(code: string, errors: string[], outline: string[]) {
  const chunk = parse(code);
  assert.deepStrictEqual(chunk.errors.map(formatError), errors);
  assert.deepStrictEqual(outlineLines(chunk.symbols), outline);
  return chunk;
}

const errorsOf = (code: string) => parse(code).errors.map(formatError);

const span = (loc: Bounds | undefined) => `${loc!.start.line}:${loc!.start.column}-${loc!.end.line}:${loc!.end.column}`;

describe('Parser recovery', () => {
  it('keeps a do block whose end is missing', () => {
    check(
      lines('do', '  x = 1', '', 'function g()', 'end'),
      [ 'main_test_file 5:0 \'end\' expected (to close \'do\' at line 1) near \'<eof>\'' ],
      [ 'x [Variable]', 'g() [Function]' ],
    );
  });

  it('keeps a repeat block whose until is missing', () => {
    check(
      lines('function f()', '  repeat', '    x = 1'),
      [
        'main_test_file 3:8 \'until\' expected (to close \'repeat\' at line 2) near \'<eof>\'',
        'main_test_file 3:8 \'end\' expected (to close \'function\' at line 1) near \'<eof>\'',
      ],
      [ 'f() [Function]', 'x [Variable]' ],
    );
  });

  it('keeps everything when unindented code misses an end', () => {
    check(
      lines('function a()', 'x()', 'function b()', 'y()', 'end'),
      [ 'main_test_file 5:0 \'end\' expected (to close \'function\' at line 1) near \'<eof>\'' ],
      [ 'a() [Function]', '  b() [Function]' ],
    );
  });

  it('reports each block open at the end of the file there, the innermost first, as Lua does', () => {
    check(lines('function _update()', '  if a then', '    x()', '  if b then', '    y()'), [
      'main_test_file 5:6 \'end\' expected (to close \'if\' at line 4) near \'<eof>\'',
      'main_test_file 5:6 \'end\' expected (to close \'if\' at line 2) near \'<eof>\'',
      'main_test_file 5:6 \'end\' expected (to close \'function\' at line 1) near \'<eof>\'',
    ], [ '_update() [Function]' ]);
    check(lines('do', '  x()', 'do', '  y()'), [
      'main_test_file 4:4 \'end\' expected (to close \'do\' at line 3) near \'<eof>\'',
      'main_test_file 4:4 \'end\' expected (to close \'do\' at line 1) near \'<eof>\'',
    ], []);
    check(lines('if a then', '  x()', 'if b then', '  y()', 'if c then', '  z()'), [
      'main_test_file 6:4 \'end\' expected (to close \'if\' at line 5) near \'<eof>\'',
      'main_test_file 6:4 \'end\' expected (to close \'if\' at line 3) near \'<eof>\'',
      'main_test_file 6:4 \'end\' expected (to close \'if\' at line 1) near \'<eof>\'',
    ], []);
  });

  it('reports a goto without its label and keeps the function', () => {
    check(
      lines('function f()', '  goto skip', 'end', 'function g() end'),
      [ 'main_test_file 2:2 no visible label \'skip\' for <goto>' ],
      [ 'f() [Function]', 'g() [Function]' ],
    );
  });

  it('reports a goto into the scope of a local once', () => {
    const { block } = check(
      lines('do', '  goto f', '  local x = 1', '  ::f::', '  print(x)', '  y = 2', '  z = 3', 'end', 'w = 4'),
      [ 'main_test_file 2:2 <goto f> jumps into the scope of local \'x\'' ],
      [ 'x [Variable]', 'f [Label]', 'y [Variable]', 'z [Variable]', 'w [Variable]' ],
    );
    assert.strictEqual(block.body[0].type, 'DoStatement');
    assert.deepStrictEqual((block.body[0] as DoStatement).block.body.map(s => s.type), [
      'GotoStatement', 'LocalStatement', 'LabelStatement', 'CallStatement', 'AssignmentStatement', 'AssignmentStatement',
    ]);
  });

  it('reports a duplicate label and keeps going', () => {
    check(
      lines('::a::', '::a::', 'x = 1'),
      [ 'main_test_file 2:2 label \'a\' already defined on line 1' ],
      [ 'a [Label]', 'a [Label]', 'x [Variable]' ],
    );
  });

  it('keeps a valid goto continue loop error-free', () => {
    check(
      lines('for i=1,3 do', '  if i==2 then goto continue end', '  print(i)', '  ::continue::', 'end'),
      [],
      [ 'continue [Label]' ],
    );
  });

  it('leaves out a goto, label or break error that Lua finds only after another error, where it stops', () => {
    assert.deepStrictEqual(errorsOf(lines('goto nowhere', 'x = = 1')), [ 'main_test_file 2:4 <expression> expected near \'=\'' ]);
    assert.deepStrictEqual(errorsOf(lines('repeat', '  goto nowhere', 'until')), [ 'main_test_file 3:0 <expression> expected near \'<eof>\'' ]);
    assert.deepStrictEqual(errorsOf(lines('goto l', 'local q', 'x = = 1', '::l::', 'print(q)')), [ 'main_test_file 3:4 <expression> expected near \'=\'' ]);
    assert.deepStrictEqual(errorsOf(lines('repeat', 'until )', 'break')), [ 'main_test_file 2:6 <expression> expected near \')\'' ]);
    assert.deepStrictEqual(errorsOf(lines('function f()', '  goto nowhere')),
      [ 'main_test_file 2:7 \'end\' expected (to close \'function\' at line 1) near \'<eof>\'' ]);
    assert.deepStrictEqual(errorsOf(lines('goto nowhere', 'x = "abc')), [ 'main_test_file 2:4 unfinished string near \'"abc\'' ]);
  });

  it('reports a goto, label or break error that Lua finds before any other error', () => {
    assert.deepStrictEqual(errorsOf(lines('::a::', '::a::', 'x = = 1')), [
      'main_test_file 2:2 label \'a\' already defined on line 1',
      'main_test_file 3:4 <expression> expected near \'=\'',
    ]);
    assert.deepStrictEqual(errorsOf(lines('goto l', 'local q', '::l::', 'print(q)', 'x = = 1')), [
      'main_test_file 1:0 <goto l> jumps into the scope of local \'q\'',
      'main_test_file 5:4 <expression> expected near \'=\'',
    ]);
    assert.deepStrictEqual(errorsOf(lines('do goto l', 'local q', '::l::', 'until x')), [
      'main_test_file 1:3 <goto l> jumps into the scope of local \'q\'',
      'main_test_file 4:0 \'end\' expected (to close \'do\' at line 1) near \'until\'',
    ]);
    assert.deepStrictEqual(errorsOf(lines('function f()', '  goto nowhere', 'end', 'x = = 1')), [
      'main_test_file 2:2 no visible label \'nowhere\' for <goto>',
      'main_test_file 4:4 <expression> expected near \'=\'',
    ]);
    assert.deepStrictEqual(errorsOf(lines('::a::', '::a x')), [
      'main_test_file 2:2 label \'a\' already defined on line 1',
      'main_test_file 2:4 \'::\' expected near \'x\'',
    ]);
  });

  it('reports only the first goto, label or break error that Lua finds', () => {
    assert.deepStrictEqual(errorsOf(lines('goto nowhere', 'break')), [ 'main_test_file 1:0 no visible label \'nowhere\' for <goto>' ]);
    assert.deepStrictEqual(errorsOf(lines('break', 'goto nowhere')), [ 'main_test_file 1:0 no loop to break near \'break\'' ]);
    assert.deepStrictEqual(errorsOf(lines('goto nowhere', '::a::', '::a::')), [ 'main_test_file 3:2 label \'a\' already defined on line 2' ]);
    assert.deepStrictEqual(errorsOf(lines('break', 'function f()', '  break', 'end')), [ 'main_test_file 3:2 no loop to break near \'break\'' ]);
    assert.deepStrictEqual(errorsOf(lines('goto nowhere', 'function f()', '  goto alsonowhere', 'end')),
      [ 'main_test_file 3:2 no visible label \'alsonowhere\' for <goto>' ]);
  });

  it('reports elseif without then', () => {
    check(
      lines('if a then', '  b()', 'elseif c', '  d()', 'end'),
      [ 'main_test_file 4:2 \'then\' expected near \'d\'', 'main_test_file 5:0 unexpected keyword \'end\' near \'<eof>\'' ],
      [],
    );
  });

  it('reports if without then as \'then\' expected', () => {
    check(
      lines('if x', 'function f() end'),
      [ 'main_test_file 2:0 \'then\' expected near \'function\'' ],
      [],
    );
  });

  it('reports a mistake in the head of an if, an elseif, a while or a for as the first error', () => {
    const firstError = (code: string) => errorsOf(code)[0];
    assert.strictEqual(firstError(lines('function f()', '  if a b then', '    x = 1', '  else', '    y = 2', '  end', 'end')),
      'main_test_file 2:7 \'then\' expected near \'b\'');
    assert.strictEqual(firstError(lines('function f()', '  if f(a b) then', '    y = 2', '  else', '    z = 3', '  end', 'end')),
      'main_test_file 2:9 \')\' expected near \'b\'');
    assert.strictEqual(firstError(lines('function f()', '  if a then', '    x = 1', '  elseif f(a b) then', '    y = 2', '  else', '    z = 3', '  end', 'end')),
      'main_test_file 4:13 \')\' expected near \'b\'');
    assert.strictEqual(firstError(lines('function f()', '  while a b do', '    x = 1', '  end', 'end')), 'main_test_file 2:10 \'do\' expected near \'b\'');
    assert.strictEqual(firstError(lines('function f()', '  for i = 1 2 do', '    x = 1', '  end', 'end')), 'main_test_file 2:12 \',\' expected near \'2\'');
    assert.strictEqual(firstError(lines('function f()', '  for k in pairs(t) x do', '    y = 1', '  end', 'end')), 'main_test_file 2:20 \'do\' expected near \'x\'');
  });

  it('reports a block missing its end where the file ends, naming the line it opens on', () => {
    assert.deepStrictEqual(errorsOf(lines('function f() a()', 'if (c) b()', 'x = 1')),
      [ 'main_test_file 3:4 \'end\' expected (to close \'function\' at line 1) near \'<eof>\'' ]);
  });

  it('reports the end of a cart\'s code, where its __gfx__ section starts, as the end of the file', () => {
    const cart = (...code: string[]) => lines('pico-8 cartridge // http://www.pico-8.com', 'version 42', '__lua__', ...code, '__gfx__', '0000');
    check(cart('function f()', '  x = 1'), [ 'main_test_file 6:0 \'end\' expected (to close \'function\' at line 4) near \'<eof>\'' ], [ 'f() [Function]', 'x [Variable]' ]);
    check(cart('x ='), [ 'main_test_file 5:0 <expression> expected near \'<eof>\'' ], []);
    check(cart('x = 1', 'end'), [ 'main_test_file 5:0 unexpected keyword \'end\' near \'<eof>\'' ], [ 'x [Variable]' ]);
  });

  it('reports break outside a loop at the break', () => {
    check(
      lines('function f()', '  break', 'end'),
      [ 'main_test_file 2:2 no loop to break near \'break\'' ],
      [ 'f() [Function]' ],
    );
  });

  it('keeps the start of a function after an error inside it', () => {
    const { symbols } = check(
      lines('function f()', '  x = foo(1', 'end'),
      [ 'main_test_file 3:0 \')\' expected near \'end\'' ],
      [ 'f() [Function]' ],
    );
    const { loc, selectionLoc } = symbols[0];
    assert.deepStrictEqual([ loc.start.line, loc.start.column ], [ 1, 0 ]);
    assert.ok(loc.start.index <= selectionLoc.start.index && selectionLoc.end.index <= loc.end.index, `${span(selectionLoc)} is outside ${span(loc)}`);
  });

  it('skips a bad parameter and parses the body', () => {
    check(
      lines('function foo(1)', '  x = 1', 'end'),
      [ 'main_test_file 1:13 <name> or \'...\' expected near \'1\'' ],
      [ 'foo() [Function]', 'x [Variable]' ],
    );
  });

  it('keeps a function left open at the end of an included file', () => {
    const { errors, block } = parse('#include inc.lua\nfunction _update()\nend', {
      includeFileResolver: new TestFilesResolver({ 'inc.lua': 'function typing()\n  local a = 1' }),
    });
    assert.deepStrictEqual(errors.map(formatError), [ 'inc.lua 2:12 \'end\' expected (to close \'function\' at line 1) near \'<eof>\'' ]);
    assert.deepStrictEqual(block.body.map(s => s.type + (s.included ? '*' : '')), [ 'IncludeStatement', 'FunctionDeclaration*', 'FunctionDeclaration' ]);
  });

  it('parses the statement after a broken for statement into the function', () => {
    const { errors, block } = parse(lines('function f()', '  for i=1,10 x', '  i = 5', 'end'));
    assert.deepStrictEqual(errors.map(formatError), [ 'main_test_file 2:13 \'do\' expected near \'x\'' ]);
    assert.deepStrictEqual(block.body.map(s => s.type), [ 'FunctionDeclaration' ]);
    const statement = (block.body[0] as FunctionDeclaration).block.body[0];
    assert.strictEqual(statement.type, 'AssignmentStatement');
    assert.strictEqual(((statement as AssignmentStatement).variables[0] as Identifier).name, 'i');
  });

  it('ends a one-line if at the end of its line, an else with nothing after it too, as PICO-8 does', () => {
    check(lines('if (x) y() else', '  z()', 'function b()', 'end'), [], [ 'b() [Function]' ]);
  });

  describe('a value left to type at the end of a line', () => {
    it('reports a value left to type where reading stops, on the line below, as PICO-8 does', () => {
      check(lines('x =', 'player.x = 3'), [ 'main_test_file 2:9 unexpected symbol \'=\' near \'3\'' ], [ 'x [Variable]' ]);
      check(lines('local x =', 'y = 2'), [ 'main_test_file 2:2 unexpected symbol \'=\' near \'2\'' ], [ 'x [Variable]' ]);
      check(lines('x = 1 +', 'player.x = 3'), [ 'main_test_file 2:9 unexpected symbol \'=\' near \'3\'' ], [ 'x [Variable]' ]);
      check(lines('function f()', '  x =', 'end'), [ 'main_test_file 3:0 <expression> expected near \'end\'' ], [ 'f() [Function]' ]);
    });

    it('takes a value on the line below as the value', () => {
      check(lines('x =', 'foo()', 'bar()'), [], [ 'x [Variable]' ]);
      check(lines('function f()', '  return', '  foo()', 'end'), [], [ 'f() [Function]' ]);
      check(lines('local a =', '(b)()'), [], [ 'a [Variable]' ]);
      check(lines('l =', 'line(w)?"x"'), [], [ 'l [Variable]' ]);
    });

    it('reports as the first error a do or then missing above a block that starts with a statement keyword', () => {
      const firstError = (code: string) => formatError(parse(code).errors[0]);
      assert.deepStrictEqual([
        firstError(lines('while a', '  local y = 1', 'end')),
        firstError(lines('if a', '  return', 'end')),
        firstError(lines('for i = 1, n', '  for j = 1, 2 do x = 1 end', 'end')),
      ], [
        'main_test_file 2:2 \'do\' expected near \'local\'',
        'main_test_file 2:2 \'then\' expected near \'return\'',
        'main_test_file 2:2 \'do\' expected near \'for\'',
      ]);
    });

    it('reads the line below a colon, a dot or a comma as the rest of the value when it can be', () => {
      for (const code of [ lines('x = a:', 'update()'), lines('x = a.', '  b'), lines('x = 1,', 'foo()'), lines('function a.', 'b()', 'end') ]) {
        assert.deepStrictEqual(errorsOf(code), [], code);
      }
    });
  });

  describe('a table, an argument list or an index left open', () => {
    it('reports a bracket left open at the end of the file at its end, or the value missing in it', () => {
      check(lines('x = 1', 'foo(a,'), [ 'main_test_file 2:5 <expression> expected near \'<eof>\'' ], [ 'x [Variable]' ]);
      check('x = f(1', [ 'main_test_file 1:6 \')\' expected near \'<eof>\'' ], []);
      check('x = (a', [ 'main_test_file 1:5 \')\' expected near \'<eof>\'' ], []);
      check(lines('t = {', '  a = 1,'), [ 'main_test_file 2:7 \'}\' expected near \'<eof>\'' ], []);
      check('x = a[', [ 'main_test_file 1:5 <expression> expected near \'<eof>\'' ], []);
    });
  });
});

describe('Parser recovery of parameter lists left open', function () {
  this.timeout(30000);

  const OPEN_PARAMETER_LISTS: [string, string, string[], string[]][] = [
    [
      'stops a parameter list at a keyword',
      lines('function foo(a', '  local x = 1', 'end'),
      [ 'main_test_file 2:2 \')\' expected near \'local\'' ],
      [ 'foo(a) [Function]', '  x [Variable]' ],
    ],
    [
      'ends a parameter list left open after a whole function',
      lines('function a()', 'end', 'function foo('),
      [
        'main_test_file 3:12 \')\' expected near \'<eof>\'',
        'main_test_file 3:12 \'end\' expected (to close \'function\' at line 3) near \'<eof>\'',
      ],
      [ 'a() [Function]', 'foo() [Function]' ],
    ],
    [
      'ends a parameter list left open after a comma',
      'function foo(a,',
      [
        'main_test_file 1:14 \')\' expected near \'<eof>\'',
        'main_test_file 1:14 \'end\' expected (to close \'function\' at line 1) near \'<eof>\'',
      ],
      [ 'foo(a) [Function]' ],
    ],
    [
      'ends the parameter list of a function expression left open',
      'f = function(',
      [
        'main_test_file 1:12 \')\' expected near \'<eof>\'',
        'main_test_file 1:12 \'end\' expected (to close \'function\' at line 1) near \'<eof>\'',
      ],
      [ 'f() [Function]' ],
    ],
    [
      'ends the parameter list of a local function left open',
      'local function foo(a, b',
      [
        'main_test_file 1:22 \')\' expected near \'<eof>\'',
        'main_test_file 1:22 \'end\' expected (to close \'function\' at line 1) near \'<eof>\'',
      ],
      [ 'foo(a,b) [Function]' ],
    ],
  ];
  for (const [ name, code, errors, outline ] of OPEN_PARAMETER_LISTS) {
    it(name, () => {
      const result = parseInChild(code);
      assert.strictEqual(result.threw, null);
      assert.deepStrictEqual(result.errors, errors);
      assert.deepStrictEqual(result.outline, outline);
    });
  }
});

describe('values as PICO-8 reads them', () => {
  it('reads ~ between two values as exclusive or, binding as ^^ does', () => {
    const num = (value: number) => ({ type: 'NumericLiteral', value });
    const name = (n: string) => ({ type: 'Identifier', name: n });
    const op = (operator: string, left: Record<string, unknown>, right: Record<string, unknown>) => ({ type: 'BinaryExpression', operator, left, right });
    deepEqualsAST(lines('x=6~3', 'y=6 ~ 3', 'z=1~~2', 'w^^=y~z', 'v=1|2~3 u=6&3~1 t=1~1<<2 s=1~1==0', 'r=1~2&2 q=1~2^^3 p=1^^2~3'), [
      { type: 'AssignmentStatement', init: [ op('~', num(6), num(3)) ] },
      { type: 'AssignmentStatement', init: [ op('~', num(6), num(3)) ] },
      { type: 'AssignmentStatement', init: [ op('~', num(1), { type: 'UnaryExpression', operator: '~', argument: num(2) }) ] },
      { type: 'AssignmentStatement', operator: '^^=', init: [ op('~', name('y'), name('z')) ] },
      { type: 'AssignmentStatement', init: [ op('|', num(1), op('~', num(2), num(3))) ] },
      { type: 'AssignmentStatement', init: [ op('~', op('&', num(6), num(3)), num(1)) ] },
      { type: 'AssignmentStatement', init: [ op('~', num(1), op('<<', num(1), num(2))) ] },
      { type: 'AssignmentStatement', init: [ op('==', op('~', num(1), num(1)), num(0)) ] },
      { type: 'AssignmentStatement', init: [ op('~', num(1), op('&', num(2), num(2))) ] },
      { type: 'AssignmentStatement', init: [ op('^^', op('~', num(1), num(2)), num(3)) ] },
      { type: 'AssignmentStatement', init: [ op('~', op('^^', num(1), num(2)), num(3)) ] },
    ]);
  });

  it('reports numbers and escapes that PICO-8 does not read', () => {
    assert.deepStrictEqual(errorsOf(lines('x=0x1p4', 'printh("ok")')), [ 'main_test_file 2:0 assignment operator expected near \'printh\'' ]);
    assert.deepStrictEqual(errorsOf('x="\\256"'), [ 'main_test_file 1:2 decimal escape too large near \'\\256\'' ]);
    assert.deepStrictEqual(errorsOf('x=1..2'), [ 'main_test_file 1:2 malformed number near \'1..2\'' ]);
    assert.strictEqual(errorsOf(lines('y="b"', 'x=1..y'))[0], 'main_test_file 2:2 malformed number near \'1..\'');
    assert.strictEqual(errorsOf('x=0b2')[0], 'main_test_file 1:2 malformed number near \'0b\'');
    assert.deepStrictEqual(errorsOf('x="\\255" y="\\2555" z=1 ..2 w=0x1.8 v=0b1010.1 u=.5 t=1.'), []);
  });

  it('reports a separator where a table field or the first argument of a call should start', () => {
    assert.deepStrictEqual(errorsOf('x={,}'), [ 'main_test_file 1:3 <expression> expected near \',\'' ]);
    assert.deepStrictEqual(errorsOf('x={1,,2}'), [ 'main_test_file 1:5 <expression> expected near \',\'' ]);
    assert.deepStrictEqual(errorsOf('x={;}'), [ 'main_test_file 1:3 <expression> expected near \';\'' ]);
    assert.deepStrictEqual(errorsOf(lines('function f() end', 'f(,1)')), [ 'main_test_file 2:2 <expression> expected near \',\'' ]);
    assert.deepStrictEqual(errorsOf('f(,)'), [ 'main_test_file 1:2 <expression> expected near \',\'' ]);
    assert.deepStrictEqual(errorsOf('x={1,2,3,} y={a=1;b=2;}'), []);
  });

  it('lets ? take the rest of its line, also as a value', () => {
    assert.deepStrictEqual(errorsOf('?"x" x=1'), [ 'main_test_file 1:5 <end of line> expected near \'x\'' ]);
    assert.deepStrictEqual(errorsOf('?"a";x=1'), [ 'main_test_file 1:4 <end of line> expected near \';\'' ]);
    assert.deepStrictEqual(errorsOf(lines('a=1', 'if a then ?"x" end')), [ 'main_test_file 2:15 <end of line> expected near \'end\'' ]);
    assert.deepStrictEqual(errorsOf('function f() ?"x" end'), [ 'main_test_file 1:18 <end of line> expected near \'end\'' ]);
    assert.deepStrictEqual(errorsOf('printh(?"a")'), [ 'main_test_file 1:11 <end of line> expected near \')\'' ]);
    assert.deepStrictEqual(errorsOf('x=?"a" y=1'), [ 'main_test_file 1:7 <end of line> expected near \'y\'' ]);
    assert.strictEqual(errorsOf(lines('a=1', 'if (a) ?"y" else ?"n"'))[0], 'main_test_file 2:12 <end of line> expected near \'else\'');
    assert.deepStrictEqual(errorsOf(lines('x=?"a"', 'a=1', 'if (a) ?"yes"', 'while (a) ?"x"', '?"a" -- note', 'x=1 ?"y"')), []);
  });

  it('takes a compound assignment to one target, which can be a call or a value in brackets', () => {
    assert.deepStrictEqual(errorsOf(lines('a=1 b=1', 'a,b+=1')), [ 'main_test_file 2:3 \'=\' expected near \'+=\'' ]);
    assert.deepStrictEqual(errorsOf('local a+=1'), [ 'main_test_file 1:7 unexpected symbol \'+=\' near \'1\'' ]);
    assert.deepStrictEqual(errorsOf(lines('function f() end', 'f()=1')), [ 'main_test_file 2:3 unexpected symbol \'=\' near \'1\'' ]);
    check(lines('t={m=function() end}', 'function f() end', 'f()+=1', 't:m()+=1', 'f"a"+=1', '(a)+=1'), [], [ 't [Table]', '  m() [Method]', 'f() [Function]' ]);
    assert.deepStrictEqual(errorsOf(lines('function f() end', 'a=1', 'a,f()+=1')), [ 'main_test_file 3:5 unexpected symbol \'+=\' near \'1\'' ]);
  });

  it('assigns to nothing when a compound assignment\'s target is in brackets, as PICO-8 does', () => {
    check(lines('t={}', '(t.y)+=1', '(1)+=1', '({})+=1'), [], [ 't [Table]' ]);
    const a = symbolAt(analyzeCode(lines('local a=1', '(a)+=1')), 2, 1)!;
    assert.deepStrictEqual(a.definitions.map(d => d.nameLoc.start.line), [ 1 ]);
    assert.deepStrictEqual(a.references.map(r => [ r.loc.start.line, r.read, r.write ]), [[ 1, false, true ], [ 2, true, false ]]);
  });
});

describe('statements as PICO-8 reads them', () => {
  const cartErrors = (code: string) => parse(code, { filename: 'main.p8' }).errors.map(formatError);

  it('reads if (c) and while (c) as one-line forms when what follows c is on their line and c ends in no ) of its own', () => {
    assert.deepStrictEqual(errorsOf(lines('a=1', 'if (a)', 'x=1')), [ 'main_test_file 3:0 \'then\' expected near \'x\'' ]);
    assert.deepStrictEqual(errorsOf(lines('a=1', 'if (a and', 'a) x=1')), [ 'main_test_file 3:3 \'then\' expected near \'x\'' ]);
    assert.deepStrictEqual(errorsOf('if (a) (f)() x=1'), [ 'main_test_file 1:13 \'then\' expected near \'x\'' ]);
    assert.deepStrictEqual(errorsOf('if (a) or f() x=1'), [ 'main_test_file 1:14 \'then\' expected near \'x\'' ]);
    assert.deepStrictEqual(errorsOf('if (t):m() y=1'), [ 'main_test_file 1:11 \'then\' expected near \'y\'' ]);
    assert.deepStrictEqual(errorsOf(lines('while (a)', 'x=1')), [ 'main_test_file 2:0 \'do\' expected near \'x\'' ]);
    assert.deepStrictEqual(errorsOf('while (a) or f() x=1'), [ 'main_test_file 1:17 \'do\' expected near \'x\'' ]);
    assert.deepStrictEqual(errorsOf('if (a)'), [ 'main_test_file 1:5 \'then\' expected near \'<eof>\'' ]);
    assert.deepStrictEqual(errorsOf(lines('if (btn(0)) x=1', 'if (f) "x" y=1', 'if (f) {} y=1', 'if (t) [1] y=1', 'if (t).x y=1', 'if (a) and b y=1',
      'if ((f)()) y=1', 'a=1', 'if (a)', 'then x=1 end')), []);
  });

  it('reads an if (c) or while (c) inside a one-line if or while as needing its then or do when c ends the line, as PICO-8 does', () => {
    assert.deepStrictEqual(errorsOf(lines('if (b) if (a)', 'x=1')), [ 'main_test_file 1:13 \'then\' expected near \'\\n\'' ]);
    assert.deepStrictEqual(errorsOf(lines('while (b) if (a)', 'x=1')), [ 'main_test_file 1:16 \'then\' expected near \'\\n\'' ]);
    assert.deepStrictEqual(errorsOf(lines('if (b) while (a)', 'x=1')), [ 'main_test_file 1:16 \'do\' expected near \'\\n\'' ]);
    assert.deepStrictEqual(errorsOf(lines('if (b) x=1 else if (a)', 'y=1')), [ 'main_test_file 1:22 \'then\' expected near \'\\n\'' ]);
    assert.deepStrictEqual(errorsOf(lines('if (b) if (a) else x=2', 'if (b) if (a);', 'if (b) if (a) x=1')), []);
  });

  it('takes an empty clause in a one-line if, also an else at the end of its line, and an elseif with its then', () => {
    assert.deepStrictEqual(errorsOf(lines('if (a);', 'if (a) else x=2', 'if (a) x=1 else x=2', 'b=1', 'if (a) x=1 elseif (b) then x=2 else x=3')), []);
    assert.deepStrictEqual(errorsOf(lines('if (a) x=1 else', 'x=2', 'end')), [ 'main_test_file 3:0 unexpected keyword \'end\' near \'<eof>\'' ]);
    assert.deepStrictEqual(errorsOf(lines('b=1', 'if (a) x=1 elseif (b) x=2')), [ 'main_test_file 2:22 \'then\' expected near \'x\'' ]);
    assert.deepStrictEqual(errorsOf('if (a) end'), [ 'main_test_file 1:7 unexpected keyword \'end\' near \'<eof>\'' ]);
  });

  it('reports what follows a return in its block where reading stops', () => {
    assert.deepStrictEqual(errorsOf(lines('return 1', 'x=2')), [ 'main_test_file 2:0 \'<eof>\' expected near \'x\'' ]);
    assert.strictEqual(errorsOf(lines('function f()', 'return 1', 'x=2', 'end'))[0], 'main_test_file 3:0 \'end\' expected (to close \'function\' at line 1) near \'x\'');
    assert.strictEqual(errorsOf(lines('repeat', 'return 1', 'x=2', 'until true'))[0], 'main_test_file 3:0 \'until\' expected (to close \'repeat\' at line 1) near \'x\'');
    assert.deepStrictEqual(errorsOf(lines('function f(a)', 'if (a) return 1 x=2', 'end')), [ 'main_test_file 2:16 <end of line> expected near \'x\'' ]);
    assert.deepStrictEqual(errorsOf(lines('function f()', '  if a then return end', '  return;', 'end', 'do return end', 'if (a) return', 'x=1')), []);
  });

  it('reports a second ; after a return where reading stops, as PICO-8 does', () => {
    assert.strictEqual(errorsOf(lines('function f()', 'return;;', 'end'))[0], 'main_test_file 2:7 \'end\' expected (to close \'function\' at line 1) near \';\'');
    assert.deepStrictEqual(errorsOf('do return 1; ; end'), [ 'main_test_file 1:13 \'end\' expected (to close \'do\' at line 1) near \';\'' ]);
    assert.deepStrictEqual(errorsOf(lines('function f(a)', 'if (a) return;;', 'end')), [ 'main_test_file 2:14 <end of line> expected near \';\'' ]);
    assert.deepStrictEqual(cartErrors(lines('printh(1)', 'return;;')), [ 'main.p8 2:7 \'<eof>\' expected near \';\'' ]);
  });

  it('names the block or bracket that a one-line body leaves open at the end of its line, a block as Lua does', () => {
    assert.strictEqual(errorsOf(lines('a=1', 'if (a) for i=1,3 do', 'x=i', 'end'))[0], 'main_test_file 2:19 \'end\' expected (to close \'for\' at line 2) near \'\\n\'');
    assert.strictEqual(errorsOf(lines('a=1 b=1', 'if (a) if b then', 'x=1', 'end'))[0], 'main_test_file 2:16 \'end\' expected (to close \'if\' at line 2) near \'\\n\'');
    assert.strictEqual(errorsOf(lines('t={} a=1', 'if (a) add(t,{', '1})'))[0], 'main_test_file 2:14 \'}\' expected near \'\\n\'');
    assert.strictEqual(errorsOf(lines('a=1', 'if (a) printh(', '"x")'))[0], 'main_test_file 2:14 \')\' expected near \'\\n\'');
  });

  it('reports, in a cart, a return that ends its outermost block, and a goto there past a local to a label at its end', () => {
    for (const last of [ 'return', 'return 1', 'return;', 'return -- bye' ]) {
      assert.deepStrictEqual(cartErrors(lines('printh("ok")', last)), [ 'main.p8 2:0 PICO-8 does not accept a return in the cart\'s outermost block' ], last);
    }
    assert.deepStrictEqual(cartErrors(lines('return 1', 'x=2')), [ 'main.p8 2:0 \'<eof>\' expected near \'x\'' ]);
    assert.deepStrictEqual(cartErrors(lines('goto l', 'local q', '::l::')), [ 'main.p8 1:0 <goto l> jumps into the scope of local \'q\'' ]);
    assert.deepStrictEqual(cartErrors(lines('do return end', 'if (a) return', 'do', 'goto l', 'local q', '::l::', 'end', 'function f()', 'goto m', 'local r', '::m::', 'end')), []);
    assert.deepStrictEqual(errorsOf(lines('printh("ok")', 'return')), []);
    assert.deepStrictEqual(errorsOf(lines('goto l', 'local q', '::l::')), []);
  });
});
