import { deepStrictEqual, strictEqual as eq } from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMessageConnection, IPCMessageReader, IPCMessageWriter, MessageConnection } from 'vscode-jsonrpc/node';
import { pathToFileURL } from '../parser/file-resolver';

// The server as the editor runs it, over workspaces on the disk, once within the budget and once past it: past it an
// open file is to show what it shows when every file is read, and no other file is to show problems.

const CART = 'pico-8 cartridge // http://www.pico-8.com\nversion 42\n__lua__\n';

type Files = Record<string, string>;

type Diagnostic = { range: { start: { line: number, character: number } }, message: string };

class Session {
  readonly published = new Map<string, Diagnostic[]>();
  readonly messages: string[] = [];
  private scans = 0;
  private heard = 0;
  private readonly connection: MessageConnection;
  private readonly child: cp.ChildProcess;
  private readonly folders: { uri: string, name: string }[];
  private version = 1;

  constructor(folders: string[], budget?: number) {
    this.child = cp.fork(path.join(__dirname, '..', 'server.js'), [ '--node-ipc', `--clientProcessId=${process.pid}` ],
      { silent: true, execArgv: [], env: { ...process.env, PICO8_LS_SCAN_BUDGET: budget === undefined ? '' : String(budget) } });
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
      this.published.set(uri, diagnostics);
    });
    c.onNotification('window/showMessage', ({ message }: { message: string }) => {
      this.heard++;
      this.messages.push(message);
    });
    c.onRequest('client/registerCapability', () => null);
    c.onRequest('workspace/configuration', ({ items }: { items: { section: string }[] }) =>
      items.map(item => item.section === 'files.exclude' ? {} : { maxNumberOfProblems: 100 }));
    c.onRequest('workspace/workspaceFolders', () => this.folders);
    c.listen();
  }

  async start(): Promise<void> {
    await this.connection.sendRequest('initialize', { processId: process.pid, rootUri: this.folders[0].uri, workspaceFolders: this.folders,
      capabilities: { workspace: { configuration: true, workspaceFolders: true, didChangeWatchedFiles: { dynamicRegistration: true } } } });
    this.connection.sendNotification('initialized', {});
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
    return (this.published.get(pathToFileURL(file)) ?? []).map(d => `${d.range.start.line + 1}:${d.range.start.character} ${d.message}`);
  }

  // The files other than these that show problems.
  showing(except: string[]): string[] {
    const open = new Set(except.map(file => pathToFileURL(file)));
    return [ ...this.published ].filter(([ uri, diagnostics ]) => diagnostics.length > 0 && !open.has(uri)).map(([ uri ]) => uri);
  }

  async open(file: string): Promise<void> {
    this.connection.sendNotification('textDocument/didOpen', { textDocument: { uri: pathToFileURL(file),
      languageId: file.endsWith('.p8') ? 'pico-8' : 'pico-8-lua', version: this.version, text: fs.readFileSync(file, 'utf8') } });
    await this.quiet();
  }

  async change(file: string, text: string): Promise<void> {
    this.connection.sendNotification('textDocument/didChange', { textDocument: { uri: pathToFileURL(file), version: ++this.version },
      contentChanges: [{ text }] });
    await this.quiet();
  }

  async close(file: string): Promise<void> {
    this.connection.sendNotification('textDocument/didClose', { textDocument: { uri: pathToFileURL(file) } });
    await this.quiet();
  }

  // 1 created, 2 changed, 3 deleted.
  async watch(changes: [ number, string ][], scans = 0): Promise<void> {
    this.connection.sendNotification('workspace/didChangeWatchedFiles', { changes: changes.map(([ type, file ]) => ({ type, uri: pathToFileURL(file) })) });
    await (scans > 0 ? this.scanned(scans) : this.quiet());
  }

  async addFolder(folder: string): Promise<void> {
    const added = { uri: pathToFileURL(folder), name: path.basename(folder) };
    this.folders.push(added);
    this.connection.sendNotification('workspace/didChangeWorkspaceFolders', { event: { added: [ added ], removed: [] } });
    await this.scanned(1);
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
}

