import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Identifier } from '../expressions';
import { FileResolver, RealFileResolver } from '../file-resolver';
import { AssignmentStatement, FunctionDeclaration, Statement } from '../statements';
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
      'ends when an included file includes itself on its last line',
      { 'a.lua': 'x = 1\n#include a.lua' },
      'a.lua, which is #included from main_test_file',
      [ 'IncludeStatement', 'AssignmentStatement*', 'CallStatement' ],
    ],
    [
      'ends when an included file includes itself on its last line with a newline after it',
      { 'a.lua': 'x = 1\n#include a.lua\n' },
      'a.lua, which is #included from main_test_file',
      [ 'IncludeStatement', 'AssignmentStatement*', 'CallStatement' ],
    ],
    [
      'ends when an included file includes itself on its last line with a comment after it',
      { 'a.lua': 'x = 1\n#include a.lua\n-- bye' },
      'a.lua, which is #included from main_test_file',
      [ 'IncludeStatement', 'AssignmentStatement*', 'CallStatement' ],
    ],
    [
      'ends when an included file is only a self-include',
      { 'a.lua': '#include a.lua' },
      'a.lua, which is #included from main_test_file',
      [ 'IncludeStatement', 'CallStatement' ],
    ],
    [
      'ends when two files include each other on their last lines',
      { 'a.lua': 'x = 1\n#include b.lua', 'b.lua': 'y = 2\n#include a.lua' },
      'b.lua, which is #included from a.lua, which is #included from main_test_file',
      [ 'IncludeStatement', 'AssignmentStatement*', 'IncludeStatement*', 'AssignmentStatement*', 'CallStatement' ],
    ],
    [
      'ends when three files loop on their last lines',
      { 'a.lua': 'x = 1\n#include b.lua', 'b.lua': '#include c.lua', 'c.lua': 'c = 3\n#include a.lua' },
      'c.lua, which is #included from b.lua, which is #included from a.lua, which is #included from main_test_file',
      [ 'IncludeStatement', 'AssignmentStatement*', 'IncludeStatement*', 'IncludeStatement*', 'AssignmentStatement*', 'CallStatement' ],
    ],
  ];
  for (const [ name, files, chain, statements ] of LOOPS) {
    it(name, () => {
      const result = parseInChild('#include a.lua\nprint(1)', files);
      assert.strictEqual(result.threw, null);
      assert.deepStrictEqual(result.errors, [ `main_test_file 1:0 Can't #include a.lua from ${chain}: Circular #includes detected!` ]);
      assert.deepStrictEqual(result.statements, statements);
    });
  }

  it('resolves an #include on the last line of an included file next to that file', () => {
    const { errors, block } = parseWith('#include sub/a.lua\nprint(1)', {
      'sub/a.lua': 'x = 1\n#include b.lua',
      'sub/b.lua': 'y = 2',
      'b.lua': 'wrong = 1',
    });
    assert.deepStrictEqual(errors.map(formatError), []);
    assert.deepStrictEqual(assignedNames(block.body), [ 'x', 'y' ]);
  });

  it('reports a missing file on the last line of an included file on the main file\'s #include', () => {
    const { errors } = parseWith('#include a.lua\nprint(1)', { 'a.lua': 'x = 1\n#include nope.lua' });
    assert.deepStrictEqual(errors.map(formatError), [
      'main_test_file 1:0 Can\'t #include nope.lua from a.lua, which is #included from main_test_file: File does not exist',
    ]);
  });

  it('lists only the main file\'s own #includes', () => {
    const { includes } = parseWith('#include a.lua\nprint(1)', { 'a.lua': 'x = 1\n#include e.lua', 'e.lua': 'e = 1' });
    assert.deepStrictEqual(includes!.map(i => i.stmt.filename), [ 'a.lua' ]);
  });

  it('ends the last statement of an included file in that file', () => {
    const { block } = parseWith('#include a.lua', { 'a.lua': 'x = 1\ny = 2' });
    const { start, end } = block.body[2].loc!;
    assert.strictEqual(start.filename.path, 'a.lua');
    assert.strictEqual(end.filename.path, 'a.lua');
    assert.deepStrictEqual([ end.line, end.column ], [ 2, 5 ]);
  });

  it('reports a block left open at the end of an included file in that file only', () => {
    const { errors, symbols, block } = parseWith(
      lines('function _init()', '  x = 0', 'end', '#include inc.lua', 'a = 5', 'function _update()', '  x += 1', 'end'),
      { 'inc.lua': 'function typing()\n  local a = 1' },
    );
    assert.strictEqual(errors.length, 1, errors.map(formatError).join('\n'));
    assert.strictEqual(errors[0].bounds.start.filename.path, 'inc.lua');
    assert.deepStrictEqual(symbols.map(s => s.name), [ '_init', 'x', 'a', '_update' ]);
    assert.strictEqual(block.included, false);
    assert.strictEqual(block.loc!.start.filename.path, 'main_test_file');
    const assignment = block.body.find((s): s is AssignmentStatement => s.type === 'AssignmentStatement')!;
    const target = assignment.variables[0] as Identifier;
    assert.strictEqual(target.name, 'a');
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

  it('does not report a file included twice as circular', () => {
    const chunk = parseWith('#include a.lua\n#include b.lua\nprint(1)', {
      'a.lua': '#include c.lua\nx = 1',
      'b.lua': '#include c.lua\ny = 2',
      'c.lua': 'c = 3',
    });
    assert.deepStrictEqual(chunk.errors.map(formatError), []);
    assert.deepStrictEqual(statementsOf(chunk), [
      'IncludeStatement', 'IncludeStatement*', 'AssignmentStatement*', 'AssignmentStatement*',
      'IncludeStatement', 'IncludeStatement*', 'AssignmentStatement*', 'AssignmentStatement*',
      'CallStatement',
    ]);
  });

  it('splices an #include inside a function body into the function', () => {
    const { errors, block } = parseWith('function f()\n#include body.lua\nend', { 'body.lua': 'x = 1\ny = 2' });
    assert.deepStrictEqual(errors.map(formatError), []);
    assert.deepStrictEqual(statementsOf(block.body[0] as FunctionDeclaration), [ 'IncludeStatement', 'AssignmentStatement*', 'AssignmentStatement*' ]);
  });

  it('stops at 32 levels of nested #include', () => {
    const files: Record<string, string> = { 'f33.lua': 'v33 = 33' };
    for (let i = 1; i <= 32; i++) {
      files[`f${i}.lua`] = `v${i} = ${i}\n#include f${i + 1}.lua`;
    }
    const { errors, block } = parseWith('#include f1.lua', files);
    const messages = errors.map(formatError);
    assert.strictEqual(messages.length, 1, messages.join('\n'));
    assert.ok(messages[0].startsWith('main_test_file 1:0 Can\'t #include f33.lua from f32.lua, which is #included from'), messages[0]);
    assert.ok(messages[0].endsWith(': #includes are nested more than 32 levels deep'), messages[0]);
    assert.strictEqual(assignedNames(block.body).pop(), 'v32');
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
      assert.deepStrictEqual(chunk.errors.map(formatError), [ `main_test_file 1:0 Can't #include inc.lua from main_test_file: File cannot be read (${reason})` ]);
      assert.deepStrictEqual(statementsOf(chunk), [ 'IncludeStatement', 'FunctionDeclaration' ]);
    });
  }

  it('parses 256 #included files and reports the next one', () => {
    const errorsFor = (includes: number) => parseWith('#include a.lua\n'.repeat(includes), { 'a.lua': 'x = 1' }).errors.map(formatError);
    assert.deepStrictEqual(errorsFor(256), []);
    assert.deepStrictEqual(errorsFor(257), [ 'main_test_file 257:0 Can\'t #include a.lua from main_test_file: Too many #include parses (more than 256)' ]);
  });

  it('stops a tree of #includes that doubles at every level', () => {
    const files: Record<string, string> = { 'f21.lua': 'x = 1' };
    for (let i = 1; i <= 20; i++) {
      files[`f${i}.lua`] = `#include f${i + 1}.lua\n#include f${i + 1}.lua`;
    }
    const result = parseInChild('#include f1.lua\nprint(x)', files);
    assert.strictEqual(result.threw, null);
    assert.strictEqual(result.errors.length, 1, result.errors.join('\n'));
    assert.ok(result.errors[0].startsWith('main_test_file 1:0 Can\'t #include f'), result.errors[0]);
    assert.ok(result.errors[0].endsWith(': Too many #include parses (more than 256)'), result.errors[0]);
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
});
