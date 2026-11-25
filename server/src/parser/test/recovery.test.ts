import * as assert from 'assert';
import { Identifier } from '../expressions';
import { FoldingRangeVisitor } from '../folding-range-visitor';
import { AssignmentStatement, DoStatement, FunctionDeclaration, getFunctionDeclarationName, IfStatement } from '../statements';
import { ASTNode, Bounds } from '../types';
import { formatError, parse, ParsedForTest, parseInChild, TestFilesResolver } from './test-utils';
import { allSymbols, outlineLines } from './outline-utils';

const lines = (...l: string[]) => l.join('\n');

function check(code: string, errors: string[], outline: string[]) {
  const chunk = parse(code);
  assert.deepStrictEqual(chunk.errors.map(formatError), errors);
  assert.deepStrictEqual(outlineLines(chunk.symbols), outline);
  return chunk;
}

const span = (loc: Bounds | undefined) => `${loc!.start.line}:${loc!.start.column}-${loc!.end.line}:${loc!.end.column}`;

function nodesIn(value: unknown): ASTNode[] {
  if (Array.isArray(value)) {
    return value.flatMap(nodesIn);
  }
  if (value && typeof value === 'object' && typeof (value as ASTNode).type === 'string') {
    const children = Object.entries(value).filter(([ key ]) => key !== 'loc').map(([ , child ]) => child as unknown);
    return [ value as ASTNode, ...nodesIn(children) ];
  }
  return [];
}

// `name` is a top-level function that a block left open handed back: no node,
// outline entry or folding range that starts before it may reach over it.
function assertHandedBack(chunk: ParsedForTest, name: string) {
  const handedBack = chunk.block.body.find(s => s.type === 'FunctionDeclaration' && getFunctionDeclarationName(s) === name)!;
  const start = handedBack.loc!.start.index;
  const reachesOver = (loc: Bounds) => loc.start.index < start && loc.end.index > start;
  const others = nodesIn(chunk.block.body.filter(s => s !== handedBack));
  assert.deepStrictEqual(others.filter(n => n.loc && reachesOver(n.loc)).map(n => `${n.type} ${span(n.loc)}`), []);
  assert.ok(chunk.symbols.some(s => s.name === name), `${name} is not a top-level outline entry`);
  assert.deepStrictEqual(allSymbols(chunk.symbols).filter(s => reachesOver(s.loc)).map(s => `${s.name} ${span(s.loc)}`), []);
  const folding = new FoldingRangeVisitor();
  folding.visit(chunk);
  const line = handedBack.loc!.start.line - 1;
  assert.deepStrictEqual(folding.ranges.filter(r => r.startLine < line && r.endLine >= line), []);
}

