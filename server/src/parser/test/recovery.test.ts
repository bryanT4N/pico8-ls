import * as assert from 'assert';
import { performance } from 'perf_hooks';
import { Identifier } from '../expressions';
import { FoldingRangeVisitor } from '../folding-range-visitor';
import Parser from '../parser';
import { AssignmentStatement, DoStatement, FunctionDeclaration, getFunctionDeclarationName, IfStatement } from '../statements';
import { ASTNode, Bounds } from '../types';
import { formatError, nestedInFunctionValues, parse, ParsedForTest, parseInChild, TestFilesResolver, testFile } from './test-utils';
import { allSymbols, outlineLines } from './outline-utils';

const lines = (...l: string[]) => l.join('\n');

function check(code: string, errors: string[], outline: string[]) {
  const chunk = parse(code);
  assert.deepStrictEqual(chunk.errors.map(formatError), errors);
  assert.deepStrictEqual(outlineLines(chunk.symbols), outline);
  return chunk;
}

const errorsOf = (code: string) => parse(code).errors.map(formatError);

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
      [ 'main_test_file 4:0 \'end\' expected (to close \'do\' at line 1) near \'function\'' ],
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

  it('reports a block missing its closer where the closer goes, when a block as indented follows inside it', () => {
    check(lines('if dead then', '  a()', 'else', '  b()', 'if dead then', 'end'),
      [ 'main_test_file 5:0 \'end\' expected (to close \'if\' at line 1) near \'if\'' ], []);
    check(lines('if new then', '  foo()', 'if dead then', '  bar()', 'end'),
      [ 'main_test_file 3:0 \'end\' expected (to close \'if\' at line 1) near \'if\'' ], []);
    check(lines('function f()', '  if dead then', '    a()', '  else', '    b()', '  if dead then', '  end', 'end', 'function g()', 'end'),
      [ 'main_test_file 6:2 \'end\' expected (to close \'if\' at line 2) near \'if\'' ], [ 'f() [Function]', 'g() [Function]' ]);
    check(lines('function f()', '  if new then', '    foo()', '  if dead then', '    bar()', '  end', 'end', 'function g()', 'end'),
      [ 'main_test_file 4:2 \'end\' expected (to close \'if\' at line 2) near \'if\'' ], [ 'f() [Function]', 'g() [Function]' ]);
    check(lines('pico-8 cartridge // http://www.pico-8.com', 'version 42', '__lua__', 'if dead then', '  a()', 'else', '  b()', 'if dead then', 'end', '__gfx__', ''),
      [ 'main_test_file 8:0 \'end\' expected (to close \'if\' at line 4) near \'if\'' ], []);
  });

  it('reports a block missing its closer at its opener when the block where the closer goes has its own error there', () => {
    check(lines('function _update()', '  if a then', '    x()', '  if b then', '    y()'), [
      'main_test_file 1:0 \'end\' expected (to close \'function\' at line 1) near \'<eof>\'',
      'main_test_file 2:2 \'end\' expected (to close \'if\' at line 2) near \'<eof>\'',
      'main_test_file 4:2 \'end\' expected (to close \'if\' at line 4) near \'<eof>\'',
    ], [ '_update() [Function]' ]);
    check(lines('do', '  x()', 'do', '  y()'), [
      'main_test_file 1:0 \'end\' expected (to close \'do\' at line 1) near \'<eof>\'',
      'main_test_file 3:0 \'end\' expected (to close \'do\' at line 3) near \'<eof>\'',
    ], []);
    check(lines('if a then', '  x()', 'if b then', '  y()', 'if c then', '  z()'), [
      'main_test_file 1:0 \'end\' expected (to close \'if\' at line 1) near \'<eof>\'',
      'main_test_file 3:0 \'end\' expected (to close \'if\' at line 3) near \'<eof>\'',
      'main_test_file 5:0 \'end\' expected (to close \'if\' at line 5) near \'<eof>\'',
    ], []);
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
      [ 'main_test_file 2:2 no visible label \'nowhere\' for <goto>', 'main_test_file 3:5 <expression> expected near \'<eof>\'' ],
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
      [ 'main_test_file 2:9 \')\' expected (to close \'(\' at line 2) near \'end\'' ],
      [ 'f() [Function]', 'x [Variable]' ],
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
      [ 'main_test_file 3:0 \'end\' expected (to close \'function\' at line 1) near \'function\'' ],
      [ 'f() [Function]', 'g() [Function]' ],
    ],
    [
      'ends a local statement around a function left open before the code handed back',
      lines('local f = function()', '  x()', 'function g()', '  y()', 'end'),
      [ 'main_test_file 3:0 \'end\' expected (to close \'function\' at line 1) near \'function\'' ],
      [ 'f() [Function]', 'g() [Function]' ],
    ],
    [
      'hands back the code after a function left open in a table field, keeping the table',
      lines('t = {', '  update = function()', '    x()', 'function g()', '  y()', 'end'),
      [ 'main_test_file 4:0 \'end\' expected (to close \'function\' at line 2) near \'function\'' ],
      [ 't [Table]', '  update() [Method]', 'g() [Function]' ],
    ],
    [
      'ends a field assignment around a function left open before the code handed back',
      lines('t = {}', 't.update = function()', '  x()', 'function g()', '  y()', 'end'),
      [ 'main_test_file 4:0 \'end\' expected (to close \'function\' at line 2) near \'function\'' ],
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
      [ 'main_test_file 3:0 \'end\' expected (to close \'if\' at line 1) near \'function\'' ],
      [ 'b() [Function]' ],
    );
    assertHandedBack(chunk, 'b');
  });

  it('ends a return of a function left open before the code handed back', () => {
    const { block } = check(
      lines('function h()', '  return function()', '    x()', '  function g()', '    y()', '  end'),
      [
        'main_test_file 1:0 \'end\' expected (to close \'function\' at line 1) near \'<eof>\'',
        'main_test_file 4:2 \'end\' expected (to close \'function\' at line 2) near \'function\'',
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
      check(lines('l =', 'line(w)?"x"'), [], [ 'l [Variable]' ]);
    });

    it('parses again only when the statement fails on the line where the value starts', () => {
      check(lines('x = a +', '  b', ')'), [ 'main_test_file 3:0 unexpected symbol \')\' near \'<eof>\'' ], [ 'x [Variable]' ]);
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

    it('keeps a statement whose value is missing at the end of a one-line if or while', () => {
      check(lines('if (c) x =', 'y = 2'), [ 'main_test_file 1:10 <expression> expected near \'\\n\'' ], [ 'x [Variable]', 'y [Variable]' ]);
      check(lines('while (c) x =', 'y = 2'), [ 'main_test_file 1:13 <expression> expected near \'\\n\'' ], [ 'x [Variable]', 'y [Variable]' ]);
      check(lines('function f()', '  if (c) x =', '  player.x = 3', 'end'), [ 'main_test_file 2:12 <expression> expected near \'\\n\'' ],
        [ 'f() [Function]', 'x [Variable]', 'player [Table]', '  x [Field]' ]);
    });

    it('stops a value left to type in the header of an if, a while, a for or an until at the line below', () => {
      check(lines('if a and', 'player.x = 3', 'end'), [ 'main_test_file 1:8 <expression> expected near \'player\'' ], [ 'player [Table]', '  x [Field]' ]);
      check(lines('while a +', 'player.x = 3', 'end'), [ 'main_test_file 1:9 <expression> expected near \'player\'' ], [ 'player [Table]', '  x [Field]' ]);
      check(lines('for i = 1, n +', 'player.x = 3', 'end'), [ 'main_test_file 1:14 <expression> expected near \'player\'' ], [ 'player [Table]', '  x [Field]' ]);
      check(lines('repeat', '  y = 1', 'until a +', 'player.x = 3'), [ 'main_test_file 3:9 <expression> expected near \'player\'' ],
        [ 'y [Variable]', 'player [Table]', '  x [Field]' ]);
      check(lines('if a and', 'local y = 1', 'end'), [ 'main_test_file 1:8 <expression> expected near \'local\'' ], [ 'y [Variable]' ]);
      check(lines('while a +', 'if c then x = 1 end', 'end'), [ 'main_test_file 1:9 <expression> expected near \'if\'' ], [ 'x [Variable]' ]);
      check(lines('for i = 1, n +', 'for j = 1, 2 do x = 1 end', 'end'), [ 'main_test_file 1:14 <expression> expected near \'for\'' ], [ 'x [Variable]' ]);
      check(lines('while a +', 'return', 'end'), [ 'main_test_file 1:9 <expression> expected near \'return\'' ], []);
      check(lines('function f()', 'if a and', 'return 1', 'else', 'y = 2', 'end', 'end'),
        [ 'main_test_file 2:8 <expression> expected near \'return\'' ], [ 'f() [Function]', 'y [Variable]' ]);
      check(lines('function f()', 'if a and', 'local z = 1', 'else', 'y = 2', 'end', 'end'),
        [ 'main_test_file 2:8 <expression> expected near \'local\'' ], [ 'f() [Function]', '  z [Variable]', 'y [Variable]' ]);
      check(lines('while f(a +', '  (b).c = 1', 'end'), [ 'main_test_file 1:11 <expression> expected near \'(\'' ], [ 'b [Table]', '  c [Field]' ]);
    });

    it('reports only the header that stopped at the line below when its block, or one around it, is missing its end', () => {
      check(lines('if a and', 'b = 1'), [ 'main_test_file 1:8 <expression> expected near \'b\'' ], [ 'b [Variable]' ]);
      check(lines('while f(', '  x = 1'), [ 'main_test_file 1:7 \')\' expected (to close \'(\' at line 1) near \'x\'' ], [ 'x [Variable]' ]);
      check(lines('for i = 1, n +', '  x = 1'), [ 'main_test_file 1:14 <expression> expected near \'x\'' ], [ 'x [Variable]' ]);
      check(lines('for k in pairs(', '  x = 1'), [ 'main_test_file 1:14 \')\' expected (to close \'(\' at line 1) near \'x\'' ], [ 'x [Variable]' ]);
      check(lines('if a then', '  y = 1', 'elseif h(a,', '  x = 1'),
        [ 'main_test_file 3:8 \')\' expected (to close \'(\' at line 3) near \'x\'' ], [ 'y [Variable]', 'x [Variable]' ]);
      check(lines('function _update()', '  if btn(0,', '  x -= 1', 'end'),
        [ 'main_test_file 2:8 \')\' expected (to close \'(\' at line 2) near \'x\'' ], [ '_update() [Function]' ]);
      check(lines('do', 'while a +', 'x = 1', 'end'), [ 'main_test_file 2:9 <expression> expected near \'x\'' ], [ 'x [Variable]' ]);
      check(lines('for j = 1, 4 do', 'if (j ==', 'if (l > 63) c(8)', 'rect(j)', 'end'), [ 'main_test_file 2:8 <expression> expected near \'if\'' ], []);
      check(lines('function f()', 'if c then', 'while a +', 'y = 1', 'end'), [ 'main_test_file 3:9 <expression> expected near \'y\'' ],
        [ 'f() [Function]', 'y [Variable]' ]);
      check(lines('function f()', '  do', '    while a +', '      x = 1', '    end'), [ 'main_test_file 3:13 <expression> expected near \'x\'' ],
        [ 'f() [Function]', 'x [Variable]' ]);
      check(lines('function f()', '  while a do', '    x = 1', '  end'),
        [ 'main_test_file 1:0 \'end\' expected (to close \'function\' at line 1) near \'<eof>\'' ], [ 'f() [Function]', 'x [Variable]' ]);
      check(lines('if a then', '  b = 1'), [ 'main_test_file 1:0 \'end\' expected (to close \'if\' at line 1) near \'<eof>\'' ], [ 'b [Variable]' ]);
    });

    it('reads the line below as the block of an if or a while whose condition in parentheses stopped there', () => {
      check(lines('if (a and', '  x = 1', 'end'), [ 'main_test_file 1:9 <expression> expected near \'x\'' ], [ 'x [Variable]' ]);
      check(lines('while (a +', '  x = 1', 'end'), [ 'main_test_file 1:10 <expression> expected near \'x\'' ], [ 'x [Variable]' ]);
      check(lines('function f()', '  if (a and', '    x = 1', '  elseif b then', '    y = 2', '  end', 'end'),
        [ 'main_test_file 2:11 <expression> expected near \'x\'' ], [ 'f() [Function]', 'x [Variable]', 'y [Variable]' ]);
      check(lines('function f()', '  if (f(a,', '    local x = 1', '  else', '    y = 2', '  end', 'end'),
        [ 'main_test_file 2:7 \')\' expected (to close \'(\' at line 2) near \'local\'' ], [ 'f() [Function]', '  x [Variable]', 'y [Variable]' ]);
    });

    it('reports as the first error a do or then missing above a block that starts with a statement keyword', () => {
      const firstError = (code: string) => formatError(parse(code).errors[0]);
      assert.deepStrictEqual([
        firstError(lines('while a', '  local y = 1', 'end')),
        firstError(lines('if a', '  return', 'end')),
        firstError(lines('for i = 1, n', '  for j = 1, 2 do x = 1 end', 'end')),
      ], [
        'main_test_file 1:7 \'do\' expected near \'local\'',
        'main_test_file 1:4 \'then\' expected near \'return\'',
        'main_test_file 1:12 \'do\' expected near \'for\'',
      ]);
    });

    it('closes the brackets still open where the line below starts a statement', () => {
      check(lines('x = f(a +', 'player.x = 3'), [ 'main_test_file 1:9 <expression> expected near \'player\'' ], [ 'x [Variable]', 'player [Table]', '  x [Field]' ]);
      check(lines('x = {a +', 'player.x = 3'), [ 'main_test_file 1:8 <expression> expected near \'player\'' ], [ 'x [Array]', 'player [Table]', '  x [Field]' ]);
      check(lines('x = (a +', 'player.x = 3'), [ 'main_test_file 1:8 <expression> expected near \'player\'' ], [ 'x [Variable]', 'player [Table]', '  x [Field]' ]);
      check(lines('foo(', 'x = 1'), [ 'main_test_file 1:3 \')\' expected (to close \'(\' at line 1) near \'x\'' ], [ 'x [Variable]' ]);
      check(lines('t = {', 'a.b = 1'), [ 'main_test_file 1:4 \'}\' expected (to close \'{\' at line 1) near \'a\'' ], [ 't [Table]', 'a [Table]', '  b [Field]' ]);
      check(lines('x = a[', 'b.c = 1'), [ 'main_test_file 1:5 \']\' expected (to close \'[\' at line 1) near \'b\'' ], [ 'x [Variable]', 'b [Table]', '  c [Field]' ]);
      const printed = check(lines('x = f(j *', 'line(w)?"x"'), [ 'main_test_file 1:9 <expression> expected near \'line\'' ], [ 'x [Variable]' ]);
      assert.deepStrictEqual(printed.block.body.map(s => s.type), [ 'AssignmentStatement', 'CallStatement', 'CallStatement' ]);
      check(lines('x = f(a +', '(b).c = 1'), [ 'main_test_file 1:9 <expression> expected near \'(\'' ], [ 'x [Variable]', 'b [Table]', '  c [Field]' ]);
      check(lines('foo(', '(b).c = 1'), [ 'main_test_file 1:3 \')\' expected (to close \'(\' at line 1) near \'(\'' ], [ 'b [Table]', '  c [Field]' ]);
    });

    it('reports a mistake on the line below at the mistake alone when that line is no new statement', () => {
      check(lines('x =', 'foo(a b)'), [ 'main_test_file 2:6 \')\' expected near \'b\'' ], []);
      check(lines('x =', 'foo() ]'), [ 'main_test_file 2:6 unexpected symbol \']\' near \'<eof>\'' ], [ 'x [Variable]' ]);
      check(lines('x = f(', '  a b', ')'), [ 'main_test_file 2:4 \')\' expected near \'b\'', 'main_test_file 3:0 unexpected symbol \')\' near \'<eof>\'' ], []);
    });

    it('reports the missing value in a cart at its line', () => {
      check(lines('pico-8 cartridge // http://www.pico-8.com', 'version 42', '__lua__', 'x =', 'player.x = 3', '__gfx__', ''),
        [ 'main_test_file 4:3 <expression> expected near \'player\'' ], [ 'x [Variable]', 'player [Table]', '  x [Field]' ]);
    });

    it('parses again both of two unfinished statements, one in the other\'s function value', () => {
      check(lines('v = g(function()', '  x =', '  y.z = 2', 'end) +', 'w.x = 3'),
        [ 'main_test_file 2:5 <expression> expected near \'y\'', 'main_test_file 4:6 <expression> expected near \'w\'' ],
        [ 'v [Variable]', '  <anonymous function>() [Function]', 'x [Variable]', 'y [Table]', '  z [Field]', 'w [Table]', '  x [Field]' ]);
      check(lines('x = g(function() if a then end end) +', 'player.x = 3'), [ 'main_test_file 1:37 <expression> expected near \'player\'' ],
        [ 'x [Variable]', '  <anonymous function>() [Function]', 'player [Table]', '  x [Field]' ]);
    });

    it('reports a value left to type after a unary operator, a dot, a colon or a comma at the end of its line', () => {
      assert.deepStrictEqual(errorsOf(lines('x = -', 'player.x = 3')), [ 'main_test_file 1:5 <expression> expected near \'player\'' ]);
      assert.deepStrictEqual(errorsOf(lines('x = not', 'player.x = 3')), [ 'main_test_file 1:7 <expression> expected near \'player\'' ]);
      assert.deepStrictEqual(errorsOf(lines('x = #', 'player.x = 3')), [ 'main_test_file 1:5 <expression> expected near \'player\'' ]);
      assert.deepStrictEqual(errorsOf(lines('x = a.', 'player.x = 3')), [ 'main_test_file 1:6 <name> expected near \'player\'' ]);
      assert.deepStrictEqual(errorsOf(lines('x = a:', 'player.x = 3')), [ 'main_test_file 1:6 <name> expected near \'player\'' ]);
      assert.deepStrictEqual(errorsOf(lines('x = 1,', 'player.x = 3')), [ 'main_test_file 1:6 <expression> expected near \'player\'' ]);
      assert.deepStrictEqual(errorsOf(lines('x = 1,', 'y = 2')), [ 'main_test_file 1:6 <expression> expected near \'y\'' ]);
      assert.deepStrictEqual(errorsOf(lines('local x = 1,', 'player.x = 3')), [ 'main_test_file 1:12 <expression> expected near \'player\'' ]);
      assert.deepStrictEqual(errorsOf(lines('return 1,', 'player.x = 3')), [ 'main_test_file 1:9 <expression> expected near \'player\'' ]);
    });

    it('reads the line below a colon, a dot or a comma as the rest of the value when it can be', () => {
      for (const code of [ lines('x = a:', 'update()'), lines('x = a.', '  b'), lines('x = 1,', 'foo()'), lines('function a.', 'b()', 'end') ]) {
        assert.deepStrictEqual(errorsOf(code), [], code);
      }
    });

    it('reports the value of a table field left to type at the end of its line', () => {
      assert.deepStrictEqual(errorsOf(lines('t = { a =', 'player.x = 3')), [ 'main_test_file 1:9 <expression> expected near \'player\'' ]);
      assert.deepStrictEqual(errorsOf(lines('t = { [1] =', 'player.x = 3')), [ 'main_test_file 1:11 <expression> expected near \'player\'' ]);
      assert.deepStrictEqual(errorsOf(lines('t = {', '  a =', '}')), [ 'main_test_file 2:5 <expression> expected near \'}\'' ]);
      assert.strictEqual(errorsOf(lines('t = {', '  a = 1,', '  b =', '  c = 3,', '}'))[0], 'main_test_file 3:5 <expression> expected near \'c\'');
    });

    it('reports the value of a header left to type right after its keyword, its = or a comma', () => {
      assert.deepStrictEqual(errorsOf(lines('while', '  x = 1', 'end')), [ 'main_test_file 1:5 <expression> expected near \'x\'' ]);
      assert.deepStrictEqual(errorsOf(lines('function f()', '  if', '    x = 1', '  end', 'end')), [ 'main_test_file 2:4 <expression> expected near \'x\'' ]);
      assert.deepStrictEqual(errorsOf(lines('for i =', '  x = 1', 'end')), [ 'main_test_file 1:7 <expression> expected near \'x\'' ]);
      assert.deepStrictEqual(errorsOf(lines('for k, v in pairs(t),', '    y = 1', 'end')), [ 'main_test_file 1:21 <expression> expected near \'y\'' ]);
      assert.deepStrictEqual(errorsOf(lines('repeat', '  y = 1', 'until', 'x = 1')), [ 'main_test_file 3:5 <expression> expected near \'x\'' ]);
    });

    it('reports a function name left to type after a dot or a colon at the end of its line', () => {
      assert.strictEqual(errorsOf(lines('function guy:', '  self.weight = 0', 'end'))[0], 'main_test_file 1:13 <name> expected near \'self\'');
      assert.strictEqual(errorsOf(lines('function guy.', '  x = 1', 'end'))[0], 'main_test_file 1:13 <name> expected near \'x\'');
    });

    it('parses again no statement whose function values had 8 statements parsed again, and keeps the first error', () => {
      const errors = errorsOf(nestedInFunctionValues(12, 'y = 1\n'));
      // The 8 innermost are parsed again (errors 0 to 7); the 9th from the inside, the first with 8 in its function
      // values, is not (error 8).
      assert.deepStrictEqual([ errors.length, errors[0], errors[7], errors[8], errors[errors.length - 1] ], [
        12,
        'main_test_file 14:6 <expression> expected near \'w\'',
        'main_test_file 28:6 <expression> expected near \'w\'',
        'main_test_file 31:4 unexpected symbol \'=\' near \'3\'',
        'main_test_file 37:4 unexpected symbol \'=\' near \'3\'',
      ]);
    });

    it('parses unfinished statements nested in function values, as many as a cart holds, in under 50 ms', () => {
      // Mocha sets Error.stackTraceLimit to Infinity, so each parse error would copy the parser's whole stack, which is
      // deep here; the server runs with Node's default.
      const stackTraceLimit = Error.stackTraceLimit;
      Error.stackTraceLimit = 10;
      try {
        for (const code of [ nestedInFunctionValues(60, 'a = b + c * d\n'.repeat(900)), nestedInFunctionValues(90, 'y = 1\n', 'x =\ny.z = 2\n'),
          nestedInFunctionValues(150, 'a = b + c * d\n'.repeat(300)) ]) {
          const times = [ 0, 1, 2, 3 ].map(() => {
            const start = performance.now();
            new Parser(testFile(), code).parseChunk();
            return performance.now() - start;
          }).slice(1).sort((a, b) => a - b);
          assert.ok(times[1] < 50, `${times[1]} ms`);
        }
      } finally {
        Error.stackTraceLimit = stackTraceLimit;
      }
    });
  });

  describe('a table, an argument list or an index left open', () => {
    it('closes at a statement no more indented than its line, and keeps what it has', () => {
      check(lines('t = {', '  a = 1,', 'function _update()', 'end'), [ 'main_test_file 1:4 \'}\' expected (to close \'{\' at line 1) near \'function\'' ],
        [ 't [Table]', '  a [Field]', '_update() [Function]' ]);
      check(lines('t = {', '  a = 1', 'function _update()', 'end'), [ 'main_test_file 1:4 \'}\' expected (to close \'{\' at line 1) near \'function\'' ],
        [ 't [Table]', '  a [Field]', '_update() [Function]' ]);
      check(lines('t = {', '  a =', 'local x = 1'), [ 'main_test_file 2:5 <expression> expected near \'local\'' ], [ 't [Table]', 'x [Variable]' ]);
      check(lines('function f()', '  t = {', '    a = 1,', '  local b = 2', 'end'),
        [ 'main_test_file 2:6 \'}\' expected (to close \'{\' at line 2) near \'local\'' ], [ 'f() [Function]', '  b [Variable]', 't [Table]', '  a [Field]' ]);
      check(lines('foo(a,', 'if b then end'), [ 'main_test_file 1:3 \')\' expected (to close \'(\' at line 1) near \'if\'' ], []);
      check(lines('x = a[i', 'local y = 1'), [ 'main_test_file 1:5 \']\' expected (to close \'[\' at line 1) near \'local\'' ], [ 'x [Variable]', 'y [Variable]' ]);
    });

    it('closes at end, else, elseif or until no more indented than its line, and keeps what it has', () => {
      check(lines('function _init()', '  player = {', '    x = 64,', 'end'),
        [ 'main_test_file 2:11 \'}\' expected (to close \'{\' at line 2) near \'end\'' ], [ '_init() [Function]', 'player [Table]', '  x [Field]' ]);
      check(lines('function _init()', '  player = {', '    x = 64,', '  end'),
        [ 'main_test_file 2:11 \'}\' expected (to close \'{\' at line 2) near \'end\'' ], [ '_init() [Function]', 'player [Table]', '  x [Field]' ]);
      check(lines('if a then', '  t = {', 'else', 'end'), [ 'main_test_file 2:6 \'}\' expected (to close \'{\' at line 2) near \'else\'' ], [ 't [Table]' ]);
      check(lines('repeat', '  t = {', '    a = 1,', 'until done'),
        [ 'main_test_file 2:6 \'}\' expected (to close \'{\' at line 2) near \'until\'' ], [ 't [Table]', '  a [Field]' ]);
      check(lines('function f()', '  t = {', '    a =', 'end'), [ 'main_test_file 3:7 <expression> expected near \'end\'' ], [ 'f() [Function]', 't [Table]' ]);
      check(lines('function f()', '  print("x",', 'end'), [ 'main_test_file 2:7 \')\' expected (to close \'(\' at line 2) near \'end\'' ], [ 'f() [Function]' ]);
      check(lines('if a then', '  f(1,', 'elseif b then', 'end'), [ 'main_test_file 2:3 \')\' expected (to close \'(\' at line 2) near \'elseif\'' ], []);
      check(lines('repeat', '  f(', 'until x'), [ 'main_test_file 2:3 \')\' expected (to close \'(\' at line 2) near \'until\'' ], []);
      check(lines('function f()', '  x = a[i', 'end'), [ 'main_test_file 2:7 \']\' expected (to close \'[\' at line 2) near \'end\'' ], [ 'f() [Function]', 'x [Variable]' ]);
      check(lines('if a then', '  x = t[1', 'else', 'end'), [ 'main_test_file 2:7 \']\' expected (to close \'[\' at line 2) near \'else\'' ], [ 'x [Variable]' ]);
      check(lines('function f()', '  t = {', '    a = g(', 'end'),
        [ 'main_test_file 3:9 \')\' expected (to close \'(\' at line 3) near \'end\'' ], [ 'f() [Function]', 't [Table]', '  a [Field]' ]);
      check(lines('if a then', '  t = {', 'elseif b then', '  y = 1', 'end'),
        [ 'main_test_file 2:6 \'}\' expected (to close \'{\' at line 2) near \'elseif\'' ], [ 't [Table]', 'y [Variable]' ]);
      check(lines('if a then', '  f(1,', 'else', '  y = 1', 'end'), [ 'main_test_file 2:3 \')\' expected (to close \'(\' at line 2) near \'else\'' ], [ 'y [Variable]' ]);
      check(lines('if a then', '  x = t[', 'elseif b then', '  y = 1', 'end'),
        [ 'main_test_file 2:7 \']\' expected (to close \'[\' at line 2) near \'elseif\'' ], [ 'x [Variable]', 'y [Variable]' ]);
    });

    it('reports only the function left open when else, elseif or until closes the bracket around it', () => {
      check(lines('if a then', '  f(function()', 'else', '  y = 1', 'end'),
        [ 'main_test_file 2:4 \'end\' expected (to close \'function\' at line 2) near \'else\'' ], [ '<anonymous function>() [Function]', 'y [Variable]' ]);
      check(lines('if a then', '  f(function()', 'elseif b then', '  y = 1', 'end'),
        [ 'main_test_file 2:4 \'end\' expected (to close \'function\' at line 2) near \'elseif\'' ], [ '<anonymous function>() [Function]', 'y [Variable]' ]);
      check(lines('repeat', '  f(function()', 'until x'),
        [ 'main_test_file 2:4 \'end\' expected (to close \'function\' at line 2) near \'until\'' ], [ '<anonymous function>() [Function]' ]);
    });

    it('closes at the end of the file, keeping the statement and the error at the end', () => {
      check(lines('x = 1', 'foo(a,'), [ 'main_test_file 2:5 \')\' expected near \'<eof>\'' ], [ 'x [Variable]' ]);
      check('x = f(1', [ 'main_test_file 1:6 \')\' expected near \'<eof>\'' ], [ 'x [Variable]' ]);
      check('x = (a', [ 'main_test_file 1:5 \')\' expected near \'<eof>\'' ], [ 'x [Variable]' ]);
      check(lines('t = {', '  a = 1,'), [ 'main_test_file 2:7 \'}\' expected near \'<eof>\'' ], [ 't [Table]', '  a [Field]' ]);
      check('x = a[', [ 'main_test_file 1:5 \']\' expected near \'<eof>\'' ], [ 'x [Variable]' ]);
    });

    it('closes a bracket left open in the header of a while, a for, an if or an elseif at the line below, which starts the block', () => {
      check(lines('function g()', '  while f(', '    x = 1', '  end', 'end'),
        [ 'main_test_file 2:9 \')\' expected (to close \'(\' at line 2) near \'x\'' ], [ 'g() [Function]', 'x [Variable]' ]);
      check(lines('function g()', '  for k in pairs(', '    x = 1', '  end', 'end'),
        [ 'main_test_file 2:16 \')\' expected (to close \'(\' at line 2) near \'x\'' ], [ 'g() [Function]', 'x [Variable]' ]);
      check(lines('function g()', '  if h(a,', '    x = 1', '  end', 'end'),
        [ 'main_test_file 2:6 \')\' expected (to close \'(\' at line 2) near \'x\'' ], [ 'g() [Function]', 'x [Variable]' ]);
      check(lines('if a then', '  y = 1', 'elseif h(a,', '  x = 1', 'end'),
        [ 'main_test_file 3:8 \')\' expected (to close \'(\' at line 3) near \'x\'' ], [ 'y [Variable]', 'x [Variable]' ]);
      check(lines('pico-8 cartridge // http://www.pico-8.com', 'version 42', '__lua__', 'function g()', '  while f(', '    x = 1', '  end', 'end', '__gfx__', ''),
        [ 'main_test_file 5:9 \')\' expected (to close \'(\' at line 5) near \'x\'' ], [ 'g() [Function]', 'x [Variable]' ]);
      check(lines('function g()', '  while f(', '    local y = 1', '  end', 'end'),
        [ 'main_test_file 2:9 \')\' expected (to close \'(\' at line 2) near \'local\'' ], [ 'g() [Function]', '  y [Variable]' ]);
      check(lines('function g()', '  for k in pairs(', '    if k then x = 1 end', '  end', 'end'),
        [ 'main_test_file 2:16 \')\' expected (to close \'(\' at line 2) near \'if\'' ], [ 'g() [Function]', 'x [Variable]' ]);
      check(lines('function g()', '  if h(a,', '    for i = 1, 2 do x = 1 end', '  end', 'end'),
        [ 'main_test_file 2:6 \')\' expected (to close \'(\' at line 2) near \'for\'' ], [ 'g() [Function]', 'x [Variable]' ]);
      check(lines('if a then', '  y = 1', 'elseif h(a,', '  return', 'end'),
        [ 'main_test_file 3:8 \')\' expected (to close \'(\' at line 3) near \'return\'' ], [ 'y [Variable]' ]);
      check(lines('function f()', 'if f(a,', 'local z = 1', 'else', 'y = 2', 'end', 'end'),
        [ 'main_test_file 2:4 \')\' expected (to close \'(\' at line 2) near \'local\'' ], [ 'f() [Function]', '  z [Variable]', 'y [Variable]' ]);
    });

    it('closes an index left open before its key', () => {
      check(lines('x = a[', 'local y = 1'), [ 'main_test_file 1:5 \']\' expected (to close \'[\' at line 1) near \'local\'' ], [ 'x [Variable]', 'y [Variable]' ]);
      check(lines('repeat', '  x = t[', 'until x'), [ 'main_test_file 2:7 \']\' expected (to close \'[\' at line 2) near \'until\'' ], [ 'x [Variable]' ]);
    });

    it('reports only the innermost of the brackets a statement closes', () => {
      check(lines('t = {', '  a = {', '    b = 1,', 'function _update()', 'end'),
        [ 'main_test_file 2:6 \'}\' expected (to close \'{\' at line 2) near \'function\'' ],
        [ 't [Table]', '  a [Table]', '    b [Field]', '_update() [Function]' ]);
    });

    it('reports only the bracket when the statement around it fails where the bracket closed', () => {
      check(lines('if f(a,', 'local x = 1'), [ 'main_test_file 1:4 \')\' expected (to close \'(\' at line 1) near \'local\'' ], [ 'x [Variable]' ]);
      check(lines('for k,v in pairs(b', 'if x then end'), [ 'main_test_file 1:16 \')\' expected (to close \'(\' at line 1) near \'if\'' ], []);
      check(lines('function f()', '  if g(a,', 'end'), [ 'main_test_file 2:6 \')\' expected (to close \'(\' at line 2) near \'end\'' ], [ 'f() [Function]' ]);
      check(lines('if (border(t', 'if (a) b()'), [ 'main_test_file 1:10 \')\' expected (to close \'(\' at line 1) near \'if\'' ], []);
      check(lines('x = f(', '  a,', '  {', '    b = 1,', '  local y = 1'),
        [ 'main_test_file 3:2 \'}\' expected (to close \'{\' at line 3) near \'local\'' ], [ 'y [Variable]' ]);
      check(lines('t = {', '  a = f(', '    {', '      b = 1,', '  local y = 1'),
        [ 'main_test_file 3:4 \'}\' expected (to close \'{\' at line 3) near \'local\'' ], [ 'y [Variable]' ]);
    });

    // Unchanged from before: these pass before the change too.
    it('reports a statement that fails at its first token apart from the statement before it, which stopped there', () => {
      check(lines('x = 1 +', ')'), [ 'main_test_file 1:7 <expression> expected near \')\'', 'main_test_file 2:0 unexpected symbol \')\' near \'<eof>\'' ],
        [ 'x [Variable]' ]);
    });

    // Unchanged from before: these pass before the change too.
    it('leaves a statement indented deeper than the opening line, and code that closes its brackets, as they are', () => {
      check(lines('function f()', '  t = {', '    a = 1,', '    local b = 2', '  }', 'end'),
        [ 'main_test_file 3:10 \'}\' expected near \'local\'', 'main_test_file 5:2 unexpected symbol \'}\' near \'end\'' ], [ 'f() [Function]', '  b [Variable]' ]);
      check(lines('function f()', '  t = {', '    a = 1,', '    end'), [ 'main_test_file 3:10 \'}\' expected near \'end\'' ], [ 'f() [Function]' ]);
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
