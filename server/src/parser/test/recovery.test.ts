import * as assert from 'assert';
import { Identifier } from '../expressions';
import { AssignmentStatement, DoStatement, FunctionDeclaration } from '../statements';
import { Bounds } from '../types';
import { formatError, parse, parseInChild, TestFilesResolver } from './test-utils';
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

  it('keeps goto continue and break in a loop error-free after a broken statement', () => {
    check(
      lines('for i=1,3 do', '  repeat', '  until )', '  if i==2 then goto continue end', '  if i==3 then break end', '  ::continue::', 'end'),
      [ 'main_test_file 3:8 <expression> expected near \')\'' ],
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

  it('keeps a goto, label or break error that Lua finds before any other error, in order of place', () => {
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
    assert.deepStrictEqual(errorsOf(lines('goto nowhere', 'break')), [
      'main_test_file 1:0 no visible label \'nowhere\' for <goto>',
      'main_test_file 2:0 no loop to break near \'break\'',
    ]);
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
    const statement = (block.body[0] as FunctionDeclaration).block.body[0];
    assert.strictEqual(statement.type, 'AssignmentStatement');
    assert.strictEqual(((statement as AssignmentStatement).variables[0] as Identifier).name, 'i');
  });

  it('keeps a one-line if whose multi-line else is missing its end', () => {
    check(
      lines('if (x) y() else', '  z()', 'function b()', 'end'),
      [ 'main_test_file 4:0 \'end\' expected (to close \'if\' at line 1) near \'<eof>\'' ],
      [ 'b() [Function]' ],
    );
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
