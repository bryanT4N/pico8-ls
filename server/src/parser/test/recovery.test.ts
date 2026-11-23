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
      [ '_init() [Function]', '_update() [Function]' ],
    );
  });

  it('resumes at local on the line after x = inside a function', () => {
    check(
      lines('function f()', '  x =', '  local y = 1', 'end'),
      [ 'main_test_file 2:5 <expression> expected near \'local\'' ],
      [ 'f() [Function]', '  y [Variable]' ],
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

  const UNFINISHED_LINES: [string, string][] = [
    [ 't = {', '3:5 <expression> expected near \'function\'' ],
    [ 'foo(', '3:4 <expression> expected near \'function\'' ],
    [ 'print(x', '3:7 \')\' expected near \'function\'' ],
    [ 'x.', '3:2 <name> expected near \'function\'' ],
    [ 'goto', '3:4 <name> expected near \'function\'' ],
    [ 'if x', '3:4 \'then\' expected near \'function\'' ],
    [ 'for i=1,10', '3:10 \'do\' expected near \'function\'' ],
    [ 'function foo', '3:12 \'(\' expected near \'function\'' ],
    [ 'x = 1 +', '3:7 <expression> expected near \'function\'' ],
    [ 'local x =', '3:9 <expression> expected near \'function\'' ],
  ];
  for (const [ unfinished, error ] of UNFINISHED_LINES) {
    it(`keeps the function on the line after ${unfinished}`, () => {
      check(
        lines('function _init()', 'end', unfinished, 'function _update()', 'end'),
        [ `main_test_file ${error}` ],
        [ '_init() [Function]', '_update() [Function]' ],
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
