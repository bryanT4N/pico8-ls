import { deepStrictEqual, strictEqual as eq } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as url from 'url';
import { Location, SymbolInformation, SymbolKind } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { builtinInfo } from '../parser/builtins';
import Parser from '../parser/parser';
import ResolvedFile, { FileResolver, fileURLToPath, pathToFileURL, RealFileResolver } from '../parser/file-resolver';
import { outlineLines } from '../parser/test/outline-utils';
import { deepEquals, formatError } from '../parser/test/test-utils';
import { findProjects, isTrackedPath, leftWorkspace, makeFileResolver, ParsedDocumentsMap, ProjectDocument, ProjectIndex } from '../projects';
import { callContextAt } from '../signature-help';

// Creates a mock ProjectDocument that just has the specified includes
function mockTextDocument(name: string, includes: string[]): ProjectDocument {
  return {
    textDocument: TextDocument.create(name, 'pico-8-lua', 0, 'test file contents'),
    chunk: {
      block: {
        type: 'Block',
        body: [],
      },
      errors: [],
      type: 'Chunk',
      includes: includes.map(filename => {
        return {
          resolvedFile: new ResolvedFile(filename, filename),
          stmt: {
            type: 'IncludeStatement',
            filename,
          },
        };
      }),
    },
    errors: [],
  };
}

function createDocumentsMap(docs: ProjectDocument[]): ParsedDocumentsMap {
  const map = new Map<string, ProjectDocument>();

  for (const doc of docs) {
    map.set(doc.textDocument.uri, doc);
  }

  return map;
}

describe('isTrackedPath', () => {
  it('tracks .p8 and .lua files not in a dot-directory below the root', () => {
    const root = path.resolve('/ws');
    eq(isTrackedPath(path.join(root, 'main.p8'), [ root ]), true);
    eq(isTrackedPath(path.join(root, 'sub', 'a.lua'), [ root ]), true);
    eq(isTrackedPath(path.join(root, '.history', 'x.lua'), [ root ]), false);
    eq(isTrackedPath(path.join(root, 'readme.txt'), [ root ]), false);
  });

  it('tracks a file when the root itself is in a dot-directory', () => {
    const root = path.resolve('/home/me/.projects/game');
    eq(isTrackedPath(path.join(root, 'main.p8'), [ root ]), true);
  });

  it('tracks any .p8/.lua file when no roots are given', () => {
    eq(isTrackedPath(path.join(path.resolve('/anywhere'), '.x', 'a.lua'), []), true);
  });

  it('leaves out the dot-directories below a filesystem root, which ends in a separator', () => {
    const root = path.parse(process.cwd()).root;
    eq(isTrackedPath(path.join(root, 'main.p8'), [ root ]), true);
    eq(isTrackedPath(path.join(root, 'games', 'a.lua'), [ root ]), true);
    eq(isTrackedPath(path.join(root, '.hidden', 'a.lua'), [ root ]), false);
    eq(isTrackedPath(path.join(root, 'games', '.history', 'a.lua'), [ root ]), false);
  });

  it('tracks a file that one of the folders holding it reaches with no dot-directory between', () => {
    const root = path.parse(process.cwd()).root;
    const game = path.join(root, '.proj', 'game');
    eq(isTrackedPath(path.join(game, 'main.p8'), [ root, game ]), true);
    eq(isTrackedPath(path.join(game, 'main.p8'), [ game, root ]), true);
    eq(isTrackedPath(path.join(root, '.proj', 'other', 'x.lua'), [ root, game ]), false);
  });
});

describe('leftWorkspace', () => {
  it('lists the files under a removed folder and under no remaining one', () => {
    const ws = path.resolve('/ws');
    const uri = (p: string) => pathToFileURL(path.join(ws, p));
    deepStrictEqual(leftWorkspace([ uri('b/x.lua'), uri('b/inner/y.lua'), uri('b2/z.lua'), uri('a/m.p8'), uri('b/.hidden/w.lua') ],
      [ path.join(ws, 'b') ], [ path.join(ws, 'a'), path.join(ws, 'b', 'inner') ]), [ uri('b/x.lua'), uri('b/.hidden/w.lua') ]);
  });

  it('takes a filesystem root, which ends in a separator, as a folder like any other', () => {
    const root = path.parse(process.cwd()).root;
    const games = path.join(root, 'games');
    const uri = (p: string) => pathToFileURL(path.join(root, p));
    const files = [ uri('games/a.lua'), uri('b.lua') ];
    deepStrictEqual(leftWorkspace(files, [ root ], []), files);
    deepStrictEqual(leftWorkspace(files, [ root ], [ games ]), [ uri('b.lua') ]);
    deepStrictEqual(leftWorkspace(files, [ games ], [ root ]), []);
  });
});

describe('pathToFileURL', () => {
  it('writes a URI as VS Code does, and reads it back', () => {
    const name = 'lib(2) it\'s!&+,;=@[x]~.lua';
    const encoded = 'lib%282%29%20it%27s%21%26%2B%2C%3B%3D%40%5Bx%5D~.lua';
    // A path from a URI that VS Code gave, whose drive letter is lower case.
    const [ filePath, uri ] = path.sep === '\\'
      ? [ `c:\\Users\\me\\My Carts\\${name}`, `file:///c%3A/Users/me/My%20Carts/${encoded}` ]
      : [ `/home/me/My Carts/${name}`, `file:///home/me/My%20Carts/${encoded}` ];
    eq(pathToFileURL(filePath), uri);
    eq(fileURLToPath(uri), filePath);
    eq(ResolvedFile.fromFileURL(uri).equals(ResolvedFile.fromPath(filePath)), true);
  });
});