function workspace(files: Files): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'pico8-ls-large-'));
  for (const [ file, text ] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

// Runs the steps over a copy of the files within the budget and over another past it, and compares what the steps saw.
// Past the budget, the files open at each look are the only ones to show problems.
async function bothWays(files: Files, folders: string[],
  steps: (session: Session, at: (file: string) => string, look: (file: string, open: string[]) => string[]) => Promise<void>) {
  const seen: string[][][] = [];
  for (const budget of [ undefined, 1 ]) {
    const dir = workspace(files);
    const session = new Session(folders.map(folder => path.join(dir, folder)), budget);
    const looks: string[][] = [];
    try {
      await session.start();
      const at = (file: string) => path.join(dir, ...file.split('/'));
      await steps(session, at, (file, open) => {
        if (budget !== undefined) {
          deepStrictEqual(session.showing(open.map(at)), [], `past the budget, files show problems at ${file}`);
        }
        const problems = session.problems(at(file));
        looks.push(problems);
        return problems;
      });
      eq(session.messages.length, budget === undefined ? 0 : 1);
    } finally {
      session.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    seen.push(looks);
  }
  deepStrictEqual(seen[1], seen[0]);
  return seen[0];
}

const wsR = (): Files => ({
  'a/own.p8': CART + 'print(1)\n',
  'a/lib.lua': 'print(foo)\n',
  'zz/main.p8': CART + 'foo=1\n#include ../a/lib.lua\n',
  'zz/y1.p8': CART + 'print(1)\n',
});

describe('a workspace past the budget', function () {
  this.timeout(60000);

  it('wsA: a .lua file whose cart is in its folder', async () => {
    const looks = await bothWays({ 'proj/main.p8': CART + 'foo=1\n#include lib.lua\nprint(nope)\n', 'proj/lib.lua': 'print(foo)\nbar=foo+1\nprint(baz)\n' },
      [ '.' ], async (session, at, look) => {
        await session.open(at('proj/lib.lua'));
        look('proj/lib.lua', [ 'proj/lib.lua' ]);
      });
    deepStrictEqual(looks, [[ '3:6 undefined variable: baz' ]]);
  });

  it('wsB: many folders of a cart and its .lua file', async () => {
    const files: Files = {};
    for (let i = 0; i < 20; i++) {
      files[`runs/c${i}/main.p8`] = CART + 'foo=1\n#include lib.lua\n';
      files[`runs/c${i}/lib.lua`] = 'print(foo)\n';
    }
    const looks = await bothWays(files, [ '.' ], async (session, at, look) => {
      await session.open(at('runs/c7/lib.lua'));
      look('runs/c7/lib.lua', [ 'runs/c7/lib.lua' ]);
    });
    deepStrictEqual(looks, [[]]);
  });

  it('wsM: a cart in another workspace folder that includes the open file', async () => {
    const files = { 'r1/own.p8': CART + 'print(1)\n', 'r1/lib.lua': 'print(foo)\n', 'r2/main.p8': CART + 'foo=1\n#include ../r1/lib.lua\n' };
    for (const folders of [[ 'r1', 'r2' ], [ 'r2', 'r1' ]]) {
      const looks = await bothWays(files, folders, async (session, at, look) => {
        await session.open(at('r1/lib.lua'));
        look('r1/lib.lua', [ 'r1/lib.lua' ]);
      });
      deepStrictEqual(looks, [[]]);
    }
  });

  it('addFolder: a workspace folder added later with a cart that includes the open file', async () => {
    const files = { 'r1/own.p8': CART + 'print(1)\n', 'r1/lib.lua': 'print(foo)\n', 'r2/main.p8': CART + 'foo=1\n#include ../r1/lib.lua\n' };
    const looks = await bothWays(files, [ 'r1' ], async (session, at, look) => {
      await session.open(at('r1/lib.lua'));
      look('r1/lib.lua', [ 'r1/lib.lua' ]);
      await session.addFolder(at('r2'));
      look('r1/lib.lua', [ 'r1/lib.lua' ]);
    });
    deepStrictEqual(looks, [[ '1:6 undefined variable: foo' ], []]);
  });

  it('wsR: a cart in another folder that includes the open file', async () => {
    const looks = await bothWays(wsR(), [ '.' ], async (session, at, look) => {
      await session.open(at('a/lib.lua'));
      look('a/lib.lua', [ 'a/lib.lua' ]);
    });
    deepStrictEqual(looks, [[]]);
  });

  it('rename: the folder of that cart renamed', async () => {
    const looks = await bothWays(wsR(), [ '.' ], async (session, at, look) => {
      await session.open(at('a/lib.lua'));
      fs.renameSync(at('zz'), at('zy'));
      await session.watch([[ 3, at('zz') ], [ 1, at('zy') ]], 1);
      look('a/lib.lua', [ 'a/lib.lua' ]);
      await session.open(at('zy/main.p8'));
      look('zy/main.p8', [ 'a/lib.lua', 'zy/main.p8' ]);
    });
    deepStrictEqual(looks, [[], []]);
  });

  it('lifecycle: that cart changed on the disk, opened, edited, closed, deleted and made again', async () => {
    const main = CART + 'foo=1\n#include ../a/lib.lua\n';
    const looks = await bothWays(wsR(), [ '.' ], async (session, at, look) => {
      const lib = 'a/lib.lua';
      await session.open(at(lib));
      look(lib, [ lib ]);
      fs.writeFileSync(at('zz/main.p8'), CART + 'foo=1\n');
      await session.watch([[ 2, at('zz/main.p8') ]]);
      look(lib, [ lib ]);
      fs.writeFileSync(at('zz/main.p8'), main);
      await session.watch([[ 2, at('zz/main.p8') ]]);
      look(lib, [ lib ]);
      await session.open(at('zz/main.p8'));
      look(lib, [ lib, 'zz/main.p8' ]);
      await session.change(at('zz/main.p8'), CART + 'foo=1\n');
      look(lib, [ lib, 'zz/main.p8' ]);
      await session.close(at('zz/main.p8'));
      look(lib, [ lib ]);
      fs.unlinkSync(at('zz/main.p8'));
      await session.watch([[ 3, at('zz/main.p8') ]]);
      look(lib, [ lib ]);
      fs.writeFileSync(at('zz/main.p8'), main);
      await session.watch([[ 1, at('zz/main.p8') ]], 1);
      look(lib, [ lib ]);
      await session.close(at(lib));
      look(lib, []);
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
      await session.open(at('a/u.lua'));
      look('a/u.lua', [ 'a/u.lua' ]);
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
      await session.open(at('a/lib.lua'));
      look('a/lib.lua', [ 'a/lib.lua' ]);
      await session.open(at('zz/main.p8'));
      look('zz/main.p8', [ 'a/lib.lua', 'zz/main.p8' ]);
      await session.close(at('zz/main.p8'));
      look('a/lib.lua', [ 'a/lib.lua' ]);
    });
    deepStrictEqual(looks, [[ '3:6 undefined variable: baz' ], [], [ '3:6 undefined variable: baz' ]]);
  });

  it('wsE: a .lua file that leaves a block open for the cart in another folder to close', async () => {
    const hovers: (string | undefined)[] = [];
    const looks = await bothWays({
      'a/own.p8': CART + 'print(1)\n',
      'a/lib.lua': 'if foo then\nprint(1)\n',
      'zz/main.p8': CART + 'foo=1\n#include ../a/lib.lua\nend\n',
    }, [ '.' ], async (session, at, look) => {
      await session.open(at('a/lib.lua'));
      look('a/lib.lua', [ 'a/lib.lua' ]);
      hovers.push(await session.hover(at('a/lib.lua'), 0, 4));
    });
    deepStrictEqual(looks, [[]]);
    deepStrictEqual(hovers.map(hover => hover?.includes('foo = 1')), [ true, true ]);
  });
});
