import { deepStrictEqual, strictEqual as eq } from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as url from 'url';
import { createMessageConnection, IPCMessageReader, IPCMessageWriter, MessageConnection } from 'vscode-jsonrpc/node';
import { pathToFileURL } from '../parser/file-resolver';

// The server as the editor runs it, over workspaces on the disk, within the budget and past it: a cart of a little
// over 20 million characters, linked into a folder that nothing includes, takes a workspace past it. Past it, an open
// file is to show what it shows when every file is read, and no other file is to show problems at any moment; within
// it, no file is to show problems that it does not have once everything is read.

const CART = 'pico-8 cartridge // http://www.pico-8.com\nversion 42\n__lua__\n';
const TEMP = fs.realpathSync.native(os.tmpdir());
const BIG = path.join(TEMP, `pico8-ls-big-${process.pid}.p8`);

type Files = Record<string, string>;

type Diagnostic = { range: { start: { line: number, character: number } }, message: string };

type Publish = { uri: string, problems: string[], open: boolean };

const problemsOf = (diagnostics: Diagnostic[]) => diagnostics.map(d => `${d.range.start.line + 1}:${d.range.start.character} ${d.message}`);

class Session {
  readonly published = new Map<string, string[]>();
  // Every publish, in order, and whether the file was open then.
  readonly log: Publish[] = [];
  readonly messages: string[] = [];
  exclude: Record<string, unknown> = {};
  private readonly open = new Set<string>();
  private scans = 0;
  private heard = 0;
  private readonly connection: MessageConnection;
  private readonly child: cp.ChildProcess;
  private readonly folders: { uri: string, name: string }[];
  private version = 1;

  constructor(folders: string[]) {
    this.child = cp.fork(path.join(__dirname, '..', 'server.js'), [ '--node-ipc', `--clientProcessId=${process.pid}` ], { silent: true, execArgv: [] });
    this.child.stdout?.resume();
    this.child.stderr?.resume();
    this.connection = createMessageConnection(new IPCMessageReader(this.child), new IPCMessageWriter(this.child));
    this.folders = folders.map(folder => ({ uri: pathToFileURL(folder), name: path.basename(folder) }));
    const c = this.connection;
    c.onNotification((method: string) => {
      this.heard++;
      if (method === 'pico-8-ls/didChangeCartFiles') {
        this.scans++;
      }
    });
    c.onNotification('textDocument/publishDiagnostics', ({ uri, diagnostics }: { uri: string, diagnostics: Diagnostic[] }) => {
      this.heard++;
      this.published.set(uri, problemsOf(diagnostics));
      this.log.push({ uri, problems: problemsOf(diagnostics), open: this.open.has(uri) });
    });
    c.onNotification('window/showMessage', ({ message }: { message: string }) => {
      this.heard++;
      this.messages.push(message);
    });
    c.onRequest('client/registerCapability', () => null);
    c.onRequest('workspace/configuration', ({ items }: { items: { section: string }[] }) =>
      items.map(item => item.section === 'files.exclude' ? this.exclude : { maxNumberOfProblems: 100 }));
    c.onRequest('workspace/workspaceFolders', () => this.folders);
    c.listen();
  }

  // The files in openFirst open before the first scan ends, as the editor opens the ones it restores.
  async start(openFirst: string[] = []): Promise<void> {
    await this.connection.sendRequest('initialize', { processId: process.pid, rootUri: this.folders[0].uri, workspaceFolders: this.folders,
      capabilities: { workspace: { configuration: true, workspaceFolders: true, didChangeWatchedFiles: { dynamicRegistration: true } } } });
    this.connection.sendNotification('initialized', {});
    openFirst.forEach(file => this.sendOpen(file));
    await this.scanned(this.folders.length);
  }

  // Until scans more scans have ended, then until the server is quiet.
  async scanned(scans: number): Promise<void> {
    const until = this.scans + scans;
    while (this.scans < until) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await this.quiet();
  }

