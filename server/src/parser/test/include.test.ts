import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { analyze } from '../analysis/binder';
import { Identifier } from '../expressions';
import ResolvedFile, { FileResolver, RealFileResolver, resolveIncludeFile } from '../file-resolver';
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

  it('lists the files that #includes could not find, nested ones too, but not a circular one', () => {
    const { unresolvedIncludes } = parseWith('#include a.lua\n#include gone.lua', { 'a.lua': '#include sub/nope.lua\n#include a.lua' });
    assert.deepStrictEqual(unresolvedIncludes!.map(file => file.path), [ path.normalize('sub/nope.lua'), 'gone.lua' ]);
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
      assert.deepStrictEqual(chunk.unresolvedIncludes!.map(file => file.path), [ 'inc.lua' ]);
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

  it('resolves an #include and binds its file under the name the disk gives', () => {
    class CaseResolver extends TestFilesResolver {
      onDiskName(p: string): string | undefined {
        return p === path.normalize('Lib.lua') ? path.normalize('lib.lua') : undefined;
      }
    }
    const chunk = parse('#include Lib.lua\nhelper()', { includeFileResolver: new CaseResolver({ 'lib.lua': 'function helper() end' }) });
    assert.strictEqual(chunk.includes![0].resolvedFile.path, path.normalize('lib.lua'));
    assert.strictEqual(analyze(chunk).includeScopes.has(path.normalize('lib.lua')), true);
  });

  it('says the rest of the line is the file name when an #include with a comment after it finds no file', () => {
    const files = { 'lib.lua': 'function helper() end' };
    assert.deepStrictEqual(parseWith('#include lib.lua -- helpers\nhelper()', files).errors.map(formatError), [
      'main_test_file 1:0 Can\'t #include lib.lua -- helpers from main_test_file: File does not exist (the rest of the line is the file name: put a comment on the line above)',
    ]);
    assert.deepStrictEqual(parseWith('#include lib.lua // helpers', files).errors.map(formatError), [
      'main_test_file 1:0 Can\'t #include lib.lua // helpers from main_test_file: File does not exist (the rest of the line is the file name: put a comment on the line above)',
    ]);
    assert.deepStrictEqual(parseWith('#include missing.lua', files).errors.map(formatError), [
      'main_test_file 1:0 Can\'t #include missing.lua from main_test_file: File does not exist',
    ]);
    assert.deepStrictEqual(parseWith('#include lib.lua', files).errors, []);
  });

  it('reads an #include on the line below a value left to type as an #include', () => {
    const files = { 'lib.lua': 'function helper() end' };
    const below = parseWith('x =\n#include lib.lua\ny = 1', files);
    assert.deepStrictEqual([ below.errors.map(formatError), below.block.body.map(s => s.type) ], [
      [ 'main_test_file 1:3 <expression> expected near \'#\'' ],
      [ 'AssignmentStatement', 'IncludeStatement', 'FunctionDeclaration', 'AssignmentStatement' ],
    ]);
    const afterOperator = parseWith('x = a +\n#include lib.lua', files);
    assert.deepStrictEqual([ afterOperator.errors.map(formatError), afterOperator.block.body.map(s => s.type) ], [
      [ 'main_test_file 1:7 <expression> expected near \'#\'' ],
      [ 'AssignmentStatement', 'IncludeStatement', 'FunctionDeclaration' ],
    ]);
  });

  it('recovers a value left to type in an #included file as in the main file', () => {
    const typed = parseWith('#include lib.lua\ny = 2', { 'lib.lua': 'x = f(a +\nplayer.x = 3' });
    assert.deepStrictEqual([ typed.errors.map(formatError), typed.block.body.map(s => s.type + (s.included ? '*' : '')) ], [
      [ 'lib.lua 1:9 <expression> expected near \'player\'' ],
      [ 'IncludeStatement', 'AssignmentStatement*', 'AssignmentStatement*', 'AssignmentStatement' ],
    ]);
    const header = parseWith('function g()\n  #include lib.lua\nend', { 'lib.lua': 'while f(\n  x = 1\nend' });
    assert.deepStrictEqual(header.errors.map(formatError), [ 'lib.lua 1:7 \')\' expected (to close \'(\' at line 1) near \'x\'' ]);
  });

  it('gives a file included twice the errors it gives when included once', () => {
    assert.deepStrictEqual(parseWith('#include lib.lua\n#include lib.lua', { 'lib.lua': 'x = f(a +\nplayer.x = 3' }).errors.map(formatError),
      [ 'lib.lua 1:9 <expression> expected near \'player\'' ]);
    assert.deepStrictEqual(parseWith('#include lib.lua\n#include lib.lua', { 'lib.lua': 'while a +\n  local y = 1\nend' }).errors.map(formatError),
      [ 'lib.lua 1:9 <expression> expected near \'local\'' ]);
  });
});
