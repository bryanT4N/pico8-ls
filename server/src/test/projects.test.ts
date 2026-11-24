import { deepStrictEqual, strictEqual as eq } from 'assert';
import * as path from 'path';
import * as url from 'url';
import { Location } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import Parser from '../parser/parser';
import ResolvedFile, { FileResolver } from '../parser/file-resolver';
import { outlineLines } from '../parser/test/outline-utils';
import { deepEquals, formatError } from '../parser/test/test-utils';
import { findProjects, makeFileResolver, ParsedDocumentsMap, ProjectDocument, ProjectIndex } from '../projects';

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

// An index over files kept in memory; tests change `files` and call update or remove.
function indexOver(files: Record<string, string>, tweak?: (doc: ProjectDocument) => void) {
  const openText = (uri: string) => files[nameOf(uri)];
  const resolver = makeFileResolver(openText, NO_DISK);
  const parseFile = (uri: string) => {
    const text = openText(uri);
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
    }, NO_DISK);
    eq(resolver.loadFileContents(path.join(ROOT, 'lib.lua')), 'x = 1');
    deepStrictEqual(asked, [ uriOf('lib.lua') ]);
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
    eq(index.document(uriOf('main.p8'))!.errors.map(formatError).includes('main.p8 1:0 Can\'t #include lib.lua from main.p8: File does not exist'), true);
    deepStrictEqual(index.definitions(uriOf('main.p8'), helper), []);
    deepStrictEqual(index.warnings(uriOf('main.p8')).map(formatError), [ 'main.p8 2:0 undefined variable: helper' ]);
  });

  it('lists a file included twice once', () => {
    const index = scanned({ 'main.p8': '#include a.lua\n#include a.lua\nf()', 'a.lua': 'function f() end\nx = 1\nlocal y = 2' });
    deepStrictEqual(outlineLines(index.outline(uriOf('a.lua'))), [ 'f() [Function]', 'x [Variable]', 'y [Variable]' ]);
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

  it('falls back to an empty analysis when the analysis throws', () => {
    // The kind of node the formatter inserts, which the analysis does not know.
    const index = indexOver({ 'main.p8': 'function f() end' }, doc => doc.chunk.block.body.push({ type: 'Whitespace', count: 1 } as any));
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
    deepStrictEqual(index.outline(uriOf('main.p8')), []);
    deepStrictEqual(index.warnings(uriOf('main.p8')), []);
    eq(logged, 1);
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
});
