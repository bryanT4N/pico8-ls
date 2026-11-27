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

  it('reports a return that ends a cart from a file the cart includes, and code after a return in an included file', () => {
    const files = { 'lib.lua': 'x=1\nreturn x' };
    const cartErrors = (code: string) => parse(code, { filename: 'main.p8', includeFileResolver: new TestFilesResolver(files) }).errors.map(formatError);
    assert.deepStrictEqual(cartErrors('printh("ok")\n#include lib.lua'), [ 'lib.lua 2:0 PICO-8 does not accept a return in the cart\'s outermost block' ]);
    assert.deepStrictEqual(cartErrors('function f()\n#include lib.lua\nend'), []);
    assert.deepStrictEqual(parseWith('#include lib.lua\nprinth(x)', { 'lib.lua': 'return 1\nx=2' }).errors.map(formatError), [ 'lib.lua 2:0 \'<eof>\' expected near \'x\'' ]);
  });

  it('splices an #include inside a function body into the function', () => {
    const { errors, block } = parseWith('function f()\n#include body.lua\nend', { 'body.lua': 'x = 1\ny = 2' });
    assert.deepStrictEqual(errors.map(formatError), []);
    assert.deepStrictEqual(statementsOf(block.body[0] as FunctionDeclaration), [ 'IncludeStatement', 'AssignmentStatement*', 'AssignmentStatement*' ]);
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
    assert.strictEqual(analyze(chunk).includeScopes.has(path.normalize('lib.lua')), true);
  });

  it('takes the rest of the line after #include as the name, less the spaces and tabs around it, and quotes it in an error', () => {
    const files = { 'lib.lua': 'function helper() end' };
    assert.deepStrictEqual(parseWith('#include lib.lua -- helpers\nhelper()', files).errors.map(formatError), [
      'main_test_file 1:0 Can\'t #include "lib.lua -- helpers" from main_test_file: File does not exist',
    ]);
    assert.deepStrictEqual(parseWith('#include missing.lua  ', files).errors.map(formatError), [
      'main_test_file 1:0 Can\'t #include "missing.lua" from main_test_file: File does not exist',
    ]);
    for (const line of [ '#include lib.lua ', '#include lib.lua  ', '#include lib.lua\t', '#include  lib.lua' ]) {
      const chunk = parseWith(line + '\nhelper()', files);
      assert.deepStrictEqual([ chunk.errors, statementsOf(chunk) ], [[], [ 'IncludeStatement', 'FunctionDeclaration*', 'CallStatement' ]], JSON.stringify(line));
    }
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

  it('includes one tab of another cart as PICO-8 reads its number, hexadecimal from 0, with the lines of the others blank', () => {
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
    const whole = [[ 'other.p8 26:4 <expression> expected near \'=\'' ], Array.from({ length: 11 }, (_, k) => 't' + k) ];
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
});
