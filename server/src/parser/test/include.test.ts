import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { analyze } from '../analysis/binder';
import { CallExpression, Identifier, StringLiteral } from '../expressions';
import ResolvedFile, { fileText, FileResolver, RealFileResolver, resolveIncludeFile } from '../file-resolver';
import { AssignmentStatement, CallStatement, FunctionDeclaration, IfStatement, Statement } from '../statements';
import { formatError, parse, parseInChild, TestFilesResolver } from './test-utils';

const lines = (...l: string[]) => l.join('\n');
const statementsOf = (chunk: { block: { body: { type: string, included?: boolean }[] } }) =>
  chunk.block.body.map(s => s.type + (s.included ? '*' : ''));

const parseWith = (code: string, files: Record<string, string>) =>
  parse(code, { includeFileResolver: new TestFilesResolver(files) });

const assignedNames = (body: Statement[]) => body
  .filter((s): s is AssignmentStatement => s.type === 'AssignmentStatement')
  .map(s => (s.variables[0] as Identifier).name);

const errnoError = (message: string, code: string) => Object.assign(new Error(message), { code });

const throwing = (error: Error) => (): never => {
  throw error;
};

describe('#include', function () {
  this.timeout(30000);

  const LOOPS: [string, Record<string, string>, string, string[]][] = [
    [
      'does not include again a file whose last line includes it, which is a plain # there',
      { 'a.lua': 'x = 1\n#include a.lua' },
      'a.lua 2:0',
      [ 'IncludeStatement', 'AssignmentStatement*', 'CallStatement' ],
    ],
    [
      'does not include again a file whose last line includes it with a newline after it',
      { 'a.lua': 'x = 1\n#include a.lua\n' },
      'a.lua 2:0',
      [ 'IncludeStatement', 'AssignmentStatement*', 'CallStatement' ],
    ],
    [
      'does not include again a file whose last line includes it with a comment after it',
      { 'a.lua': 'x = 1\n#include a.lua\n-- bye' },
      'a.lua 2:0',
      [ 'IncludeStatement', 'AssignmentStatement*', 'CallStatement' ],
    ],
    [
      'does not include again a file that is only an #include of itself',
      { 'a.lua': '#include a.lua' },
      'a.lua 1:0',
      [ 'IncludeStatement', 'CallStatement' ],
    ],
    [
      'does not include a file that an included file includes on its last line',
      { 'a.lua': 'x = 1\n#include b.lua', 'b.lua': 'y = 2\n#include a.lua' },
      'a.lua 2:0',
      [ 'IncludeStatement', 'AssignmentStatement*', 'CallStatement' ],
    ],
  ];
  for (const [ name, files, place, statements ] of LOOPS) {
    it(name, () => {
      const result = parseInChild('#include a.lua\nprint(1)', files);
      assert.strictEqual(result.threw, null);
      assert.deepStrictEqual(result.errors, [ `${place} unexpected symbol '#' near 'include'` ]);
      assert.deepStrictEqual(result.statements, statements);
    });
  }

  it('reads a file that the cart includes on its last line, with no line break after it, once', () => {
    const result = parseInChild('print(1)\n#include a.lua', { 'a.lua': 'x = 1' });
    assert.strictEqual(result.threw, null);
    assert.deepStrictEqual(result.errors, []);
    assert.deepStrictEqual(result.statements, [ 'CallStatement', 'IncludeStatement', 'AssignmentStatement*' ]);
  });

  it('pastes an included file in as PICO-8 does: blocks may open in one file and close in the other, and a file may give a value', () => {
    const errorsFor = (code: string, files: Record<string, string>) => parseWith(code, files).errors.map(formatError);
    assert.deepStrictEqual(errorsFor('#include a.lua\nend\nf()', { 'a.lua': 'function f()\nprinth("in f")\n' }), []);
    assert.deepStrictEqual(errorsFor('a=1\n#include a.lua\nend', { 'a.lua': 'if a then\nprinth("in if")\n' }), []);
    assert.deepStrictEqual(errorsFor('function f()\nprinth("in f")\n#include a.lua\nf()', { 'a.lua': 'end\n' }), []);
    assert.deepStrictEqual(errorsFor('#include a.lua\n3}\nprinth(#t)', { 'a.lua': 't={1,\n2,\n' }), []);
    assert.deepStrictEqual(errorsFor('x=\n#include val.lua\nprinth(x)', { 'val.lua': '42' }), []);
    assert.deepStrictEqual(errorsFor('x = 1 +\n#include val.lua\nprinth(x)', { 'val.lua': '2\n' }), []);
    assert.deepStrictEqual(errorsFor('printh(\n#include val.lua\n)', { 'val.lua': '42\n' }), []);
    assert.deepStrictEqual(errorsFor('printh("a")\n#include a.lua\nprinth("c")', { 'a.lua': 'if a then\nprinth("x")\n' }),
      [ 'main_test_file 3:10 \'end\' expected (to close \'if\' at line 1 in a.lua) near \'<eof>\'' ]);
  });

  it('reads a line break before an included file and after it, where its #include line is, and nothing more', () => {
    const called = parseWith('function f() end\n#include a.lua\n(f)()', { 'a.lua': 'x=f' });
    assert.deepStrictEqual([ called.errors, statementsOf(called) ], [[], [ 'FunctionDeclaration', 'IncludeStatement', 'AssignmentStatement*' ]]);
    const printed = parseWith('#include a.lua\nprinth("ok")', { 'a.lua': '?"a"' });
    assert.deepStrictEqual([ printed.errors, statementsOf(printed) ], [[], [ 'IncludeStatement', 'CallStatement*', 'CallStatement' ]]);
    const oneLine = parseWith('#include a.lua\nprinth(x)', { 'a.lua': 'a=1\nif (a) x=1' });
    assert.deepStrictEqual([ oneLine.errors, statementsOf(oneLine) ], [[], [ 'IncludeStatement', 'AssignmentStatement*', 'IfStatement*', 'CallStatement' ]]);
    assert.deepStrictEqual(parseWith('if (a)\n#include b.lua', { 'b.lua': 'x=1' }).errors.map(formatError), [ 'b.lua 1:0 \'then\' expected near \'x\'' ]);
  });

  it('keeps no statement for an #include read in the middle of a statement, and lists its file', () => {
    const chunk = parseWith('x=\n#include val.lua\nprinth(x)', { 'val.lua': '42' });
    assert.deepStrictEqual(statementsOf(chunk), [ 'AssignmentStatement', 'CallStatement' ]);
    assert.deepStrictEqual(chunk.includes!.map(include => include.stmt.filename), [ 'val.lua' ]);
  });

  it('reports an error in a file pasted in on its line in that file, and one after the file in the cart', () => {
    const errorsFor = (code: string, files: Record<string, string>) => parseWith(code, files).errors.map(formatError);
    assert.deepStrictEqual(errorsFor('printh("a")\n-->8\n\n\n#include a.lua\nprinth("c")', { 'a.lua': 'printh("in a")\nx = = 1\n' }),
      [ 'a.lua 2:4 <expression> expected near \'=\'' ]);
    assert.deepStrictEqual(errorsFor('#include lib.lua\nx = = 1', { 'lib.lua': 'printh("lib")\n' }), [ 'main_test_file 2:4 <expression> expected near \'=\'' ]);
  });

  it('ends a node that runs from one file into another at the #include line of the file it runs into, or at the end of the included file it starts in', () => {
    const at = ({ filename, line, column }: { filename: ResolvedFile, line: number, column: number }) => `${filename.path} ${line}:${column}`;
    const range = (node: Statement) => `${at(node.loc!.start)}-${at(node.loc!.end)}`;
    const opened = parseWith('#include a.lua\nend\nx = 1', { 'a.lua': 'function f()\nprinth("in f")\n' }).block.body;
    assert.deepStrictEqual(opened.map(range), [ 'main_test_file 1:0-main_test_file 1:14', 'a.lua 1:0-a.lua 3:0', 'main_test_file 3:0-main_test_file 3:5' ]);
    const closed = parseWith('function f()\nprinth("in f")\n#include a.lua\nf()', { 'a.lua': 'end\n' }).block.body;
    assert.deepStrictEqual(closed.map(range), [ 'main_test_file 1:0-main_test_file 3:14', 'main_test_file 4:0-main_test_file 4:3' ]);
    const valued = parseWith('x=\n#include val.lua\nprinth(x)', { 'val.lua': '42' }).block.body;
    assert.deepStrictEqual(valued.map(range), [ 'main_test_file 1:0-main_test_file 2:16', 'main_test_file 3:0-main_test_file 3:9' ]);
  });

  it('goes on with a long string or comment that an included file leaves open after its #include line, as PICO-8 pastes the text in', () => {
    const read = (code: string, files: Record<string, string>) => {
      const chunk = parseWith(code, files);
      const assignment = chunk.block.body.find((s): s is AssignmentStatement => s.type === 'AssignmentStatement');
      return [ chunk.errors.map(formatError), statementsOf(chunk), (assignment?.init[0] as StringLiteral | undefined)?.value ];
    };
    assert.deepStrictEqual(read('#include a.lua\nxy]]\nprinth(s)', { 'a.lua': 's=[[ab\n' }),
      [[], [ 'IncludeStatement', 'AssignmentStatement*', 'CallStatement' ], 'ab\n\n\n\nxy' ]);
    const joined = parseWith('#include a.lua\nxy]]', { 'a.lua': 's=[[abcdefghijklmnopqrstuvwxyz\n' }).block.body[1] as AssignmentStatement;
    assert.strictEqual((joined.init[0] as StringLiteral).raw, '[[abcdefghijklmnopqrstuvwxyz\n');
    const around = parseWith('x=\n#include a.lua\n]]', { 'a.lua': '[[abc' }).block.body[0].loc!;
    assert.deepStrictEqual([ around.start.line, around.end.filename.path, around.end.line, around.end.column ], [ 1, 'main_test_file', 3, 2 ]);
    assert.deepStrictEqual(read('#include a.lua\nc\n#include b.lua\nprinth(s)', { 'a.lua': 's=[[a', 'b.lua': 'b]]\n' }),
      [[], [ 'IncludeStatement', 'AssignmentStatement*', 'CallStatement' ], 'a\n\n\nc\nb' ]);
    assert.deepStrictEqual(read('#include a.lua\nprinth("hidden")\n]]\nprinth("ok")', { 'a.lua': '--[[\n' }),
      [[], [ 'IncludeStatement', 'CallStatement' ], undefined ]);
    assert.deepStrictEqual(read('#include a.lua\n#include b.lua\nprinth(x)', { 'a.lua': '--[[\n', 'b.lua': ']]\nx=1\n' }),
      [[], [ 'IncludeStatement', 'IncludeStatement', 'AssignmentStatement*', 'CallStatement' ], 1 ]);
    assert.deepStrictEqual(read('#include a.lua\n#include nope.lua\n]]\nprinth("ok")', { 'a.lua': '--[[\n' })[0],
      [ 'main_test_file 2:0 Can\'t #include "nope.lua" from main_test_file: File does not exist' ]);
    assert.deepStrictEqual(read('#include a.lua\nprinth(s)', { 'a.lua': 's=[[abc\n' })[0],
      [ 'a.lua 1:2 unfinished long string (starting at line 1) near \'<eof>\'' ]);
  });

  it('reads an #include line only where the cart\'s own text, read alone, is outside a long string or comment, as PICO-8 does', () => {
    const read = (code: string, files: Record<string, string>): [string[], unknown] => {
      const chunk = parseWith(code, files);
      const assignment = chunk.block.body.find((s): s is AssignmentStatement => s.type === 'AssignmentStatement');
      return [ chunk.errors.map(formatError), (assignment?.init[0] as StringLiteral | undefined)?.value ];
    };
    assert.deepStrictEqual(read('#include a.lua\n--[[\n#include nope.lua\n]]\nprinth("ok")', { 'a.lua': 's=[[abc\n' }),
      [[], 'abc\n\n\n\n--[[\n#include nope.lua\n' ]);
    assert.deepStrictEqual(read('#include a.lua\nx=[[\n#include nope.lua\n]]\nprinth("ok")', { 'a.lua': '--[[\n' }), [[], undefined ]);
    assert.deepStrictEqual(read('#include a.lua\n--[==[\n]]\n#include nope.lua\n]==]\nprinth("ok")', { 'a.lua': 's=[[abc\n' })[0][0],
      'main_test_file 4:0 unexpected symbol \'#\' near \'include\'');
    const opensHere = '#include a.lua\n--[==[\n]]\n--[[\n]==]\n';
    assert.deepStrictEqual(read(opensHere + '#include nope.lua\n]]\nprinth("ok")', { 'a.lua': 's=[[\n' })[0],
      [ 'main_test_file 6:0 Can\'t #include "nope.lua" from main_test_file: File does not exist' ]);
    assert.deepStrictEqual(read(opensHere + '#include b.lua\nprinth("ok")', { 'a.lua': 's=[[\n', 'b.lua': ']]\n' })[0], []);
    const unclosed = parseWith(opensHere + '#include b.lua\nprinth("x")', { 'a.lua': 's=[[\n', 'b.lua': 'y=1\n' }).errors;
    assert.deepStrictEqual([ unclosed.map(formatError), unclosed[0].bounds.end.line, unclosed[0].bounds.end.column ],
      [[ 'main_test_file 4:0 unfinished long comment (starting at line 4) near \'<eof>\'' ], 7, 11 ]);
    assert.deepStrictEqual(read('#include x[[.lua\n#include nope.lua', { 'x[[.lua': 'a=1' })[0],
      [ 'main_test_file 2:0 Can\'t #include "nope.lua" from main_test_file: File does not exist' ]);
    for (const above of [ 's="[["', 's=\'[[\'', '-- [[', '// [[', '//[[' ]) {
      assert.deepStrictEqual(read(above + '\n#include nope.lua', {})[0], [ 'main_test_file 2:0 Can\'t #include "nope.lua" from main_test_file: File does not exist' ], above);
    }
  });

  it('finds #include lines past a string\'s \\z, and past its \\ and an LF or a CRLF, as PICO-8 does, a lone CR being dropped; a string that a \\z takes past an #include line or the end of a pasted file goes on in the text that comes next', () => {
    const read = (code: string, files: Record<string, string>): [string[], unknown] => {
      const chunk = parseWith(code, files);
      const assignment = chunk.block.body.find((s): s is AssignmentStatement => s.type === 'AssignmentStatement');
      return [ chunk.errors.map(formatError), (assignment?.init[0] as StringLiteral | undefined)?.value ];
    };
    assert.deepStrictEqual(read('s="a\\z\n#include b.lua\n"\nprinth(s)', { 'b.lua': 'printh("in b")\n' }), [[
      'main_test_file 3:0 unexpected string \'\' near \'printh\'', 'main_test_file 3:0 unfinished string near \'"\'',
      'b.lua 1:8 unexpected keyword \'in\' near \'b\'', 'b.lua 1:12 unfinished string near \'")\'',
    ], 'aprinth(' ]);
    assert.deepStrictEqual(read('s="a\\z\n[["\n#include nope.lua\nprinth("ok")', {}), [[ 'main_test_file 3:0 unexpected symbol \'#\' near \'include\'' ], 'a[[' ]);
    assert.deepStrictEqual(read('s="a\\z\n#include nope.lua"\nprinth(s)', {})[0], [
      'main_test_file 1:2 unfinished string near \'"a\\z\n\'', 'main_test_file 2:0 Can\'t #include "nope.lua"" from main_test_file: File does not exist',
    ]);
    assert.deepStrictEqual(read('s="a\\\n#include nope.lua\\\n"\nprinth(s)', {}), [[], 'a\n#include nope.lua\n' ]);
    for (const lineBreak of [ '\n', '\r\n', '\n\r' ]) {
      assert.deepStrictEqual(read(`s="a\\${lineBreak}[["\n#include nope.lua`, {})[0],
        [ 'main_test_file 3:0 Can\'t #include "nope.lua" from main_test_file: File does not exist' ], JSON.stringify(lineBreak));
    }
    // A lone CR is dropped from a file that is not a cart, so the \ is before the [.
    assert.deepStrictEqual(read('s="a\\\r[["\n#include nope.lua', {}), [[
      'main_test_file 1:2 invalid escape sequence near \'\\[\'', 'main_test_file 3:0 Can\'t #include "nope.lua" from main_test_file: File does not exist',
    ], 'a[[' ]);
    assert.deepStrictEqual(read('#include a.lua\nb"\nprinth(s)', { 'a.lua': 's="a\\z\n' }), [[], 'ab' ]);
    assert.deepStrictEqual(read('#include a.lua\n#include b.lua\nprinth(s)', { 'a.lua': 's="a\\z\n', 'b.lua': '  c"' }), [[], 'ac' ]);
  });

  it('resolves an #include after an included file next to the cart', () => {
    const { errors, block } = parseWith('#include sub/a.lua\n#include b.lua\nprint(1)', {
      'sub/a.lua': 'x = 1',
      'sub/b.lua': 'wrong = 1',
      'b.lua': 'y = 2',
    });
    assert.deepStrictEqual(errors.map(formatError), []);
    assert.deepStrictEqual(assignedNames(block.body), [ 'x', 'y' ]);
  });

  it('reports an #include of a missing file in an included file as a plain # there', () => {
    const { errors } = parseWith('#include a.lua\nprint(1)', { 'a.lua': 'x = 1\n#include nope.lua' });
    assert.deepStrictEqual(errors.map(formatError), [ 'a.lua 2:0 unexpected symbol \'#\' near \'include\'' ]);
  });

  it('keeps a label at the end of its block when an #include of a file with no code follows it', () => {
    const code = 'do\n  goto l\n  local q\n  ::l::\n#include empty.lua\nend';
    assert.deepStrictEqual(parseWith(code, { 'empty.lua': '-- nothing' }).errors.map(formatError), []);
    assert.deepStrictEqual(parseWith(code, { 'empty.lua': 'x = 1' }).errors.map(formatError), [ 'main_test_file 2:2 <goto l> jumps into the scope of local \'q\'' ]);
  });

  it('lists only the main file\'s own #includes', () => {
    const { includes } = parseWith('#include a.lua\nprint(1)', { 'a.lua': 'x = 1\n#include e.lua', 'e.lua': 'e = 1' });
    assert.deepStrictEqual(includes!.map(i => i.stmt.filename), [ 'a.lua' ]);
  });

  it('lists the files that the cart\'s #includes could not find', () => {
    const { unresolvedIncludes } = parseWith('#include a.lua\n#include gone.lua', { 'a.lua': '#include sub/nope.lua\n#include a.lua' });
    assert.deepStrictEqual(unresolvedIncludes!.map(file => file.path), [ 'gone.lua' ]);
  });

  it('ends the last statement of an included file in that file', () => {
    const { block } = parseWith('#include a.lua', { 'a.lua': 'x = 1\ny = 2' });
    const { start, end } = block.body[2].loc!;
    assert.strictEqual(start.filename.path, 'a.lua');
    assert.strictEqual(end.filename.path, 'a.lua');
    assert.deepStrictEqual([ end.line, end.column ], [ 2, 5 ]);
  });

  it('runs a block left open at the end of an included file on into the cart, and reports it open at the cart\'s end', () => {
    const { errors, symbols, block } = parseWith(
      lines('function _init()', '  x = 0', 'end', '#include inc.lua', 'a = 5', 'function _update()', '  x += 1', 'end'),
      { 'inc.lua': 'function typing()\n  local a = 1' },
    );
    assert.deepStrictEqual(errors.map(formatError), [ 'main_test_file 8:0 \'end\' expected (to close \'function\' at line 1 in inc.lua) near \'<eof>\'' ]);
    assert.deepStrictEqual(symbols.map(s => s.name), [ '_init', 'x', '_update' ]);
    assert.strictEqual(block.included, false);
    assert.strictEqual(block.loc!.start.filename.path, 'main_test_file');
    assert.deepStrictEqual(statementsOf(block.body[2] as FunctionDeclaration), [ 'LocalStatement*', 'AssignmentStatement', 'FunctionDeclaration' ]);
  });

  it('keeps an #include whose file starts with a lexical error', () => {
    const { block, includes } = parseWith('#include a.lua\nprint(1)', { 'a.lua': '"abc' });
    assert.strictEqual(block.body[0], includes![0].stmt);
  });

  it('ends a one-line if at the end of an included file there', () => {
    const chunk = parseWith('#include inc.lua\nfunction _update()\nend', { 'inc.lua': 'if (a) b()' });
    assert.deepStrictEqual(chunk.errors.map(formatError), []);
    assert.deepStrictEqual(statementsOf(chunk), [ 'IncludeStatement', 'IfStatement*', 'FunctionDeclaration' ]);
  });

  it('reports a return that ends a cart from a file the cart includes, and the code after a return in an included file', () => {
    const files = { 'lib.lua': 'x=1\nreturn x', 'e.lua': '' };
    const cart = 'pico-8 cartridge // http://www.pico-8.com\nversion 42\n__lua__\n';
    const cartErrors = (code: string) => parse(cart + code, { filename: 'main.p8', includeFileResolver: new TestFilesResolver(files) }).errors.map(formatError);
    assert.deepStrictEqual(cartErrors('printh("ok")\n#include lib.lua'), [ 'lib.lua 2:0 PICO-8 does not accept a return in the cart\'s outermost block' ]);
    assert.deepStrictEqual(cartErrors('printh("ok")\nreturn\n#include e.lua'), [ 'main.p8 5:0 PICO-8 does not accept a return in the cart\'s outermost block' ]);
    assert.deepStrictEqual(cartErrors('function f()\n#include lib.lua\nend'), []);
    assert.deepStrictEqual(cartErrors('#include lib.lua\nprinth(x)'), [ 'main.p8 5:0 \'<eof>\' expected near \'printh\'' ]);
    const stopped = parseWith('#include lib.lua\nprinth(x)', { 'lib.lua': '-- lib\nreturn 1\nx=2' });
    assert.deepStrictEqual([ stopped.errors.map(formatError), stopped.includedComments!.map(comment => comment.raw) ],
      [[ 'lib.lua 3:0 \'<eof>\' expected near \'x\'' ], [ '-- lib' ]]);
  });

  it('splices an #include inside a function body into the function, whose body starts at the #include line', () => {
    const { errors, block } = parseWith('function f()\n#include body.lua\nend', { 'body.lua': 'x = 1\ny = 2' });
    assert.deepStrictEqual(errors.map(formatError), []);
    const body = (block.body[0] as FunctionDeclaration).block;
    assert.deepStrictEqual(statementsOf(block.body[0] as FunctionDeclaration), [ 'IncludeStatement', 'AssignmentStatement*', 'AssignmentStatement*' ]);
    assert.deepStrictEqual([ body.included, body.loc!.start.filename.path, body.loc!.start.line, body.loc!.start.column ], [ false, 'main_test_file', 2, 0 ]);
  });

  const UNREADABLE: [string, Partial<FileResolver>, string][] = [
    [ 'reading it fails', { loadFileContents: throwing(errnoError('EACCES: permission denied, open \'inc.lua\'', 'EACCES')) }, 'EACCES' ],
    [ 'checking it fails', { isFile: throwing(errnoError('ENOENT: no such file or directory, stat \'inc.lua\'', 'ENOENT')) }, 'ENOENT' ],
    [ 'reading it fails without an error code', { loadFileContents: throwing(new Error('locked')) }, 'locked' ],
  ];
  for (const [ how, failing, reason ] of UNREADABLE) {
    it(`reports an #included file when ${how}`, () => {
      const resolver = Object.assign(new TestFilesResolver({ 'inc.lua': 'x = 1' }), failing);
      const chunk = parse('#include inc.lua\nfunction f() end', { includeFileResolver: resolver });
      assert.deepStrictEqual(chunk.errors.map(formatError), [ `main_test_file 1:0 Can't #include "inc.lua" from main_test_file: File cannot be read (${reason})` ]);
      assert.deepStrictEqual(statementsOf(chunk), [ 'IncludeStatement', 'FunctionDeclaration' ]);
      assert.deepStrictEqual(chunk.unresolvedIncludes!.map(file => file.path), [ 'inc.lua' ]);
    });
  }

  it('parses 256 #included files and reports the next one', () => {
    const errorsFor = (includes: number) => parseWith('#include a.lua\n'.repeat(includes), { 'a.lua': 'x = 1' }).errors.map(formatError);
    assert.deepStrictEqual(errorsFor(256), []);
    assert.deepStrictEqual(errorsFor(257), [ 'main_test_file 257:0 too many #includes (limit is 256)' ]);
  });

  it('stops a tree of #includes that doubles at every level', () => {
    const files: Record<string, string> = { 'f21.lua': 'x = 1' };
    for (let i = 1; i <= 20; i++) {
      files[`f${i}.lua`] = `#include f${i + 1}.lua\n#include f${i + 1}.lua`;
    }
    const result = parseInChild('#include f1.lua\nprint(x)', files);
    assert.strictEqual(result.threw, null);
    assert.deepStrictEqual(result.errors, [ 'f1.lua 1:0 unexpected symbol \'#\' near \'include\'', 'f1.lua 2:0 unexpected symbol \'#\' near \'include\'' ]);
  });

  it('accepts an empty included file', () => {
    const { errors } = parseWith('#include e.lua\nx = 1', { 'e.lua': '' });
    assert.deepStrictEqual(errors.map(formatError), []);
  });

  it('treats a symlink to a file as a file', function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pico8-ls-'));
    try {
      const real = path.join(dir, 'real.lua');
      const link = path.join(dir, 'link.lua');
      fs.writeFileSync(real, 'x = 1');
      try {
        fs.symlinkSync(real, link);
      } catch {
        this.skip();
      }
      assert.strictEqual(new RealFileResolver().isFile(link), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const disk = (onDiskName: (p: string) => string | undefined): FileResolver =>
    ({ doesFileExist: () => true, isFile: () => true, loadFileContents: () => '', onDiskName });

  it('spells the names an #include adds as the disk does, and keeps the includer\'s folder as it is', () => {
    const from = ResolvedFile.fromPath(path.resolve('/carts/game/main.p8'));
    const game = path.resolve('/carts/game');
    assert.strictEqual(resolveIncludeFile(from, 'lib/Util.lua', disk(p => p.toUpperCase())).path, path.join(game, 'LIB', 'UTIL.LUA'));
    assert.strictEqual(resolveIncludeFile(from, '../shared/Lib.lua', disk(p => p.replace('Lib.lua', 'lib.lua'))).path,
      path.join(path.resolve('/carts'), 'shared', 'lib.lua'));
    assert.strictEqual(resolveIncludeFile(from, 'Lib.lua', disk(() => undefined)).path, path.join(game, 'Lib.lua'));
    assert.strictEqual(resolveIncludeFile(from, 'Lib.lua').path, path.join(game, 'Lib.lua'));
  });

  it('spells the names an #include adds as the disk does when the includer\'s folder is a junction, a subst drive or a short name', () => {
    const junction = path.resolve('/carts/link');
    assert.strictEqual(resolveIncludeFile(ResolvedFile.fromPath(path.join(junction, 'main.p8')), 'Lib.lua',
      disk(() => path.resolve('/elsewhere/game/lib.lua'))).path, path.join(junction, 'lib.lua'));
    const drive = path.resolve('/game');
    assert.strictEqual(resolveIncludeFile(ResolvedFile.fromPath(path.join(drive, 'main.p8')), 'Lib.lua',
      disk(() => path.resolve('/carts/real game/lib.lua'))).path, path.join(drive, 'lib.lua'));
    const short = path.resolve('/Users/SOMEON~1/game');
    assert.strictEqual(resolveIncludeFile(ResolvedFile.fromPath(path.join(short, 'main.p8')), '../Shared/Lib.lua',
      disk(() => path.resolve('/Users/Some One/shared/lib.lua'))).path, path.join(path.dirname(short), 'shared', 'lib.lua'));
  });

  it('takes an #include as written when the disk spells a name it adds otherwise than in case', () => {
    const from = ResolvedFile.fromPath(path.resolve('/carts/game/main.p8'));
    const game = path.resolve('/carts/game');
    assert.strictEqual(resolveIncludeFile(from, 'lib/Util.lua', disk(p => p.replace(`${path.sep}lib${path.sep}`, `${path.sep}shared${path.sep}`))).path,
      path.join(game, 'lib', 'Util.lua'));
    assert.strictEqual(resolveIncludeFile(from, 'Lib.lua', disk(() => path.join(game, 'other.lua'))).path, path.join(game, 'Lib.lua'));
    assert.strictEqual(resolveIncludeFile(from, 'lib/Util.lua', disk(() => 'util.lua')).path, path.join(game, 'lib', 'Util.lua'));
  });

  it('reads an #include on Windows as Windows reads a path: without the period that ends a folder, and without the periods and spaces that end the name', function () {
    if (process.platform !== 'win32') {
      this.skip();
    }
    const from = ResolvedFile.fromPath(path.resolve('/carts/game/main.p8'));
    const game = path.resolve('/carts/game');
    const names = [ 'lib.lua.', 'lib.lua..', 'lib.lua. .', 'a.p8 ', 'sub./lib.lua', 'sub .\\lib.lua', 'sub /lib.lua', 'sub../lib.lua', '../lib.lua', './lib.lua' ];
    assert.deepStrictEqual(names.map(name => resolveIncludeFile(from, name).path), [
      path.join(game, 'lib.lua'), path.join(game, 'lib.lua'), path.join(game, 'lib.lua'), path.join(game, 'a.p8'), path.join(game, 'sub', 'lib.lua'),
      path.join(game, 'sub ', 'lib.lua'), path.join(game, 'sub ', 'lib.lua'), path.join(game, 'sub..', 'lib.lua'), path.join(path.resolve('/carts'), 'lib.lua'),
      path.join(game, 'lib.lua'),
    ]);
    const chunk = parseWith('#include lib.lua.\n#include sub./a.lua:1', { 'lib.lua': 'x = 1', 'sub/a.lua': 'y = 2\n-->8\nz = 3' });
    assert.deepStrictEqual([ chunk.errors.map(formatError), assignedNames(chunk.block.body) ], [[], [ 'x', 'z' ]]);
  });

  it('resolves an #include and binds its file under the name the disk gives', () => {
    class CaseResolver extends TestFilesResolver {
      onDiskName(p: string): string | undefined {
        return p === path.normalize('Lib.lua') ? path.normalize('lib.lua') : undefined;
      }
    }
    const chunk = parse('#include Lib.lua\nhelper()', { includeFileResolver: new CaseResolver({ 'lib.lua': 'function helper() end' }) });
    assert.strictEqual(chunk.includes![0].resolvedFile.path, path.normalize('lib.lua'));
    assert.strictEqual(analyze(chunk).includeStarts.has(path.normalize('lib.lua')), true);
  });

  it('takes the rest of the line after #include as the name, less the bytes up to a space and those of other characters than ASCII around it, and quotes it as written in an error', () => {
    const files = { 'lib.lua': 'function helper() end' };
    assert.deepStrictEqual(parseWith('#include lib.lua -- helpers\nhelper()', files).errors.map(formatError), [
      'main_test_file 1:0 Can\'t #include "lib.lua -- helpers" from main_test_file: File does not exist',
    ]);
    assert.deepStrictEqual(parseWith('#include  missing.lua\v ', files).errors.map(formatError), [
      'main_test_file 1:0 Can\'t #include " missing.lua\v " from main_test_file: File does not exist',
    ]);
    // DEL stays (si.pin.trim.trail-del).
    assert.deepStrictEqual(parseWith('#include lib.lua\x7f', files).errors.map(formatError), [
      'main_test_file 1:0 Can\'t #include "lib.lua\x7f" from main_test_file: File does not exist',
    ]);
    for (const line of [ '#include lib.lua ', '#include lib.lua  ', '#include lib.lua\t', '#include  lib.lua', '#include lib.lua\v', '#include \flib.lua',
      '#include lib.lua\x01', '#include \x1flib.lua', '#include lib.lua\u00a0', '#include \u00e9lib.lua\u2605', '#include lib.lua\u00e9' ]) {
      const chunk = parseWith(line + '\nhelper()', files);
      assert.deepStrictEqual([ chunk.errors, statementsOf(chunk) ], [[], [ 'IncludeStatement', 'FunctionDeclaration*', 'CallStatement' ]], JSON.stringify(line));
    }
  });

  it('does not open a name that starts with /, ends with / or \\, or has a character that is not ASCII, as PICO-8 does not, wherever the file is', () => {
    const files = { 'lib.lua': 'function l() end', 'a\u00e9.lua': 'function a() end', 'sub/lib.lua': 'function s() end' };
    const message = (name: string, why: string) => `main_test_file 1:0 Can't #include "${name}" from main_test_file: PICO-8 does not open a name ${why}`;
    const fromFolder = 'that starts with / from the cart\'s folder';
    const endsWith = 'that ends with / or \\';
    for (const [ name, why ] of [[ '/lib.lua', fromFolder ], [ '/sub/lib.lua', fromFolder ], [ 'lib.lua/', endsWith ], [ 'lib.lua\\', endsWith ],
      [ 'a\u00e9.lua', 'with a character that is not ASCII' ], [ '\u00fc/lib.lua', fromFolder ]]) {
      const chunk = parseWith(`#include ${name}`, files);
      assert.deepStrictEqual([ chunk.errors.map(formatError), chunk.unresolvedIncludes!.length ], [[ message(name, why) ], 0 ], name);
    }
    const chunk = parseWith('#include \\lib.lua', files);
    assert.deepStrictEqual([ chunk.errors, statementsOf(chunk) ], [[], [ 'IncludeStatement', 'FunctionDeclaration*' ]]);
  });

  it('reads #include only at the start of a line of the cart, in lower case and followed by a space', () => {
    const files = { 'lib.lua': 'printh("lib")', 'a.lua': 'printh("a")\n#include lib.lua\n' };
    const errorsFor = (code: string) => parseWith(code, files).errors.map(formatError);
    assert.deepStrictEqual(errorsFor('#include a.lua\nprinth("ok")'), [ 'a.lua 2:0 unexpected symbol \'#\' near \'include\'' ]);
    assert.deepStrictEqual(errorsFor('x=1 #include lib.lua'), [ 'main_test_file 1:4 unexpected symbol \'#\' near \'include\'' ]);
    assert.deepStrictEqual(errorsFor('#INCLUDE lib.lua'), [ 'main_test_file 1:0 unexpected symbol \'#\' near \'INCLUDE\'' ]);
    assert.deepStrictEqual(errorsFor('#include'), [ 'main_test_file 1:0 unexpected symbol \'#\' near \'include\'' ]);
    assert.deepStrictEqual(errorsFor('#includelib.lua'), [ 'main_test_file 1:0 unexpected symbol \'#\' near \'includelib\'' ]);
    assert.deepStrictEqual(errorsFor('# include lib.lua'), [ 'main_test_file 1:0 unexpected symbol \'#\' near \'include\'' ]);
    assert.deepStrictEqual(errorsFor('#include\tlib.lua'), [ 'main_test_file 1:0 unexpected symbol \'#\' near \'include\'' ]);
    assert.deepStrictEqual(errorsFor('  #include lib.lua\nfunction f()\n\t#include lib.lua\nend'), []);
  });

  it('includes one tab of another cart as PICO-8 reads its number, hexadecimal from 0, and else the whole cart as its tabs with nothing between them', () => {
    const tabs = Array.from({ length: 11 }, (_, k) => `function t${k}() end`).join('\n-->8\n');
    const other = 'pico-8 cartridge // http://www.pico-8.com\nversion 42\n__lua__\n' + tabs + '\n-->8\nx = = 1\n__gfx__\n0000\n';
    const included = (name: string) => {
      const chunk = parseWith('#include ' + name, { 'other.p8': other });
      return [ chunk.errors.map(formatError), chunk.block.body.filter(s => s.included).map(s => (s as FunctionDeclaration).identifier && ((s as FunctionDeclaration).identifier as Identifier).name) ];
    };
    assert.deepStrictEqual(included('other.p8:0'), [[], [ 't0' ]]);
    assert.deepStrictEqual(included('other.p8:a'), [[], [ 't10' ]]);
    assert.deepStrictEqual(included('other.p8:A'), [[], [ 't10' ]]);
    assert.deepStrictEqual(included('other.p8:b'), [[ 'other.p8 26:4 <expression> expected near \'=\'' ], []]);
    assert.deepStrictEqual(included('other.p8:c'), [[ 'main_test_file 1:0 Can\'t #include "other.p8:c" from main_test_file: other.p8 has no tab 12' ], []]);
    const tab1 = [ 'other.p8:01', 'other.p8:1x', 'other.p8:0x1', 'other.p8:0X1', 'other.p8: 1', 'other.p8:\t1', 'other.p8:+1',
      'other.p8:-ffffffff', 'other.p8:100000001', 'other.p8:10000000000000001', 'other.p8:a.p8:1' ];
    for (const name of tab1) {
      assert.deepStrictEqual(included(name), name === 'other.p8:a.p8:1' ? [[], [ 't10' ]] : [[], [ 't1' ]], JSON.stringify(name));
    }
    assert.deepStrictEqual([ included('other.p8:-0'), included('other.p8:0x0x1') ], [[[], [ 't0' ]], [[], [ 't0' ]]]);
    for (const name of [ 'other.p8:11', 'other.p8:12', 'other.p8:-2', 'other.p8:-10', 'other.p8:-f', 'other.p8:-80000000', 'other.p8:80000001',
      'other.p8:fffffff1', 'other.p8:fffffffe', 'other.p8:ffffffff1' ]) {
      assert.deepStrictEqual(included(name), [[], []], name);
    }
    // The end of each tab and the function of the next are one name, endfunction, as for PICO-8 (si.t28.join.functions.colon).
    const whole = [[
      'main_test_file 1:0 \'end\' expected (to close \'function\' at line 4 in other.p8) near \'<eof>\'',
      'other.p8 6:9 assignment operator expected near \'t1\'',
    ], [ 't0' ]];
    for (const name of [ 'other.p8:', 'other.p8:g', 'other.p8:x1', 'other.p8:0x', 'other.p8:0xg', 'other.p8:-1', 'other.p8:-0x1', 'other.p8:ffffffff',
      'other.p8:fffffffff', 'other.p8:1ffffffff', 'other.p8:ffffffffffffffff' ]) {
      assert.deepStrictEqual(included(name), whole, name);
    }
  });

  it('takes the name up to its first colon as the file, and the rest as a tab of a cart or a .lua file, as PICO-8 does', () => {
    const tabs = (name: string) => [ 0, 1, 2 ].map(k => `function ${name}${k}() end`).join('\n-->8\n');
    const files = {
      'cart.txt': 'pico-8 cartridge // http://www.pico-8.com\nversion 42\n__lua__\n' + tabs('c'),
      'plain.txt': tabs('t'),
      'plain.p8': tabs('p'),
      'tabs.lua': tabs('l'),
      'upper.LUA': tabs('u'),
      'lib.lua': 'function helper() end',
    };
    const included = (name: string) => {
      const chunk = parseWith('#include ' + name, files);
      return [ chunk.errors.map(formatError), chunk.block.body.filter(s => s.included).map(s => ((s as FunctionDeclaration).identifier as Identifier).name) ];
    };
    assert.deepStrictEqual([ included('cart.txt:1'), included('tabs.lua:2'), included('upper.LUA:1') ], [[[], [ 'c1' ]], [[], [ 'l2' ]], [[], [ 'u1' ]]]);
    assert.deepStrictEqual([ included('plain.txt:1'), included('plain.txt:5'), included('plain.p8:1') ],
      [[[], [ 't0', 't1', 't2' ]], [[], [ 't0', 't1', 't2' ]], [[], [ 'p0', 'p1', 'p2' ]]]);
    assert.deepStrictEqual(included('lib.lua:1'), [[ 'main_test_file 1:0 Can\'t #include "lib.lua:1" from main_test_file: lib.lua has no tab 1' ], []]);
    assert.deepStrictEqual(included('x:tabs.lua:1'), [[ 'main_test_file 1:0 Can\'t #include "x:tabs.lua:1" from main_test_file: File does not exist' ], []]);
  });

  describe('reads a file as PICO-8 does', () => {
    const H = 'pico-8 cartridge // http://www.pico-8.com\nversion 42\n__lua__\n';
    const tabs = (...code: string[]) => code.join('\n-->8\n');
    const functions = (code: string, files: Record<string, string>) => {
      const chunk = parseWith(code, files);
      return [ chunk.errors.map(formatError), chunk.block.body.filter(s => s.type === 'FunctionDeclaration').map(s => ((s as FunctionDeclaration).identifier as Identifier).name) ];
    };

    it('takes a file as a cart, whatever its name, when its first line has pico-8 cartridge from its first p on', () => {
      const code = tabs('function t0() end', 'function t1() end');
      const files = { 'a.txt': ' ' + H + code, 'b.txt': 'xx ' + H + code, 'c.txt': 'a=1 -- ' + H + code, 'd.p8': '\t' + H + code,
        'e.txt': 'printh() -- ' + H + code, 'f.txt': '\n' + H + code, 'g.txt': 'PICO-8 cartridge' + H.slice(16) + code };
      for (const name of [ 'a.txt', 'b.txt', 'c.txt', 'd.p8' ]) {
        assert.deepStrictEqual(functions(`#include ${name}:1`, files), [[], [ 't1' ]], name);
      }
      // Read as Lua, the header is a syntax error.
      assert.deepStrictEqual([ 'e.txt', 'f.txt', 'g.txt' ].map(name => functions(`#include ${name}:1`, files)[0][0]), [
        'e.txt 2:8 assignment operator expected near \'42\'',
        'f.txt 2:4 assignment operator expected near \'-\'',
        'g.txt 1:4 assignment operator expected near \'-\'',
      ]);
      assert.deepStrictEqual(functions('xx ' + H + 'function m() end', {}), [[], [ 'm' ]]);
    });

    it('reads a file from the disk without one BOM at its start, as an editor and PICO-8 do, and its places as the editor\'s', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pico8-ls-'));
      try {
        const files = { 'a.lua': '\ufeff-- c\nfunction f() end', 'b.lua': '\ufeff', 'c.txt': '\ufeff' + H + tabs('function t0() end', 'function t1() end'),
          'd.lua': '\ufeff\ufeffx = 1', 'e.lua': '\ufeffy = 1' };
        for (const [ name, text ] of Object.entries(files)) {
          fs.writeFileSync(path.join(dir, name), text);
        }
        const parsed = (code: string) => parse(code, { filename: path.join(dir, 'main.lua'), includeFileResolver: new RealFileResolver() });
        const names = (code: string) => {
          const chunk = parsed(code);
          return [ chunk.errors.map(formatError), chunk.block.body.filter(s => s.type === 'FunctionDeclaration').map(s => ((s as FunctionDeclaration).identifier as Identifier).name) ];
        };
        assert.deepStrictEqual([ names('#include a.lua'), names('#include b.lua'), names('#include c.txt:1') ], [[[], [ 'f' ]], [[], []], [[], [ 't1' ]]]);
        assert.deepStrictEqual(assignedNames(parsed('#include d.lua').block.body), [ '\ufeffx' ]);
        const y = parsed('#include e.lua').block.body[1];
        assert.deepStrictEqual([ y.loc!.start.line, y.loc!.start.column, y.loc!.start.index ], [ 1, 0, 0 ]);
        assert.deepStrictEqual([ fileText(Buffer.from('\ufeffx')), fileText(Buffer.from('\ufeff\ufeffx')) ], [ 'x', '\ufeffx' ]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('reads a lone CR in a cart as a line break that takes the character after it, and a CR at the end of a cart as taking the character before it', () => {
      const files = { 'other.p8': H + 'function a() end\rXfunction b() end\n', 'lib.lu': 'function l() end',
        'sep.p8': H + 'function t0() end\r-->8\rfunction t1() end\r' };
      assert.deepStrictEqual(functions('#include other.p8', files), [[], [ 'a', 'b' ]]);
      assert.deepStrictEqual(functions(H + 'function m() end\n#include lib.lua\r', files), [[], [ 'm', 'l' ]]);
      assert.deepStrictEqual(functions(H + 'x = 1\r', files)[0], [ 'main_test_file 4:2 <expression> expected near \'<eof>\'' ]);
      assert.deepStrictEqual(functions('#include sep.p8:1', files)[0], [ 'main_test_file 1:0 Can\'t #include "sep.p8:1" from main_test_file: sep.p8 has no tab 1' ]);
      const { block: { body } } = parseWith(H + 'x = 1\rXy = 2', {});
      assert.deepStrictEqual([ assignedNames(body), [ body[1].loc!.start.line, body[1].loc!.start.column ]], [[ 'x', 'y' ], [ 5, 1 ]]);
      // The end of the code is the section's start, past the character the CR takes.
      const { errors } = parseWith(H + 'x = \rX__gfx__\n0000\n', {});
      assert.deepStrictEqual(errors.map(e => [ formatError(e), e.bounds.start.index, e.bounds.end.index ]),
        [[ 'main_test_file 5:1 <expression> expected near \'<eof>\'', H.length + 6, H.length + 13 ]]);
    });

    it('drops each lone CR of a file that is not a cart, and keeps the places of the file', () => {
      const files = { 'a.lua': '--\rx = = 1\nfunction two() end', 'b.txt': '--\rfunction one() end\nfunction two() end', 'c.p8': '--\rx = = 1\nfunction two() end',
        'd.lua': 'pri\rnth("z")', 'e.lua': 'x = 1\ry = = 2', 'f.lua': 'function t0() end\r-->8\rfunction t1() end' };
      for (const name of [ 'a.lua', 'b.txt', 'c.p8' ]) {
        assert.deepStrictEqual(functions(`#include ${name}`, files), [[], [ 'two' ]], name);
      }
      const call = parseWith('#include d.lua', files);
      assert.deepStrictEqual([ call.errors, statementsOf(call), (((call.block.body[1] as CallStatement).expression as CallExpression).base as Identifier).name ],
        [[], [ 'IncludeStatement', 'CallStatement*' ], 'printh' ]);
      assert.deepStrictEqual(parseWith('#include e.lua', files).errors.map(formatError), [ 'e.lua 2:4 <expression> expected near \'=\'' ]);
      assert.deepStrictEqual(functions('#include f.lua:1', files)[0], [ 'main_test_file 1:0 Can\'t #include "f.lua:1" from main_test_file: f.lua has no tab 1' ]);
    });

    it('reads the second line of a cart as its version, whatever it holds', () => {
      const noVersion = 'pico-8 cartridge // http://www.pico-8.com\n__lua__\n' + tabs('function t0() end', 'function t1() end');
      const files = { 'other.p8': noVersion, 'hello.p8': H.replace('version 42', 'hello') + 'function h() end' };
      assert.deepStrictEqual([ functions('#include other.p8', files), functions('#include hello.p8', files), functions(noVersion, {}) ],
        [[[], []], [[], [ 'h' ]], [[], []]]);
      assert.deepStrictEqual(functions('#include other.p8:1', files)[0],
        [ 'main_test_file 1:0 Can\'t #include "other.p8:1" from main_test_file: other.p8 has no tab 1' ]);
    });

    it('takes the code of every __lua__ section of a cart, up to a line that starts as another section does, and its tabs across them', () => {
      const cart = H + tabs('function t0() end', 'function t1() end') + '\n__gfx__\n0000\n__lua__\n' + tabs('function u0() end', 'function u1() end') + '\n';
      const files = { 'other.p8': cart };
      assert.deepStrictEqual([ functions('#include other.p8:1', files), functions('#include other.p8:2', files), functions(cart, {}) ],
        [[[], [ 't1', 'u0' ]], [[], [ 'u1' ]], [[], [ 't0', 't1', 'u0', 'u1' ]]]);
      for (const section of [ '__gfx__x', '__meta:title__', '__gfx__', '__label__' ]) {
        assert.deepStrictEqual(functions(H + 'function a() end\n' + section + '\nb c', {}), [[], [ 'a' ]], section);
      }
      for (const line of [ '__GFX__', '__meta__', ' __gfx__' ]) {
        assert.strictEqual(functions(H + 'function a() end\n' + line + '\nb c', {})[0].length, 1, line);
      }
      assert.deepStrictEqual(functions(H + 'function a() end\n__lua__x\nfunction b() end', {}), [[], [ 'a', 'b' ]]);
      assert.deepStrictEqual(functions('#include a.lua', { 'a.lua': 'x = 1\n__gfx__\ny = 2' })[0], [ 'a.lua 3:0 assignment operator expected near \'y\'' ]);
    });

    it('splits a file into tabs at each line -->8 between two line breaks, the first first', () => {
      const files = {
        'note.p8': H + 'function t0() end\n-->8 note\nfunction t1() end\n',
        'first.p8': H + '-->8\nfunction t1() end\n',
        'last.p8': H + 'function t0() end\n-->8\n',
        'last.lua': 'function t0() end\n-->8',
        'two.p8': H + tabs('function t0() end', '-->8\nfunction t1() end'),
        'three.p8': H + tabs('function t0() end', '-->8', 'function t2() end'),
        'crlf.lua': 'function t0() end\r\n-->8\r\nfunction t1() end\r\n',
      };
      const noTab = (name: string) => [[ `main_test_file 1:0 Can't #include "${name}" from main_test_file: ${name.replace(/:.*/, '')} has no tab ${name.replace(/.*:/, '')}` ], []];
      assert.deepStrictEqual([ functions('#include note.p8:1', files), functions('#include note.p8:0', files) ], [ noTab('note.p8:1'), [[], [ 't0', 't1' ]]]);
      assert.deepStrictEqual([ functions('#include first.p8:1', files), functions('#include last.p8:1', files), functions('#include last.lua:1', files) ],
        [ noTab('first.p8:1'), noTab('last.p8:1'), [[], []]]);
      assert.deepStrictEqual([ functions('#include two.p8:1', files), functions('#include two.p8:2', files), functions('#include three.p8:2', files) ],
        [[[], [ 't1' ]], noTab('two.p8:2'), [[], [ 't2' ]]]);
      assert.deepStrictEqual(functions('#include crlf.lua:1', files), [[], [ 't1' ]]);
    });

    it('takes tabs of a file whose path has .lua in it in any case, and else the whole file', () => {
      const code = tabs('function t0() end', 'function t1() end');
      const files = { 'a.lua.txt': code, 'sub.lua/a.txt': code, 'b.LuA': code, 'alua.txt': code, 'c.lu.txt': code };
      for (const name of [ 'a.lua.txt', 'sub.lua/a.txt', 'b.LuA' ]) {
        assert.deepStrictEqual(functions(`#include ${name}:1`, files), [[], [ 't1' ]], name);
      }
      for (const name of [ 'alua.txt', 'c.lu.txt' ]) {
        assert.deepStrictEqual(functions(`#include ${name}:1`, files), [[], [ 't0', 't1' ]], name);
      }
    });

    it('pastes the first 16 tabs of a file of tabs that is included whole, with nothing between them', () => {
      const code = Array.from({ length: 18 }, (_, k) => `function t${k}() end\n`).join('\n-->8\n');
      const first16 = Array.from({ length: 16 }, (_, k) => 't' + k);
      const files = { 'other.p8': H + code, 'a.lua': code, 'a.txt': code, 'join.lua': 'a\n-->8\nb = 1', 'comment.p8': H + 'x = 1 --c\n-->8\ny = 2' };
      assert.deepStrictEqual([ functions('#include other.p8', files), functions('#include other.p8:', files), functions('#include a.lua', files) ],
        [[[], first16 ], [[], first16 ], [[], first16 ]]);
      assert.deepStrictEqual(functions('#include a.txt', files), [[], Array.from({ length: 18 }, (_, k) => 't' + k) ]);
      assert.deepStrictEqual(assignedNames(parseWith('#include join.lua', files).block.body), [ 'ab' ]);
      assert.deepStrictEqual(assignedNames(parseWith('#include comment.p8', files).block.body), [ 'x' ]);
      // The line of a one-line if goes on into the next tab (si.t28.join.one-line-if).
      const oneLine = parseWith('#include if.lua\nz = 3', { 'if.lua': 'if (c) x = 1\n-->8\ny = 2' });
      assert.deepStrictEqual([ oneLine.errors, statementsOf(oneLine), assignedNames((oneLine.block.body[1] as IfStatement).clauses[0].block.body) ],
        [[], [ 'IncludeStatement', 'IfStatement*', 'AssignmentStatement' ], [ 'x', 'y' ]]);
    });

    it('takes a \\ at the end of a pasted file into a string with the first line break after the file, as PICO-8 does', () => {
      assert.deepStrictEqual(parseWith('#include a.lua\nprinth(s)', { 'a.lua': 's = "a\\' }).errors.map(formatError),
        [ 'a.lua 1:4 unfinished string near \'"a\\\'' ]);
    });
  });
});