describe('findProjects', () => {
  it('groups files that include each other into projects', () => {
    const root = mockTextDocument('root.p8', [ 'lib1.lua', 'lib2.lua' ]);
    const lib1 = mockTextDocument('lib1.lua', [ 'nested.lua' ]);
    const lib2 = mockTextDocument('lib2.lua', []);
    const nested = mockTextDocument('nested.lua', []);
    const separate = mockTextDocument('separate.p8', []);

    const docs = createDocumentsMap([ root, lib1, lib2, nested, separate ]);
    const projects = findProjects(docs);

    eq(projects.length, 2);

    const rootProj = projects.find(p => p.root.document.textDocument.uri === 'root.p8');
    deepEquals(rootProj, {
      root: {
        isChild: false,
        document: { textDocument: { uri: 'root.p8' } },
        included: [
          {
            isChild: true,
            document: { textDocument: { uri: 'lib1.lua' } },
            included: [
              { isChild: true, document: { textDocument: { uri: 'nested.lua' } }, included: [] },
            ],
          },
          { isChild: true, document: { textDocument: { uri: 'lib2.lua' } }, included: [] },
        ],
      },
    });

    const separateProj = projects.find(p => p.root.document.textDocument.uri === 'separate.p8');
    deepEquals(separateProj, {
      root: {
        isChild: false, document: { textDocument: { uri: 'separate.p8' } }, included: [],
      },
    });
  });
});

const ROOT = path.resolve('/proj');
const uriOf = (name: string) => ResolvedFile.fromPath(path.join(ROOT, name)).fileURL;
const nameOf = (uri: string) => path.basename(url.fileURLToPath(uri));
const NO_DISK: FileResolver = {
  doesFileExist: () => false,
  isFile: () => false,
  loadFileContents: p => {
    throw new Error(`not found: ${p}`);
  },
};

type IndexOptions = { tweak?: (doc: ProjectDocument) => void, cache?: Map<string, string>, disk?: FileResolver, parsed?: string[] };

// An index over files kept in memory; tests change `files` and call update or remove. `files` are the editor's open
// documents; the server reads any other file through the resolver, from `cache` while `disk` has it. `parsed` gets the
// name of each file the index parses.
function indexOver(files: Record<string, string>, { tweak, cache = new Map(), disk = NO_DISK, parsed }: IndexOptions = {}) {
  const openText = (uri: string) => files[nameOf(uri)];
  const resolver = makeFileResolver(openText, cache, disk);
  const parseFile = (uri: string) => {
    parsed?.push(nameOf(uri));
    const filePath = url.fileURLToPath(uri);
    const text = openText(uri) ?? (resolver.doesFileExist(filePath) ? resolver.loadFileContents(filePath) : undefined);
    if (text === undefined) {
      return undefined;
    }
    const chunk = new Parser(ResolvedFile.fromFileURL(uri), text, { includeFileResolver: resolver }).parse();
    const doc = { textDocument: TextDocument.create(uri, uri.endsWith('p8') ? 'pico-8' : 'pico-8-lua', 0, text), chunk, errors: chunk.errors };
    tweak?.(doc);
    return doc;
  };
  return new ProjectIndex(parseFile);
}

// `${file} ${line}:${character}-${line}:${character}`, lines from 1.
const loc = (l: Location) => `${nameOf(l.uri)} ${l.range.start.line + 1}:${l.range.start.character}-${l.range.end.line + 1}:${l.range.end.character}`;

// The index at line (from 1) and character in the current text of a file.
const offsetIn = (files: Record<string, string>, name: string, line: number, character: number) =>
  TextDocument.create(uriOf(name), 'pico-8-lua', 0, files[name]).offsetAt({ line: line - 1, character });

function scanned(files: Record<string, string>): ProjectIndex {
  const index = indexOver(files);
  index.scan(Object.keys(files).map(uriOf));
  return index;
}