  // The server answers requests in order, after the notifications sent before them; work that goes on after a reply,
  // such as a scan, sends something before it ends.
  async quiet(): Promise<void> {
    for (let heard = -1; heard !== this.heard;) {
      heard = this.heard;
      await this.connection.sendRequest('pico-8-ls/belongsToCart', { uri: 'untitled:quiet' });
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }

  problems(file: string): string[] {
    return this.published.get(pathToFileURL(file)) ?? [];
  }

  async openFile(file: string): Promise<void> {
    this.sendOpen(file);
    await this.quiet();
  }

  // Without waiting for the server, as when the user types while a scan runs.
  sendChange(file: string, text: string): void {
    this.connection.sendNotification('textDocument/didChange', { textDocument: { uri: pathToFileURL(file), version: ++this.version },
      contentChanges: [{ text }] });
  }

  async change(file: string, text: string): Promise<void> {
    this.sendChange(file, text);
    await this.quiet();
  }

  async close(file: string): Promise<void> {
    this.open.delete(pathToFileURL(file));
    this.connection.sendNotification('textDocument/didClose', { textDocument: { uri: pathToFileURL(file) } });
    await this.quiet();
  }

  // 1 created, 2 changed, 3 deleted.
  sendWatch(changes: [ number, string ][]): void {
    this.connection.sendNotification('workspace/didChangeWatchedFiles', { changes: changes.map(([ type, file ]) => ({ type, uri: pathToFileURL(file) })) });
  }

  async watch(changes: [ number, string ][], scans = 0): Promise<void> {
    this.sendWatch(changes);
    await (scans > 0 ? this.scanned(scans) : this.quiet());
  }

  async setExclude(exclude: Record<string, unknown>, scans = 0): Promise<void> {
    this.exclude = exclude;
    this.connection.sendNotification('workspace/didChangeConfiguration', { settings: null });
    await (scans > 0 ? this.scanned(scans) : this.quiet());
  }

  async addFolder(folder: string): Promise<void> {
    const added = { uri: pathToFileURL(folder), name: path.basename(folder) };
    this.folders.push(added);
    this.connection.sendNotification('workspace/didChangeWorkspaceFolders', { event: { added: [ added ], removed: [] } });
    await this.scanned(1);
  }

  belongsToCart(file: string): Promise<boolean> {
    return this.connection.sendRequest<boolean>('pico-8-ls/belongsToCart', { uri: pathToFileURL(file) });
  }

  async hover(file: string, line: number, character: number): Promise<string | undefined> {
    const hover = await this.connection.sendRequest<{ contents: { value: string } } | null>('textDocument/hover',
      { textDocument: { uri: pathToFileURL(file) }, position: { line, character } });
    return hover?.contents.value;
  }

  stop(): void {
    this.connection.dispose();
    this.child.kill();
  }

  private sendOpen(file: string): void {
    this.open.add(pathToFileURL(file));
    this.connection.sendNotification('textDocument/didOpen', { textDocument: { uri: pathToFileURL(file),
      languageId: file.endsWith('.p8') ? 'pico-8' : 'pico-8-lua', version: this.version, text: fs.readFileSync(file, 'utf8') } });
  }
}

// The files, and the big cart at big when it is given.
function workspace(files: Files, big?: string): string {
  const dir = fs.mkdtempSync(path.join(TEMP, 'pico8-ls-large-'));
  for (const [ file, text ] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  if (big !== undefined) {
    fs.mkdirSync(path.dirname(path.join(dir, big)), { recursive: true });
    fs.linkSync(BIG, path.join(dir, big));
  }
  return dir;
}

// The publishes that show problems a file does not have once everything is read, or, past the budget, any problems of
// a file that is not open.
function falsePublishes(log: Publish[], truth: Map<string, string[]>, pastBudget: boolean): Publish[] {
  return log.filter(({ uri, problems, open }) => problems.length > 0 && ((pastBudget && !open)
    || JSON.stringify(problems) !== JSON.stringify(truth.get(uri) ?? [])));
}

// Runs the steps over a copy of the files within the budget and over another past it, and compares what the steps saw.
// Past the budget no file that is not open shows problems at any moment. When the steps change nothing that a full
// read gives (fixed), every publish of either run is to show either nothing or what the run within the budget ends
// with.
async function bothWays(files: Files, folders: string[], steps: (session: Session, at: (file: string) => string, look: (file: string) => string[]) => Promise<void>,
  { fixed = false, openFirst = [] }: { fixed?: boolean, openFirst?: string[] } = {}) {
  const seen: string[][][] = [];
  const logs: Publish[][] = [];
  let truth = new Map<string, string[]>();
  for (const pastBudget of [ false, true ]) {
    const dir = workspace(files, pastBudget ? path.join(folders[0], 'big', 'huge.p8') : undefined);
    const at = (file: string) => path.join(dir, ...file.split('/'));
    const session = new Session(folders.map(folder => path.join(dir, folder)));
    const looks: string[][] = [];
    try {
      await session.start(openFirst.map(at));
      await steps(session, at, file => {
        looks.push(session.problems(at(file)));
        return session.problems(at(file));
      });
      eq(session.messages.length, pastBudget ? 1 : 0);
      if (pastBudget) {
        deepStrictEqual(session.log.filter(({ problems, open }) => problems.length > 0 && !open), []);
      }
      const relative = (uri: string) => path.relative(dir, url.fileURLToPath(uri)).split(path.sep).join('/');
      if (!pastBudget) {
        truth = new Map([ ...session.published ].map(([ uri, problems ]) => [ relative(uri), problems ]));
      }
      logs.push(session.log.map(entry => ({ ...entry, uri: relative(entry.uri) })));
    } finally {
      session.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    seen.push(looks);
  }
  deepStrictEqual(seen[1], seen[0]);
  if (fixed) {
    logs.forEach((log, i) => deepStrictEqual(falsePublishes(log, truth, i === 1), []));
  }
  return seen[0];
}

const wsR = (): Files => ({
  'a/own.p8': CART + 'print(1)\n',
  'a/lib.lua': 'print(foo)\n',
  'zz/main.p8': CART + 'foo=1\n#include ../a/lib.lua\n',
  'zz/y1.p8': CART + 'print(1)\n',
});

const wsM = (): Files => ({ 'r1/own.p8': CART + 'print(nope)\n', 'r1/lib.lua': 'print(foo)\n', 'r2/main.p8': CART + 'foo=1\n#include ../r1/lib.lua\n' });

describe('a workspace past the budget', function () {
  this.timeout(120000);

  before(() => {
    fs.writeFileSync(BIG, CART + '--[[' + 'x'.repeat(20000100) + ']]\n');
  });

  after(() => {
    fs.rmSync(BIG, { force: true });
  });

  it('wsA: a .lua file whose cart is in its folder', async () => {
    const looks = await bothWays({ 'proj/main.p8': CART + 'foo=1\n#include lib.lua\nprint(nope)\n', 'proj/lib.lua': 'print(foo)\nbar=foo+1\nprint(baz)\n' },
      [ '.' ], async (session, at, look) => {
        await session.openFile(at('proj/lib.lua'));
        look('proj/lib.lua');
      }, { fixed: true });
    deepStrictEqual(looks, [[ '3:6 undefined variable: baz' ]]);
  });

  it('wsB: many folders of a cart and its .lua file', async () => {
    const files: Files = {};
    for (let i = 0; i < 20; i++) {
      files[`runs/c${i}/main.p8`] = CART + 'foo=1\n#include lib.lua\n';
      files[`runs/c${i}/lib.lua`] = 'print(foo)\n';
    }
    const looks = await bothWays(files, [ '.' ], async (session, at, look) => {
      await session.openFile(at('runs/c7/lib.lua'));
      look('runs/c7/lib.lua');
    }, { fixed: true });
    deepStrictEqual(looks, [[]]);
  });

  it('wsM: a cart in another workspace folder that includes the open file', async () => {
    for (const folders of [[ 'r1', 'r2' ], [ 'r2', 'r1' ]]) {
      const looks = await bothWays(wsM(), folders, async (session, at, look) => {
        await session.openFile(at('r1/lib.lua'));
        look('r1/lib.lua');
      }, { fixed: true });
      deepStrictEqual(looks, [[]]);
    }
  });

  it('startup: a file that the editor opens before the first scan ends, in either folder order, shows no problems from a partial scan', async () => {
    for (const folders of [[ 'r1', 'r2' ], [ 'r2', 'r1' ]]) {
      const looks = await bothWays(wsM(), folders, (session, at, look) => {
        eq(session.log.some(({ uri }) => uri === pathToFileURL(at('r1/lib.lua'))), true, 'r1/lib.lua is published once the scan ends');
        look('r1/lib.lua');
        return Promise.resolve();
      }, { fixed: true, openFirst: [ 'r1/lib.lua' ] });
      deepStrictEqual(looks, [[]]);
    }
  });

  it('addFolder: a workspace folder added later with a cart that includes the open file', async () => {
    const looks = await bothWays(wsM(), [ 'r1' ], async (session, at, look) => {
      await session.openFile(at('r1/lib.lua'));
      look('r1/lib.lua');
      await session.addFolder(at('r2'));
      look('r1/lib.lua');
    });
    deepStrictEqual(looks, [[ '1:6 undefined variable: foo' ], []]);
  });

  it('wsR: a cart in another folder that includes the open file', async () => {
    const looks = await bothWays(wsR(), [ '.' ], async (session, at, look) => {
      await session.openFile(at('a/lib.lua'));
      look('a/lib.lua');
    }, { fixed: true });
    deepStrictEqual(looks, [[]]);
  });

  it('rename: the folder of that cart renamed, with no publish that shows the cart missing', async () => {
    const looks = await bothWays(wsR(), [ '.' ], async (session, at, look) => {
      await session.openFile(at('a/lib.lua'));
      fs.renameSync(at('zz'), at('zy'));
      await session.watch([[ 3, at('zz') ], [ 1, at('zy') ]], 1);
      look('a/lib.lua');
      await session.openFile(at('zy/main.p8'));
      look('zy/main.p8');
    }, { fixed: true });
    deepStrictEqual(looks, [[], []]);
  });

  it('lifecycle: that cart changed on the disk, opened, edited, closed, deleted and made again', async () => {
    const main = CART + 'foo=1\n#include ../a/lib.lua\n';
    const looks = await bothWays(wsR(), [ '.' ], async (session, at, look) => {
      const lib = 'a/lib.lua';
      await session.openFile(at(lib));
      look(lib);
      fs.writeFileSync(at('zz/main.p8'), CART + 'foo=1\n');
      await session.watch([[ 2, at('zz/main.p8') ]]);
      look(lib);
      fs.writeFileSync(at('zz/main.p8'), main);
      await session.watch([[ 2, at('zz/main.p8') ]]);
      look(lib);
      await session.openFile(at('zz/main.p8'));
      look(lib);
      await session.change(at('zz/main.p8'), CART + 'foo=1\n');
      look(lib);
      await session.close(at('zz/main.p8'));
      look(lib);
      fs.unlinkSync(at('zz/main.p8'));
      await session.watch([[ 3, at('zz/main.p8') ]]);
      look(lib);
      fs.writeFileSync(at('zz/main.p8'), main);
      await session.watch([[ 1, at('zz/main.p8') ]], 1);
      look(lib);
      await session.close(at(lib));
      look(lib);
    });
    const foo = [ '1:6 undefined variable: foo' ];
    deepStrictEqual(looks, [[], foo, [], [], foo, [], foo, [], []]);
  });

  it('wsS: a file that a cart and a .lua file include, which an included file includes in turn', async () => {
    const looks = await bothWays({
      'a/two.p8': CART + '#include u.lua\n',
      'a/u.lua': 'print(foo)\n',
      'a/m.lua': 'foo=1\n#include u.lua\n',
      'zz/main.p8': CART + '#include x.lua\n',
      'zz/x.lua': '#include ../a/m.lua\n',
    }, [ '.' ], async (session, at, look) => {
      await session.openFile(at('a/u.lua'));
      look('a/u.lua');
    });
    deepStrictEqual(looks, [[]]);
  });

  it('wsT2: two carts include the open file, one in another folder; then that cart opened and closed', async () => {
    const looks = await bothWays({
      'a/one.p8': CART + 'foo=1\nbar=1\n#include lib.lua\n',
      'a/lib.lua': 'print(foo)\nprint(bar)\nprint(baz)\n',
      'zz/main.p8': CART + 'foo=1\n#include ../a/lib.lua\n',
      'zz/y1.p8': CART + 'print(1)\n',
    }, [ '.' ], async (session, at, look) => {
      await session.openFile(at('a/lib.lua'));
      look('a/lib.lua');
      await session.openFile(at('zz/main.p8'));
      look('zz/main.p8');
      await session.close(at('zz/main.p8'));
      look('a/lib.lua');
    }, { fixed: true });
    deepStrictEqual(looks, [[ '3:6 undefined variable: baz' ], [], [ '3:6 undefined variable: baz' ]]);
  });

  it('wsE: a .lua file that leaves a block open for the cart in another folder to close', async () => {
    const hovers: (string | undefined)[] = [];
    const looks = await bothWays({
      'a/own.p8': CART + 'print(1)\n',
      'a/lib.lua': 'if foo then\nprint(1)\n',
      'zz/main.p8': CART + 'foo=1\n#include ../a/lib.lua\nend\n',
    }, [ '.' ], async (session, at, look) => {
      await session.openFile(at('a/lib.lua'));
      look('a/lib.lua');
      hovers.push(await session.hover(at('a/lib.lua'), 0, 4));
    }, { fixed: true });
    deepStrictEqual(looks, [[]]);
    deepStrictEqual(hovers.map(hover => hover?.includes('foo = 1')), [ true, true ]);
  });

  it('asked whether a file belongs to a cart, then that cart changed on the disk and a file it includes opened', async () => {
    const hovers: (string | undefined)[] = [];
    const answers: boolean[] = [];
    const looks = await bothWays({
      'lib/x.lua': 'print(1)\n',
      'zz/main.p8': CART + '#include ../lib/x.lua\n#include f.lua\n',
      'zz/f.lua': 'print(bar)\n',
    }, [ '.' ], async (session, at, look) => {
      answers.push(await session.belongsToCart(at('lib/x.lua')));
      fs.writeFileSync(at('zz/main.p8'), CART + 'bar=1\n#include ../lib/x.lua\n#include f.lua\n');
      await session.watch([[ 2, at('zz/main.p8') ]]);
      await session.openFile(at('zz/f.lua'));
      look('zz/f.lua');
      hovers.push(await session.hover(at('zz/f.lua'), 0, 7));
    });
    deepStrictEqual([ looks, answers, hovers.map(hover => hover?.includes('bar = 1')) ], [[[]], [ true, true ], [ true, true ]]);
  });

  it('crosses the budget both ways in one session, with no publish at any moment that a full read does not give', async () => {
    const files: Files = {
      'a/main.p8': CART + '#include f.lua\n#include g.lua\n',
      'a/f.lua': 'print(1)\n',
      'a/g.lua': 'print(foo)\n',
      'b/other.p8': CART + 'foo=1\n#include ../a/g.lua\n',
      'proj/main.p8': CART + 'foo=1\n#include lib.lua\nprint(nope)\n',
      'proj/lib.lua': 'print(foo)\n',
    };
    const opened = [ 'a/f.lua', 'proj/lib.lua' ];
    // What a full read gives every file.
    const within = workspace(files);
    const reference = new Session([ within ]);
    let truth: Map<string, string[]>;
    try {
      await reference.start();
      for (const file of opened) {
        await reference.openFile(path.join(within, file));
      }
      truth = new Map(Object.keys(files).map(file => [ pathToFileURL(path.join(within, file)), reference.problems(path.join(within, file)) ]));
    } finally {
      reference.stop();
      fs.rmSync(within, { recursive: true, force: true });
    }
    deepStrictEqual(truth.get(pathToFileURL(path.join(within, 'proj/main.p8'))), [ '6:6 undefined variable: nope' ]);
    deepStrictEqual(truth.get(pathToFileURL(path.join(within, 'a/g.lua'))), []);

    const dir = workspace(files, 'big/huge.p8');
    const at = (file: string) => path.join(dir, ...file.split('/'));
    const truthHere = new Map([ ...truth ].map(([ uri, problems ]) => [ uri.replace(pathToFileURL(within), pathToFileURL(dir)), problems ]));
    const session = new Session([ dir ]);
    // At the end of each step: past the budget only the open files show problems, as a full read gives them; within it
    // every file does.
    const state = (pastBudget: boolean) => Object.keys(files).map(file =>
      deepStrictEqual(session.problems(at(file)), pastBudget && !opened.includes(file) ? [] : truthHere.get(pathToFileURL(at(file))), file));
    try {
      await session.start();
      for (const file of opened) {
        await session.openFile(at(file));
      }
      state(true);
      // One batch takes the workspace back within the budget while a file changes, and the user types meanwhile.
      fs.writeFileSync(at('a/main.p8'), files['a/main.p8'] + '\n');
      fs.unlinkSync(at('big/huge.p8'));
      session.sendWatch([[ 2, at('a/main.p8') ], [ 3, at('big/huge.p8') ]]);
      session.sendChange(at('a/f.lua'), 'print(2)\n');
      await session.quiet();
      state(false);
      fs.linkSync(BIG, at('big/huge.p8'));
      await session.watch([[ 1, at('big/huge.p8') ]], 1);
      state(true);
      await session.setExclude({ big: true });
      state(false);
      await session.setExclude({}, 1);
      state(true);
      eq(session.messages.length, 1);
      deepStrictEqual(falsePublishes(session.log, truthHere, false), []);
    } finally {
      session.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