describe('Parser recovery', () => {
  it('keeps a function whose end is missing and gives back what follows', () => {
    const { block } = check(
      lines('function _init()', '  x = 0', 'end', '', 'function foo()', 'function _update()', '  x += 1', 'end'),
      [ 'main_test_file 5:0 \'end\' expected (to close \'function\' at line 5) near \'<eof>\'' ],
      [ '_init() [Function]', 'x [Variable]', 'foo() [Function]', '_update() [Function]' ],
    );
    assert.deepStrictEqual(block.body.slice(1).map(s => span(s.loc)), [ '5:0-5:14', '6:0-8:3' ]);
  });

  it('keeps a do block whose end is missing', () => {
    check(
      lines('do', '  x = 1', '', 'function g()', 'end'),
      [ 'main_test_file 1:0 \'end\' expected (to close \'do\' at line 1) near \'<eof>\'' ],
      [ 'x [Variable]', 'g() [Function]' ],
    );
  });

  it('keeps a repeat block whose until is missing', () => {
    check(
      lines('function f()', '  repeat', '    x = 1', 'end'),
      [ 'main_test_file 2:2 \'until\' expected (to close \'repeat\' at line 2) near \'end\'' ],
      [ 'f() [Function]', 'x [Variable]' ],
    );
  });

  it('keeps everything when unindented code misses an end', () => {
    check(
      lines('function a()', 'x()', 'function b()', 'y()', 'end'),
      [ 'main_test_file 1:0 \'end\' expected (to close \'function\' at line 1) near \'<eof>\'' ],
      [ 'a() [Function]', 'b() [Function]' ],
    );
  });

  it('blames the inner block closed by a less indented end', () => {
    const { block } = check(
      lines('function _update()', '  if dead then', '  y = 2', 'end', '', 'function _draw()', 'end'),
      [ 'main_test_file 2:2 \'end\' expected (to close \'if\' at line 2) near \'<eof>\'' ],
      [ '_update() [Function]', 'y [Variable]', '_draw() [Function]' ],
    );
    assert.strictEqual(span(block.body[0].loc), '1:0-4:3');
  });

  it('blames the inner block with tab indentation', () => {
    check(
      'function a()\n\tif x then\n\t\ty()\nend\nfunction b()\nend',
      [ 'main_test_file 2:1 \'end\' expected (to close \'if\' at line 2) near \'<eof>\'' ],
      [ 'a() [Function]', 'b() [Function]' ],
    );
  });

  it('blames an inner while block', () => {
    check(
      lines('function f()', '  while x do', '    y()', 'end', 'function g()', 'end'),
      [ 'main_test_file 2:2 \'end\' expected (to close \'while\' at line 2) near \'<eof>\'' ],
      [ 'f() [Function]', 'g() [Function]' ],
    );
  });

  it('blames the function, not a repeat closed by a less indented until', () => {
    check(
      lines('function f()', '  repeat', '    x()', 'until y'),
      [ 'main_test_file 1:0 \'end\' expected (to close \'function\' at line 1) near \'<eof>\'' ],
      [ 'f() [Function]' ],
    );
  });

  it('blames the repeat, not an if closed by a less indented end', () => {
    check(
      lines('repeat', '  if a then', '    b()', 'end'),
      [ 'main_test_file 1:0 \'until\' expected (to close \'repeat\' at line 1) near \'<eof>\'' ],
      [],
    );
  });

  it('resumes at a function on the line after x =', () => {
    check(
      lines('function _init()', 'end', 'x =', 'function _update()', 'end'),
      [ 'main_test_file 3:3 <expression> expected near \'function\'' ],
      [ '_init() [Function]', 'x [Variable]', '_update() [Function]' ],
    );
  });

  it('resumes at local on the line after x = inside a function', () => {
    check(
      lines('function f()', '  x =', '  local y = 1', 'end'),
      [ 'main_test_file 2:5 <expression> expected near \'local\'' ],
      [ 'f() [Function]', '  y [Variable]', 'x [Variable]' ],
    );
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

  it('reports a break after a broken repeat as outside a loop', () => {
    check(
      lines('repeat', 'until', 'break'),
      [ 'main_test_file 2:5 <expression> expected near \'break\'', 'main_test_file 3:0 no loop to break near \'break\'' ],
      [],
    );
  });

  it('keeps goto continue and break in a loop error-free after a broken statement', () => {
    check(
      lines('for i=1,3 do', '  repeat', '  until', '  if i==2 then goto continue end', '  if i==3 then break end', '  ::continue::', 'end'),
      [ 'main_test_file 3:7 <expression> expected near \'if\'' ],
      [ 'continue [Label]' ],
    );
  });

  it('reports a goto without its label inside a statement that failed', () => {
    check(
      lines('repeat', '  goto nowhere', 'until'),
      [ 'main_test_file 2:2 no visible label \'nowhere\' for <goto>', 'main_test_file 3:0 <expression> expected near \'<eof>\'' ],
      [],
    );
  });

  it('reports elseif without then', () => {
    const { block } = check(
      lines('if a then', '  b()', 'elseif c', '  d()', 'end'),
      [ 'main_test_file 3:8 \'then\' expected near \'d\'' ],
      [],
    );
    assert.deepStrictEqual((block.body[0] as IfStatement).clauses.map(c => c.type), [ 'IfClause', 'ElseifClause' ]);
  });

  it('reports if without then as \'then\' expected', () => {
    check(
      lines('if x', 'function f() end'),
      [ 'main_test_file 1:4 \'then\' expected near \'function\'' ],
      [ 'f() [Function]' ],
    );
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
      [ 'main_test_file 2:11 \')\' expected near \'end\'' ],
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

  const UNFINISHED_LINES: [string, string, string[]][] = [
    [ 't = {', '3:4 \'}\' expected (to close \'{\' at line 3) near \'function\'', [ '_init() [Function]', 't [Table]', '_update() [Function]' ]],
    [ 'foo(', '3:3 \')\' expected (to close \'(\' at line 3) near \'function\'', [ '_init() [Function]', '_update() [Function]' ]],
    [ 'print(x', '3:5 \')\' expected (to close \'(\' at line 3) near \'function\'', [ '_init() [Function]', '_update() [Function]' ]],
    [ 'x.', '3:2 <name> expected near \'function\'', [ '_init() [Function]', '_update() [Function]' ]],
    [ 'goto', '3:4 <name> expected near \'function\'', [ '_init() [Function]', '_update() [Function]' ]],
    [ 'if x', '3:4 \'then\' expected near \'function\'', [ '_init() [Function]', '_update() [Function]' ]],
    [ 'for i=1,10', '3:10 \'do\' expected near \'function\'', [ '_init() [Function]', '_update() [Function]' ]],
    [ 'function foo', '3:12 \'(\' expected near \'function\'', [ '_init() [Function]', '_update() [Function]' ]],
    [ 'x = 1 +', '3:7 <expression> expected near \'function\'', [ '_init() [Function]', 'x [Variable]', '_update() [Function]' ]],
    [ 'local x =', '3:9 <expression> expected near \'function\'', [ '_init() [Function]', 'x [Variable]', '_update() [Function]' ]],
  ];
  for (const [ unfinished, error, outline ] of UNFINISHED_LINES) {
    it(`keeps the function on the line after ${unfinished}`, () => {
      check(
        lines('function _init()', 'end', unfinished, 'function _update()', 'end'),
        [ `main_test_file ${error}` ],
        outline,
      );
    });
  }

  it('keeps a function left open at the end of an included file', () => {
    const { errors, block } = parse('#include inc.lua\nfunction _update()\nend', {
      includeFileResolver: new TestFilesResolver({ 'inc.lua': 'function typing()\n  local a = 1' }),
    });
    assert.deepStrictEqual(errors.map(formatError), [ 'inc.lua 1:0 \'end\' expected (to close \'function\' at line 1) near \'<eof>\'' ]);
    assert.deepStrictEqual(block.body.map(s => s.type + (s.included ? '*' : '')), [ 'IncludeStatement', 'FunctionDeclaration*', 'FunctionDeclaration' ]);
  });

  it('parses the statement after a broken for statement into the function', () => {
    const { errors, block } = parse(lines('function f()', '  for i=1,10 x', '  i = 5', 'end'));
    assert.deepStrictEqual(errors.map(formatError), [ 'main_test_file 2:13 \'do\' expected near \'x\'' ]);
    const statement = (block.body[0] as FunctionDeclaration).block.body[0];
    assert.strictEqual(statement.type, 'AssignmentStatement');
    assert.strictEqual(((statement as AssignmentStatement).variables[0] as Identifier).name, 'i');
  });

  const AROUND_OPEN_FUNCTION: [string, string, string[], string[]][] = [
    [
      'ends an assignment around a function left open before the code handed back',
      lines('f = function()', '  x()', 'function g()', '  y()', 'end'),
      [ 'main_test_file 1:4 \'end\' expected (to close \'function\' at line 1) near \'<eof>\'' ],
      [ 'f() [Function]', 'g() [Function]' ],
    ],
    [
      'ends a local statement around a function left open before the code handed back',
      lines('local f = function()', '  x()', 'function g()', '  y()', 'end'),
      [ 'main_test_file 1:10 \'end\' expected (to close \'function\' at line 1) near \'<eof>\'' ],
      [ 'f() [Function]', 'g() [Function]' ],
    ],
    [
      'hands back the code after a function left open in a table field, though the table statement is dropped',
      lines('t = {', '  update = function()', '    x()', 'function g()', '  y()', 'end'),
      [
        'main_test_file 2:11 \'end\' expected (to close \'function\' at line 2) near \'<eof>\'',
        'main_test_file 6:0 \'}\' expected near \'<eof>\'',
      ],
      [ 'g() [Function]' ],
    ],
    [
      'ends a field assignment around a function left open before the code handed back',
      lines('t = {}', 't.update = function()', '  x()', 'function g()', '  y()', 'end'),
      [ 'main_test_file 2:11 \'end\' expected (to close \'function\' at line 2) near \'<eof>\'' ],
      [ 't [Table]', '  update() [Method]', 'g() [Function]' ],
    ],
  ];
  for (const [ name, code, errors, outline ] of AROUND_OPEN_FUNCTION) {
    it(name, () => {
      assertHandedBack(check(code, errors, outline), 'g');
    });
  }

  it('keeps a one-line if whose multi-line else is missing its end', () => {
    const chunk = check(
      lines('if (x) y() else', '  z()', 'function b()', 'end'),
      [ 'main_test_file 1:0 \'end\' expected (to close \'if\' at line 1) near \'<eof>\'' ],
      [ 'b() [Function]' ],
    );
    assertHandedBack(chunk, 'b');
  });

  it('ends a return of a function left open before the code handed back', () => {
    const { block } = check(
      lines('function h()', '  return function()', '    x()', '  function g()', '    y()', '  end'),
      [
        'main_test_file 1:0 \'end\' expected (to close \'function\' at line 1) near \'<eof>\'',
        'main_test_file 2:9 \'end\' expected (to close \'function\' at line 2) near \'<eof>\'',
      ],
      [ 'h() [Function]', '  <anonymous function>() [Function]', '  g() [Function]' ],
    );
    const [ returned, handedBack ] = (block.body[0] as FunctionDeclaration).block.body;
    assert.deepStrictEqual([ span(returned.loc), span(handedBack.loc) ], [ '2:2-3:7', '4:2-6:5' ]);
  });

  describe('a value left to type at the end of a line', () => {
    it('parses the line below as its own statement', () => {
      check(lines('x =', 'player.x = 3'), [ 'main_test_file 1:3 <expression> expected near \'player\'' ],
        [ 'x [Variable]', 'player [Table]', '  x [Field]' ]);
      check(lines('local x =', 'y = 2'), [ 'main_test_file 1:9 <expression> expected near \'y\'' ], [ 'x [Variable]', 'y [Variable]' ]);
      check(lines('x, y =', 'z = 1'), [ 'main_test_file 1:6 <expression> expected near \'z\'' ], [ 'x [Variable]', 'y [Variable]', 'z [Variable]' ]);
      check(lines('function f()', '  n +=', '  m = 1', 'end'), [ 'main_test_file 2:6 <expression> expected near \'m\'' ],
        [ 'f() [Function]', 'm [Variable]' ]);
      check(lines('function f()', '  return', '  player.x = 3', 'end'), [ 'main_test_file 2:8 <expression> expected near \'player\'' ],
        [ 'f() [Function]', 'player [Table]', '  x [Field]' ]);
    });

    it('stops at the operator at the end of the line the statement failed on', () => {
      check(lines('x = 1 +', 'player.x = 3'), [ 'main_test_file 1:7 <expression> expected near \'player\'' ],
        [ 'x [Variable]', 'player [Table]', '  x [Field]' ]);
      check(lines('x = a +', '  b +', 'player.x = 3'), [ 'main_test_file 2:5 <expression> expected near \'player\'' ],
        [ 'x [Variable]', 'player [Table]', '  x [Field]' ]);
    });

    it('keeps the statement when the line below cannot be a value', () => {
      check(lines('function f()', '  x =', 'end'), [ 'main_test_file 2:5 <expression> expected near \'end\'' ], [ 'f() [Function]', 'x [Variable]' ]);
      check('x =', [ 'main_test_file 1:3 <expression> expected near \'<eof>\'' ], [ 'x [Variable]' ]);
      check(lines('x =', 'if a then', 'end'), [ 'main_test_file 1:3 <expression> expected near \'if\'' ], [ 'x [Variable]' ]);
    });

    // Unchanged from before: these two pass before the change too.
    it('takes a value on the line below as the value', () => {
      check(lines('x =', 'foo()', 'bar()'), [], [ 'x [Variable]' ]);
      check(lines('function f()', '  return', '  foo()', 'end'), [], [ 'f() [Function]' ]);
      check(lines('local a =', '(b)()'), [], [ 'a [Variable]' ]);
    });

    it('parses again only when the statement fails on the line where the value starts', () => {
      check(lines('x = a +', '  b', ')'), [ 'main_test_file 3:0 unexpected symbol \')\' near \'<eof>\'' ], [ 'x [Variable]' ]);
      check(lines('if a and', 'player.x = 3', 'end'),
        [ 'main_test_file 2:9 \'then\' expected near \'=\'', 'main_test_file 3:0 unexpected keyword \'end\' near \'<eof>\'' ], []);
    });

    it('keeps what came before a statement parsed again, once', () => {
      check(lines('do', '  goto done', '  local a = 1', '  ::done::', '  x =', '  y = 2', 'end'),
        [ 'main_test_file 2:2 <goto done> jumps into the scope of local \'a\'', 'main_test_file 5:5 <expression> expected near \'y\'' ],
        [ 'a [Variable]', 'done [Label]', 'x [Variable]', 'y [Variable]' ]);
      check(lines('f = function()', '  x =', '  y = 2', 'end', 'z =', 'w = 3'),
        [ 'main_test_file 2:5 <expression> expected near \'y\'', 'main_test_file 5:3 <expression> expected near \'w\'' ],
        [ 'f() [Function]', 'x [Variable]', 'y [Variable]', 'z [Variable]', 'w [Variable]' ]);
      check(lines('x =', 'y = `', 'z = 1'), [
        'main_test_file 1:3 <expression> expected near \'y\'',
        'main_test_file 2:3 <expression> expected near \'z\'',
        'main_test_file 2:4 unexpected symbol \'`\'',
      ], [ 'x [Variable]', 'y [Variable]', 'z [Variable]' ]);
      const chunk = check(lines('x = -- todo', 'player.x = 3'), [ 'main_test_file 1:3 <expression> expected near \'player\'' ],
        [ 'x [Variable]', 'player [Table]', '  x [Field]' ]);
      assert.deepStrictEqual(chunk.comments!.map(c => c.value), [ ' todo' ]);
    });

    it('leaves a one-line if as it is', () => {
      check(lines('if (c) x =', 'y = 2'), [ 'main_test_file 1:10 <expression> expected near \'\\n\'' ], [ 'y [Variable]' ]);
    });

    it('reports the missing value in a cart at its line', () => {
      check(lines('pico-8 cartridge // http://www.pico-8.com', 'version 42', '__lua__', 'x =', 'player.x = 3', '__gfx__', ''),
        [ 'main_test_file 4:3 <expression> expected near \'player\'' ], [ 'x [Variable]', 'player [Table]', '  x [Field]' ]);
    });

    // The outer statement gives what it gave before any statement was parsed again: the error at 5:4, no w.
    it('parses again the inner of two unfinished statements, one in the other\'s function value, and not the outer', () => {
      check(lines('v = g(function()', '  x =', '  y.z = 2', 'end) +', 'w.x = 3'),
        [ 'main_test_file 2:5 <expression> expected near \'y\'', 'main_test_file 5:4 unexpected symbol \'=\' near \'3\'' ],
        [ 'v [Variable]', '  <anonymous function>() [Function]', 'x [Variable]', 'y [Table]', '  z [Field]' ]);
    });
  });

  describe('a table, an argument list or an index left open', () => {
    it('closes at a statement no more indented than its line, and keeps what it has', () => {
      check(lines('t = {', '  a = 1,', 'function _update()', 'end'), [ 'main_test_file 1:4 \'}\' expected (to close \'{\' at line 1) near \'function\'' ],
        [ 't [Table]', '  a [Field]', '_update() [Function]' ]);
      check(lines('t = {', '  a = 1', 'function _update()', 'end'), [ 'main_test_file 1:4 \'}\' expected (to close \'{\' at line 1) near \'function\'' ],
        [ 't [Table]', '  a [Field]', '_update() [Function]' ]);
      check(lines('t = {', '  a =', 'local x = 1'), [ 'main_test_file 1:4 \'}\' expected (to close \'{\' at line 1) near \'local\'' ],
        [ 't [Table]', 'x [Variable]' ]);
      check(lines('function f()', '  t = {', '    a = 1,', '  local b = 2', 'end'),
        [ 'main_test_file 2:6 \'}\' expected (to close \'{\' at line 2) near \'local\'' ], [ 'f() [Function]', '  b [Variable]', 't [Table]', '  a [Field]' ]);
      check(lines('foo(a,', 'if b then end'), [ 'main_test_file 1:3 \')\' expected (to close \'(\' at line 1) near \'if\'' ], []);
      check(lines('x = a[i', 'local y = 1'), [ 'main_test_file 1:5 \']\' expected (to close \'[\' at line 1) near \'local\'' ], [ 'x [Variable]', 'y [Variable]' ]);
    });

    it('reports only the innermost of the brackets a statement closes', () => {
      check(lines('t = {', '  a = {', '    b = 1,', 'function _update()', 'end'),
        [ 'main_test_file 2:6 \'}\' expected (to close \'{\' at line 2) near \'function\'' ],
        [ 't [Table]', '  a [Table]', '    b [Field]', '_update() [Function]' ]);
    });

    it('reports only the bracket when the statement around it fails where the bracket closed', () => {
      check(lines('if f(a,', 'local x = 1'), [ 'main_test_file 1:4 \')\' expected (to close \'(\' at line 1) near \'local\'' ], [ 'x [Variable]' ]);
      check(lines('for k,v in pairs(b', 'if x then end'), [ 'main_test_file 1:16 \')\' expected (to close \'(\' at line 1) near \'if\'' ], []);
    });

    // Unchanged from before: these pass before the change too.
    it('leaves a statement indented deeper than the opening line, and code that closes its brackets, as they are', () => {
      check(lines('function f()', '  t = {', '    a = 1,', '    local b = 2', '  }', 'end'),
        [ 'main_test_file 3:10 \'}\' expected near \'local\'', 'main_test_file 5:2 unexpected symbol \'}\' near \'end\'' ], [ 'f() [Function]', '  b [Variable]' ]);
      check(lines('t = {', '  a = 1,', '  b = 2,', '}'), [], [ 't [Table]', '  a [Field]', '  b [Field]' ]);
      check(lines('foo(', '  1,', '  2', ')'), [], []);
    });
  });
});

describe('Parser recovery of parameter lists left open', function () {
  this.timeout(30000);

  const OPEN_PARAMETER_LISTS: [string, string, string[], string[]][] = [
    [
      'stops a parameter list at a keyword',
      lines('function foo(a', '  local x = 1', 'end'),
      [ 'main_test_file 1:14 \')\' expected near \'local\'' ],
      [ 'foo(a) [Function]', '  x [Variable]' ],
    ],
    [
      'ends a parameter list left open after a whole function',
      lines('function a()', 'end', 'function foo('),
      [
        'main_test_file 3:0 \'end\' expected (to close \'function\' at line 3) near \'<eof>\'',
        'main_test_file 3:12 \')\' expected near \'<eof>\'',
      ],
      [ 'a() [Function]', 'foo() [Function]' ],
    ],
    [
      'ends a parameter list left open after a comma',
      'function foo(a,',
      [
        'main_test_file 1:0 \'end\' expected (to close \'function\' at line 1) near \'<eof>\'',
        'main_test_file 1:14 \')\' expected near \'<eof>\'',
      ],
      [ 'foo(a) [Function]' ],
    ],
    [
      'ends the parameter list of a function expression left open',
      'f = function(',
      [
        'main_test_file 1:4 \'end\' expected (to close \'function\' at line 1) near \'<eof>\'',
        'main_test_file 1:12 \')\' expected near \'<eof>\'',
      ],
      [ 'f() [Function]' ],
    ],
    [
      'ends the parameter list of a local function left open',
      'local function foo(a, b',
      [
        'main_test_file 1:0 \'end\' expected (to close \'function\' at line 1) near \'<eof>\'',
        'main_test_file 1:22 \')\' expected near \'<eof>\'',
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