describe('ProjectIndex', () => {
  const brief = (list: SymbolInformation[]) => list.map(s => [ s.name, s.containerName, nameOf(s.location.uri) ]);
  const sharedGlobals = () => ({
    'main.p8': '#include lib.lua\nshared = 5\nplayer.hp = 3\nfunction _draw() print(shared) end',
    'lib.lua': 'shared = 0\nplayer = { x = 1 }',
  });
  const localAfterInclude = () => ({
    'main.p8': 'local speed = 2\n#include lib.lua\nlocal gravity = 1',
    'lib.lua': 'function move(p)\n  p.x += speed\n  p.y += gravity\nend',
  });

  it('gives every file the outline of its project', () => {
    const index = scanned(sharedGlobals());
    deepStrictEqual(outlineLines(index.outline(uriOf('main.p8'))), [ 'shared [Variable]', 'player [Table]', '  hp [Field]', '_draw() [Function]' ]);
    deepStrictEqual(outlineLines(index.outline(uriOf('lib.lua'))), [ 'shared [Variable]', 'player [Table]', '  x [Field]' ]);
  });

  it('goes to the definition in every file of the project', () => {
    const files = sharedGlobals();
    const index = scanned(files);
    deepStrictEqual(index.definitions(uriOf('main.p8'), offsetIn(files, 'main.p8', 4, 23)).map(loc), [ 'lib.lua 1:0-1:6', 'main.p8 2:0-2:6' ]);
  });

  it('hides a local declared after the #include from the included file', () => {
    const files = localAfterInclude();
    const index = scanned(files);
    deepStrictEqual(index.warnings(uriOf('lib.lua')).map(formatError), [ 'lib.lua 3:9 undefined variable: gravity' ]);
    deepStrictEqual(index.definitions(uriOf('lib.lua'), offsetIn(files, 'lib.lua', 3, 9)), []);
  });

  it('shares a file between two roots: lookups from both, warnings only if both agree', () => {
    const files = {
      'a.p8': 'player = {}\n#include common.lua',
      'b.p8': '#include common.lua',
      'common.lua': 'function draw_player()\n  spr(1, player.x, player.y)\nend',
    };
    const index = scanned(files);
    deepStrictEqual(index.warnings(uriOf('common.lua')), []);
    deepStrictEqual(index.definitions(uriOf('common.lua'), offsetIn(files, 'common.lua', 2, 9)).map(loc), [ 'a.p8 1:0-1:6' ]);
  });

  it('analyses a file that no project contains as its own project', () => {
    const files: Record<string, string> = { 'main.p8': 'x = 1' };
    const index = scanned(files);
    files['new.lua'] = 'function helper() end\nhelper()';
    const resend = index.update(uriOf('new.lua'));
    eq(resend.includes(uriOf('new.lua')), true);
    deepStrictEqual(outlineLines(index.outline(uriOf('new.lua'))), [ 'helper() [Function]' ]);
    deepStrictEqual(index.definitions(uriOf('new.lua'), offsetIn(files, 'new.lua', 2, 0)).map(loc), [ 'new.lua 1:9-1:15' ]);
  });

  it('updates the includer in the same call', () => {
    const files = { 'main.p8': '#include lib.lua\nprint(answer())', 'lib.lua': 'function answer() return 1 end' };
    const index = scanned(files);
    const answer = offsetIn(files, 'main.p8', 2, 6);
    deepStrictEqual(index.definitions(uriOf('main.p8'), answer).map(loc), [ 'lib.lua 1:9-1:15' ]);
    files['lib.lua'] = '\nfunction answer() return 2 end';
    deepStrictEqual(index.update(uriOf('lib.lua')).sort(), [ uriOf('main.p8'), uriOf('lib.lua') ].sort());
    deepStrictEqual(index.definitions(uriOf('main.p8'), answer).map(loc), [ 'lib.lua 2:9-2:15' ]);
  });

  it('reads included files through the URI form the editor uses', () => {
    const asked: string[] = [];
    const resolver = makeFileResolver(uri => {
      asked.push(uri);
      return 'x = 1';
    }, new Map(), NO_DISK);
    eq(resolver.loadFileContents(path.join(ROOT, 'lib.lua')), 'x = 1');
    deepStrictEqual(asked, [ uriOf('lib.lua') ]);
  });

  it('knows an included file by the URI the editor gives it when its name has parentheses', () => {
    const files: Record<string, string> = {
      'main.p8': 'player = {}\n#include lib(2).lua\nprint(answer())',
      'lib(2).lua': 'function answer() return player end',
    };
    const index = scanned(files);
    // VS Code's URI for lib(2).lua: url.pathToFileURL leaves the parentheses as they are.
    const lib = uriOf('lib.lua').replace(/lib\.lua$/, 'lib%282%29.lua');
    const asked: string[] = [];
    makeFileResolver(uri => {
      asked.push(uri);
      return '';
    }, new Map(), NO_DISK).loadFileContents(path.join(ROOT, 'lib(2).lua'));
    deepStrictEqual(asked, [ lib ]);
    // Opened in the editor, then edited without saving.
    files['lib(2).lua'] = '\nfunction answer() return player end';
    index.update(lib);
    files['lib(2).lua'] = '\n\nfunction answer() return player end';
    index.update(lib);
    deepStrictEqual(index.warnings(lib), []);
    deepStrictEqual(index.definitions(uriOf('main.p8'), offsetIn(files, 'main.p8', 3, 6)).map(loc), [ 'lib(2).lua 3:9-3:15' ]);
  });

  it('moves a file into the project that starts including it', () => {
    const files = { 'lib.lua': 'function draw_player() spr(1, player.x, 0) end', 'main.p8': 'x = 1' };
    const index = scanned(files);
    deepStrictEqual(index.warnings(uriOf('lib.lua')).map(formatError), [ 'lib.lua 1:30 undefined variable: player' ]);
    files['main.p8'] = 'player = {}\n#include lib.lua';
    eq(index.update(uriOf('main.p8')).includes(uriOf('lib.lua')), true);
    deepStrictEqual(index.warnings(uriOf('lib.lua')), []);
  });

  it('forgets a removed file in the projects that included it', () => {
    const files: Record<string, string> = { 'main.p8': '#include lib.lua\nhelper()', 'lib.lua': 'function helper() end' };
    const index = scanned(files);
    const helper = offsetIn(files, 'main.p8', 2, 0);
    deepStrictEqual(index.definitions(uriOf('main.p8'), helper).map(loc), [ 'lib.lua 1:9-1:15' ]);
    delete files['lib.lua'];
    const resend = index.remove(uriOf('lib.lua'));
    deepStrictEqual([ resend.includes(uriOf('main.p8')), resend.includes(uriOf('lib.lua')) ], [ true, true ]);
    eq(new Set(resend).size, resend.length);
    eq(index.document(uriOf('main.p8'))!.errors.map(formatError).includes('main.p8 1:0 Can\'t #include lib.lua from main.p8: File does not exist'), true);
    deepStrictEqual(index.definitions(uriOf('main.p8'), helper), []);
    deepStrictEqual(index.warnings(uriOf('main.p8')).map(formatError), [ 'main.p8 2:0 undefined variable: helper' ]);
  });

  it('does not take an #include from the cached text of a file that is gone from disk', () => {
    const files: Record<string, string> = { 'main.p8': '#include lib.lua\nhelper()' };
    const onDisk = new Set([ 'main.p8', 'lib.lua' ]);
    const cache = new Map([[ uriOf('lib.lua'), 'function helper() end' ]]);
    const disk: FileResolver = {
      doesFileExist: p => onDisk.has(path.basename(p)),
      isFile: p => onDisk.has(path.basename(p)),
      loadFileContents: p => {
        throw new Error(`not read in this test: ${p}`);
      },
    };
    const index = indexOver(files, { cache, disk });
    index.scan([ uriOf('main.p8'), uriOf('lib.lua') ]);
    const helper = offsetIn(files, 'main.p8', 2, 0);
    const includeLine = offsetIn(files, 'main.p8', 1, 3);
    deepStrictEqual(index.definitions(uriOf('main.p8'), helper).map(loc), [ 'lib.lua 1:9-1:15' ]);
    // Its folder is deleted, which the file watcher does not report for lib.lua; then main.p8 is edited.
    onDisk.delete('lib.lua');
    index.update(uriOf('main.p8'));
    deepStrictEqual(index.document(uriOf('main.p8'))!.errors.map(formatError),
      [ 'main.p8 1:0 Can\'t #include lib.lua from main.p8: File does not exist' ]);
    deepStrictEqual(index.definitions(uriOf('main.p8'), helper), []);
    deepStrictEqual(index.definitions(uriOf('main.p8'), includeLine), []);
    eq(cache.has(uriOf('lib.lua')), false);
  });

  it('lists a file included twice once', () => {
    const index = scanned({ 'main.p8': '#include a.lua\n#include a.lua\nf()', 'a.lua': 'function f() end\nx = 1\nlocal y = 2' });
    deepStrictEqual(outlineLines(index.outline(uriOf('a.lua'))), [ 'f() [Function]', 'x [Variable]', 'y [Variable]' ]);
  });

  it('lists the entries of a file #included in a function at the top of its outline', () => {
    const lib = 'function helper() end\nfunction other() end';
    const outlineOfLib = (main: string) => outlineLines(scanned({ 'main.p8': main, 'lib.lua': lib }).outline(uriOf('lib.lua')));
    deepStrictEqual(outlineOfLib('function _init()\n  #include lib.lua\nend'), [ 'helper() [Function]', 'other() [Function]' ]);
    deepStrictEqual(outlineOfLib('function _init()\n  local function setup()\n    #include lib.lua\n  end\nend'),
      [ 'helper() [Function]', 'other() [Function]' ]);
    deepStrictEqual(outlineOfLib('co = cocreate(function()\n  #include lib.lua\nend)'), [ 'helper() [Function]', 'other() [Function]' ]);
    deepStrictEqual(outlineOfLib('player = { update = function(self)\n  #include lib.lua\nend }'), [ 'helper() [Function]', 'other() [Function]' ]);
  });

  it('keeps a forward-declared local in its file\'s outline when the function is in another file', () => {
    const index = scanned({ 'main.p8': 'local update_enemy\n#include lib.lua', 'lib.lua': 'update_enemy = function() end' });
    deepStrictEqual(outlineLines(index.outline(uriOf('main.p8'))), [ 'update_enemy [Variable]' ]);
    deepStrictEqual(outlineLines(index.outline(uriOf('lib.lua'))), [ 'update_enemy() [Function]' ]);
  });

  it('copes with files that include each other', () => {
    const index = scanned({ 'main.p8': '#include a.lua', 'a.lua': '#include b.lua\nfunction fa() end', 'b.lua': '#include a.lua\nfunction fb() end' });
    deepStrictEqual(outlineLines(index.outline(uriOf('a.lua'))), [ 'fa() [Function]' ]);
  });

  it('makes each file of a cycle that nothing else includes the root of its own project', () => {
    const files = { 'a.lua': '#include b.lua\nfunction fa() end\nfa()', 'b.lua': '#include a.lua\nfunction fb() end' };
    const index = scanned(files);
    deepStrictEqual(outlineLines(index.outline(uriOf('a.lua'))), [ 'fa() [Function]' ]);
    deepStrictEqual(outlineLines(index.outline(uriOf('b.lua'))), [ 'fb() [Function]' ]);
    deepStrictEqual(index.definitions(uriOf('a.lua'), offsetIn(files, 'a.lua', 3, 0)).map(loc), [ 'a.lua 2:9-2:11' ]);
    deepStrictEqual(index.document(uriOf('a.lua'))!.errors.map(formatError),
      [ 'a.lua 1:0 Can\'t #include a.lua from b.lua, which is #included from a.lua: Circular #includes detected!' ]);
    deepStrictEqual(index.update(uriOf('b.lua')).sort(), [ uriOf('a.lua'), uriOf('b.lua') ].sort());
    deepStrictEqual(outlineLines(index.outline(uriOf('b.lua'))), [ 'fb() [Function]' ]);
  });

  it('keeps an included file in its includer\'s project only', () => {
    const index = scanned({ 'main.p8': '#include lib.lua\nx = 1', 'lib.lua': 'y = 2' });
    eq(index.analyses(uriOf('lib.lua')).length, 1);
  });

  it('groups the methods of an included file across a tab line of the main file', () => {
    const index = scanned({ 'main.p8': '#include player.lua\n-->8\nx = 1',
      'player.lua': 'player = {}\nfunction player:update() end\nfunction player:draw() end' });
    deepStrictEqual(outlineLines(index.outline(uriOf('player.lua'))), [ 'player [Table]', '  update() [Method]', '  draw() [Method]' ]);
  });

  it('keeps the methods of an included file in place across its own region lines', () => {
    const index = scanned({ 'main.p8': '#include player.lua',
      'player.lua': 'player = {}\nfunction player:update() end\n-- #region drawing\nfunction player:draw() end\n-- #endregion' });
    deepStrictEqual(outlineLines(index.outline(uriOf('player.lua'))), [ 'player [Table]', 'player:update() [Method]', 'player:draw() [Method]' ]);
  });

  it('drops a root that cannot be parsed again, so that nothing is analysed from its old text', () => {
    const files: Record<string, string> = { 'main.p8': '#include lib.lua', 'lib.lua': 'function old() end' };
    const index = scanned(files);
    delete files['main.p8'];
    files['lib.lua'] = 'function new() end';
    const resend = index.update(uriOf('lib.lua'));
    deepStrictEqual(outlineLines(index.outline(uriOf('lib.lua'))), [ 'new() [Function]' ]);
    eq(index.document(uriOf('main.p8')) === undefined, true);
    eq(resend.includes(uriOf('main.p8')), true);
  });

  it('sends again the diagnostics of a file that a new scan cannot parse', () => {
    const files: Record<string, string> = { 'main.p8': 'x = 1', 'gone.lua': 'print(nope)' };
    const index = scanned(files);
    deepStrictEqual(index.warnings(uriOf('gone.lua')).map(formatError), [ 'gone.lua 1:6 undefined variable: nope' ]);
    delete files['gone.lua'];
    eq(index.scan([ uriOf('main.p8'), uriOf('gone.lua') ]).includes(uriOf('gone.lua')), true);
    deepStrictEqual(index.diagnostics([ uriOf('gone.lua') ], 100), [{ uri: uriOf('gone.lua'), diagnostics: [] }]);
  });

  it('goes from an #include line to the file', () => {
    const files = { 'main.p8': '#include lib.lua', 'lib.lua': 'x = 1' };
    const found = scanned(files).definitions(uriOf('main.p8'), offsetIn(files, 'main.p8', 1, 3));
    deepStrictEqual(found.map(l => [ l.uri, l.range.start ]), [[ uriOf('lib.lua'), { line: 0, character: 0 }]]);
  });

  it('leaves the declaration out of references when asked', () => {
    const files = { 'main.p8': 'local a\nb = a' };
    const index = scanned(files);
    const a = offsetIn(files, 'main.p8', 2, 4);
    deepStrictEqual(index.references(uriOf('main.p8'), a, true).map(loc), [ 'main.p8 1:6-1:7', 'main.p8 2:4-2:5' ]);
    deepStrictEqual(index.references(uriOf('main.p8'), a, false).map(loc), [ 'main.p8 2:4-2:5' ]);
  });

  // An index whose analysis of main.p8 throws. logged: how many errors the scan reported.
  const failedAnalysis = (files: { 'main.p8': string }) => {
    // The kind of node the formatter inserts, which the analysis does not know.
    const index = indexOver(files, { tweak: doc => doc.chunk.block.body.push({ type: 'Whitespace', count: 1 } as any) });
    const consoleError = console.error;
    let logged = 0;
    console.error = () => {
      logged++;
    };
    try {
      index.scan([ uriOf('main.p8') ]);
    } finally {
      console.error = consoleError;
    }
    return { index, logged };
  };

  it('falls back to an empty analysis when the analysis throws', () => {
    const { index, logged } = failedAnalysis({ 'main.p8': 'function f() end' });
    deepStrictEqual(index.outline(uriOf('main.p8')), []);
    deepStrictEqual(index.warnings(uriOf('main.p8')), []);
    eq(logged, 1);
  });

  it('takes the outline from the next project when the first one\'s analysis failed', () => {
    const files = { 'a.p8': '#include common.lua', 'b.p8': '#include common.lua', 'common.lua': 'function helper()\n  local x = 1\nend' };
    // The kind of node the formatter inserts, which the analysis does not know, in a.p8 only.
    const index = indexOver(files, { tweak: doc => {
      if (doc.textDocument.uri === uriOf('a.p8')) {
        doc.chunk.block.body.push({ type: 'Whitespace', count: 1 } as any);
      }
    } });
    const consoleError = console.error;
    console.error = () => undefined;
    try {
      index.scan(Object.keys(files).map(uriOf));
    } finally {
      console.error = consoleError;
    }
    deepStrictEqual(outlineLines(index.outline(uriOf('common.lua'))), [ 'helper() [Function]', '  x [Variable]' ]);
  });

  it('takes #include Lib.lua for lib.lua on a disk that ignores case', function () {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'pico8-ls-case-'));
    try {
      fs.writeFileSync(path.join(dir, 'main.lua'), 'speed = 2\n#include Lib.lua');
      fs.writeFileSync(path.join(dir, 'lib.lua'), 'function move(p)\n  p.x += speed\nend');
      if (!fs.existsSync(path.join(dir, 'LIB.LUA'))) {
        // A disk that tells case apart does not find Lib.lua, as PICO-8 does not.
        this.skip();
      }
      const uri = (name: string) => ResolvedFile.fromPath(path.join(dir, name)).fileURL;
      const index = indexOver({}, { disk: new RealFileResolver() });
      index.scan([ uri('main.lua'), uri('lib.lua') ]);
      eq(index.document(uri('main.lua'))!.chunk.includes![0].resolvedFile.fileURL, uri('lib.lua'));
      eq(index.analyses(uri('lib.lua')).length, 1);
      deepStrictEqual(index.warnings(uri('lib.lua')), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives no hover and the builtin signature help when the analysis failed', () => {
    const files = { 'main.p8': 'function f() end\nprint(' };
    const { index } = failedAnalysis(files);
    eq(index.hover(uriOf('main.p8'), offsetIn(files, 'main.p8', 1, 9)), undefined);
    eq(index.signatureHelp(uriOf('main.p8'), files['main.p8'].length, callContextAt(files['main.p8'], files['main.p8'].length)!)!.signatures[0].label,
      builtinInfo('print')!.sig);
  });

  it('sends each file\'s diagnostics once', () => {
    const index = scanned(localAfterInclude());
    const sent = index.diagnostics([ uriOf('lib.lua'), uriOf('main.p8') ], 100);
    deepStrictEqual(sent.map(({ uri, diagnostics }) => [ nameOf(uri), diagnostics.map(d => d.message) ]),
      [[ 'lib.lua', [ 'undefined variable: gravity' ]], [ 'main.p8', []]]);
  });

  it('resolves a fresh #include when update adds the file', () => {
    const files: Record<string, string> = { 'main.p8': '#include lib.lua\nhelper()' };
    const index = indexOver(files);
    index.scan([ uriOf('main.p8') ]);
    eq(index.document(uriOf('main.p8'))!.errors.map(formatError).includes('main.p8 1:0 Can\'t #include lib.lua from main.p8: File does not exist'), true);
    files['lib.lua'] = 'function helper() end';
    const resend = index.update(uriOf('lib.lua'));
    deepStrictEqual(index.document(uriOf('main.p8'))!.errors, []);
    deepStrictEqual(index.definitions(uriOf('main.p8'), offsetIn(files, 'main.p8', 2, 0)).map(loc), [ 'lib.lua 1:9-1:15' ]);
    eq(resend.includes(uriOf('main.p8')), true);
  });

  it('parses again only the files with an #include that could not be resolved when a file appears', () => {
    const files: Record<string, string> = {
      'main.p8': '#include lib.lua\nhelper()', 'lib.lua': 'function helper() end', 'other.lua': 'x = 1', 'waiting.p8': '#include later.lua',
    };
    const parsed: string[] = [];
    const index = indexOver(files, { parsed });
    index.scan(Object.keys(files).map(uriOf));
    parsed.length = 0;
    files['new.lua'] = 'function fresh() end';
    index.update(uriOf('new.lua'));
    deepStrictEqual(parsed, [ 'new.lua', 'waiting.p8' ]);
    deepStrictEqual(outlineLines(index.outline(uriOf('new.lua'))), [ 'fresh() [Function]' ]);
  });

  it('resolves a nested fresh #include when update adds the file', () => {
    const files: Record<string, string> = { 'main.p8': '#include a.lua\nhelper()', 'a.lua': '#include b.lua' };
    const index = indexOver(files);
    index.scan([ uriOf('main.p8'), uriOf('a.lua') ]);
    eq(index.document(uriOf('a.lua'))!.errors.length > 0, true);
    files['b.lua'] = 'function helper() end';
    const resend = index.update(uriOf('b.lua'));
    deepStrictEqual(index.document(uriOf('a.lua'))!.errors, []);
    deepStrictEqual(index.definitions(uriOf('main.p8'), offsetIn(files, 'main.p8', 2, 0)).map(loc), [ 'b.lua 1:9-1:15' ]);
    eq(resend.includes(uriOf('main.p8')), true);
  });

  const diskOf = (onDisk: Map<string, string>): FileResolver => ({
    doesFileExist: p => onDisk.has(path.basename(p)),
    isFile: p => onDisk.has(path.basename(p)),
    loadFileContents: p => {
      const text = onDisk.get(path.basename(p));
      if (text === undefined) {
        throw new Error(`not found: ${p}`);
      }
      return text;
    },
  });

  it('drops several files at once, and a cart that includes one of them still reads it', () => {
    const onDisk = new Map([[ 'main.p8', '#include lib.lua\nhelper()' ], [ 'lib.lua', 'function helper() end' ], [ 'other.lua', 'print(nope)' ]]);
    const parsed: string[] = [];
    const index = indexOver({}, { disk: diskOf(onDisk), parsed });
    index.scan([ uriOf('main.p8'), uriOf('lib.lua'), uriOf('other.lua') ]);
    parsed.length = 0;
    const resend = index.removeAll([ uriOf('lib.lua'), uriOf('other.lua') ]);
    deepStrictEqual(parsed, [ 'main.p8' ]);
    deepStrictEqual(index.uris(), [ uriOf('main.p8') ]);
    eq(resend.includes(uriOf('lib.lua')) && resend.includes(uriOf('other.lua')), true);
    deepStrictEqual(index.diagnostics([ uriOf('other.lua') ], 100), [{ uri: uriOf('other.lua'), diagnostics: [] }]);
    deepStrictEqual(index.definitions(uriOf('main.p8'), offsetIn({ 'main.p8': onDisk.get('main.p8')! }, 'main.p8', 2, 0)).map(loc), [ 'lib.lua 1:9-1:15' ]);
    deepStrictEqual(index.workspaceSymbols('helper').map(s => nameOf(s.location.uri)), [ 'lib.lua' ]);
  });

  it('parses nothing when a whole cart is removed', () => {
    const onDisk = new Map([[ 'main.p8', '#include lib.lua' ], [ 'lib.lua', 'function helper() end' ]]);
    const parsed: string[] = [];
    const index = indexOver({}, { disk: diskOf(onDisk), parsed });
    index.scan([ uriOf('main.p8'), uriOf('lib.lua') ]);
    parsed.length = 0;
    index.removeAll([ uriOf('main.p8'), uriOf('lib.lua') ]);
    deepStrictEqual(parsed, []);
    deepStrictEqual(index.uris(), []);
  });

  it('parses again a cart that read a file which a later scan finds', () => {
    const onDisk = new Map([[ 'main.p8', '#include ../ws2/lib.lua\nhelper()' ], [ 'lib.lua', 'function helper() end' ]]);
    const index = indexOver({}, { disk: diskOf(onDisk) });
    index.scan([ uriOf('ws1/main.p8') ]);
    // ws2 is not in the workspace yet, so no file watcher reports this.
    onDisk.set('lib.lua', '-- moved down\n\nfunction helper() end');
    index.scan([ uriOf('ws2/lib.lua') ]);
    deepStrictEqual(index.definitions(uriOf('ws1/main.p8'), offsetIn({ 'main.p8': onDisk.get('main.p8')! }, 'main.p8', 2, 0)).map(loc),
      [ 'lib.lua 3:9-3:15' ]);
  });

  it('parses the includer again when a file it read before the editor had it is opened', () => {
    const files: Record<string, string> = {};
    const onDisk = new Map([[ 'main.p8', '#include .shared/lib.lua\nhelper()' ], [ 'lib.lua', 'function helper() end' ]]);
    const index = indexOver(files, { disk: diskOf(onDisk) });
    // The scan leaves out the dot-folder, and the file watcher does not report it.
    index.scan([ uriOf('main.p8') ]);
    onDisk.set('lib.lua', '-- moved down\n\nfunction helper() end');
    files['lib.lua'] = onDisk.get('lib.lua')!;
    index.update(uriOf('.shared/lib.lua'));
    deepStrictEqual(index.definitions(uriOf('main.p8'), offsetIn({ 'main.p8': onDisk.get('main.p8')! }, 'main.p8', 2, 0)).map(loc),
      [ 'lib.lua 3:9-3:15' ]);
  });

  it('drops an included file whose folder is deleted, and resolves its #include when it comes back', () => {
    const files: Record<string, string> = {};
    const onDisk = new Map([[ 'main.p8', 'only_in_main = 1\n#include lib/x.lua\nhelper()' ], [ 'x.lua', 'function helper() return only_in_main end' ]]);
    const index = indexOver(files, { disk: diskOf(onDisk) });
    index.scan([ uriOf('main.p8'), uriOf('lib/x.lua') ]);
    const x = onDisk.get('x.lua')!;
    // The file watcher reports the folder only, which the server leaves out; then main.p8 is edited.
    onDisk.delete('x.lua');
    files['main.p8'] = onDisk.get('main.p8')! + '\n';
    const resend = index.update(uriOf('main.p8'));
    eq(index.document(uriOf('lib/x.lua')), undefined);
    eq(resend.includes(uriOf('lib/x.lua')), true);
    deepStrictEqual(index.warnings(uriOf('lib/x.lua')), []);
    onDisk.set('x.lua', x);
    index.update(uriOf('lib/x.lua'));
    deepStrictEqual(index.document(uriOf('main.p8'))!.errors, []);
    deepStrictEqual(index.definitions(uriOf('main.p8'), offsetIn(files, 'main.p8', 3, 0)).map(loc), [ 'x.lua 1:9-1:15' ]);
  });

  it('lists the fields a file sets on a function of its includer under the function\'s name', () => {
    const index = scanned({ 'main.p8': 'local function f() end\n#include lib.lua', 'lib.lua': 'f.x = 1\nf.y = 2' });
    deepStrictEqual(outlineLines(index.outline(uriOf('lib.lua'))), [ 'f [Table]', '  x [Field]', '  y [Field]' ]);
    const inBody = scanned({ 'main.p8': 'function _init()\n  #include lib.lua\nend', 'lib.lua': 'function helper() end\n_init.x = 1' });
    deepStrictEqual(outlineLines(inBody.outline(uriOf('lib.lua'))), [ 'helper() [Function]', '_init [Table]', '  x [Field]' ]);
  });

  it('keeps the analysis of a project whose root is not parsed again', () => {
    const files: Record<string, string> = { 'main.p8': '#include lib.lua', 'lib.lua': 'x = 1', 'other.p8': 'y = 2' };
    const index = scanned(files);
    const [ other ] = index.analyses(uriOf('other.p8'));
    const [ main ] = index.analyses(uriOf('main.p8'));
    files['new.lua'] = 'z = 3';
    index.update(uriOf('new.lua'));
    eq(index.analyses(uriOf('other.p8'))[0], other);
    eq(index.analyses(uriOf('main.p8'))[0], main);
    files['lib.lua'] = 'x = 2';
    index.update(uriOf('lib.lua'));
    eq(index.analyses(uriOf('other.p8'))[0], other);
    eq(index.analyses(uriOf('main.p8'))[0] !== main, true);
  });

  it('does not add a file it never parsed when an #include of it goes', () => {
    const files: Record<string, string> = {};
    const onDisk = new Map([[ 'main.p8', 'x = 1\n#include .shared/lib.lua\nhelper()' ], [ 'lib.lua', 'function helper() return x end' ]]);
    const index = indexOver(files, { disk: diskOf(onDisk) });
    const lib = uriOf('.shared/lib.lua');
    const staysOut = (resend: string[]) =>
      deepStrictEqual([ resend.includes(lib), index.document(lib), index.analyses(lib), index.warnings(lib) ], [ false, undefined, [], []]);
    // The scan leaves out the dot-folder, and the file watcher does not report it.
    staysOut(index.scan([ uriOf('main.p8') ]));
    // The #include line is deleted in the editor; then the file is closed without saving, and the line is deleted on
    // disk too before a new scan.
    files['main.p8'] = 'x = 1\nhelper()';
    staysOut(index.update(uriOf('main.p8')));
    delete files['main.p8'];
    index.update(uriOf('main.p8'));
    onDisk.set('main.p8', 'x = 1\nhelper()');
    staysOut(index.scan([ uriOf('main.p8') ]));
  });

  // main.p8 includes x.lua, which includes y.lua; all three are on disk and scanned.
  const nested = () => {
    const files: Record<string, string> = {};
    const onDisk = new Map([[ 'main.p8', 'only_in_main = 1\n#include x.lua\nhelper()' ], [ 'x.lua', '#include y.lua' ], [ 'y.lua', 'function helper() return only_in_main end' ]]);
    const index = indexOver(files, { disk: diskOf(onDisk) });
    index.scan([ uriOf('main.p8'), uriOf('x.lua'), uriOf('y.lua') ]);
    return { files, onDisk, index };
  };

  it('drops a file included by a dropped file when it is gone too, and resolves both when they come back', () => {
    const { files, onDisk, index } = nested();
    const [ x, y ] = [ onDisk.get('x.lua')!, onDisk.get('y.lua')! ];
    // Their folder is deleted, which the file watcher reports for the folder only; then main.p8 is edited.
    onDisk.delete('x.lua');
    onDisk.delete('y.lua');
    files['main.p8'] = onDisk.get('main.p8')! + '\n';
    const resend = index.update(uriOf('main.p8'));
    deepStrictEqual([ index.document(uriOf('y.lua')), index.warnings(uriOf('y.lua')), resend.includes(uriOf('y.lua')) ], [ undefined, [], true ]);
    onDisk.set('x.lua', x);
    onDisk.set('y.lua', y);
    index.update(uriOf('x.lua'));
    index.update(uriOf('y.lua'));
    deepStrictEqual(index.document(uriOf('main.p8'))!.errors, []);
    deepStrictEqual(index.definitions(uriOf('main.p8'), offsetIn(files, 'main.p8', 3, 0)).map(loc), [ 'y.lua 1:9-1:15' ]);
  });

  it('drops a file included by a removed file when it is gone too', () => {
    const { files, onDisk, index } = nested();
    // x.lua is open when their folder is deleted, and is then closed.
    files['x.lua'] = onDisk.get('x.lua')!;
    index.update(uriOf('x.lua'));
    onDisk.delete('x.lua');
    onDisk.delete('y.lua');
    delete files['x.lua'];
    const resend = index.remove(uriOf('x.lua'));
    deepStrictEqual([ index.document(uriOf('y.lua')), index.warnings(uriOf('y.lua')), resend.includes(uriOf('y.lua')) ], [ undefined, [], true ]);
  });

  it('hovers over a function documented in an included file', () => {
    const files = { 'main.p8': '#include lib.lua\nprint(dist(1, 2))', 'lib.lua': 'x = 1\n-- distance between\n-- two numbers\nfunction dist(a, b) return abs(a - b) end' };
    eq(scanned(files).hover(uriOf('main.p8'), offsetIn(files, 'main.p8', 2, 6)), '```pico-8-lua\nfunction dist(a, b)\n```\n\ndistance between\ntwo numbers');
  });

  it('hovers from the first project by root URI', () => {
    const files = { 'a.p8': 'x = 1\n-- from a\nplayer = {}\n#include common.lua', 'b.p8': 'x = 1\n-- from b\nplayer = {}\n#include common.lua', 'common.lua': 'print(player)' };
    eq(scanned(files).hover(uriOf('common.lua'), offsetIn(files, 'common.lua', 1, 6)), '```pico-8-lua\n(global) player = {\u2026}\n```\n\nfrom a');
  });

  it('hovers from a later project when the first has nothing to show', () => {
    const files = { 'a.p8': '#include common.lua', 'b.p8': 'x = 1\n-- from b\nplayer = {}\n#include common.lua', 'common.lua': 'print(player)' };
    eq(scanned(files).hover(uriOf('common.lua'), offsetIn(files, 'common.lua', 1, 6)), '```pico-8-lua\n(global) player = {\u2026}\n```\n\nfrom b');
  });

  it('gives signature help for a function from an included file', () => {
    const files = { 'main.p8': '#include lib.lua\ndist(1, ', 'lib.lua': 'function dist(a, b) end' };
    const help = scanned(files).signatureHelp(uriOf('main.p8'), files['main.p8'].length, callContextAt(files['main.p8'], files['main.p8'].length)!)!;
    eq(help.signatures[0].label, 'dist(a, b)');
    eq(help.activeParameter, 1);
  });

  it('lists each file once in workspace symbols, from the first project that contains it', () => {
    const index = scanned({ 'a.p8': 'function a_init()\n  #include common.lua\nend', 'b.p8': '#include common.lua', 'common.lua': 'function helper() end' });
    deepStrictEqual(brief(index.workspaceSymbols('helper')), [[ 'helper()', 'a_init', 'common.lua' ]]);
  });

  it('lists a global set in two files in each of them', () => {
    const index = scanned(sharedGlobals());
    deepStrictEqual(brief(index.workspaceSymbols('shared')), [[ 'shared', undefined, 'lib.lua' ], [ 'shared', undefined, 'main.p8' ]]);
    // main.p8 only sets a field of player, so player itself is listed in lib.lua alone.
    deepStrictEqual(brief(index.workspaceSymbols('player')),
      [[ 'player', undefined, 'lib.lua' ], [ 'player.x', undefined, 'lib.lua' ], [ 'player.hp', undefined, 'main.p8' ]]);
  });

  it('gives workspace symbols as SymbolInformation, and none for an empty query', () => {
    const index = scanned({ 'main.p8': 'entity = {}\nfunction entity:update() end', 'f.lua': 'function f()\n  local x = 1\nend' });
    deepStrictEqual(index.workspaceSymbols('update'), [{ name: 'entity:update()', kind: SymbolKind.Method,
      location: { uri: uriOf('main.p8'), range: { start: { line: 1, character: 16 }, end: { line: 1, character: 22 } } } }]);
    deepStrictEqual(index.workspaceSymbols('x'), [{ name: 'x', kind: SymbolKind.Variable,
      location: { uri: uriOf('f.lua'), range: { start: { line: 1, character: 8 }, end: { line: 1, character: 9 } } }, containerName: 'f' }]);
    deepStrictEqual(index.workspaceSymbols(''), []);
  });

  it('lists a file that only an #include reads', () => {
    const onDisk = new Map([[ 'main.p8', '#include .shared/lib (2).lua\nhelper()' ], [ 'lib (2).lua', 'function helper() end' ]]);
    const index = indexOver({}, { disk: diskOf(onDisk) });
    // The scan leaves out the dot-folder.
    index.scan([ uriOf('main.p8') ]);
    deepStrictEqual(index.workspaceSymbols('helper').map(s => s.location.uri), [ uriOf('.shared/lib (2).lua') ]);
  });

  it('shows the symbols of the current text', () => {
    const files: Record<string, string> = { 'main.p8': 'function old_name() end' };
    const index = scanned(files);
    deepStrictEqual(brief(index.workspaceSymbols('name')), [[ 'old_name()', undefined, 'main.p8' ]]);
    files['main.p8'] = 'function new_name() end';
    index.update(uriOf('main.p8'));
    deepStrictEqual(brief(index.workspaceSymbols('name')), [[ 'new_name()', undefined, 'main.p8' ]]);
  });

  it('lists nothing from a project whose analysis failed', () => {
    const { index } = failedAnalysis({ 'main.p8': 'function f() end' });
    deepStrictEqual(index.workspaceSymbols('f'), []);
  });
});
