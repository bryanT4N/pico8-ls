import {
  CompletionItem, CompletionItemTag, createConnection, DefinitionParams,
  DidChangeConfigurationNotification, DocumentSymbolParams,
  FileChangeType, FoldingRange, FoldingRangeParams, Hover, HoverParams, InitializeParams, InitializeResult, MessageType, Position, ProposedFeatures,
  ReferenceParams, ShowMessageNotification, SignatureHelp, SignatureHelpParams, TextDocumentPositionParams,
  TextDocuments, TextDocumentSyncKind, WorkspaceFolder, WorkspaceSymbolParams,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import Parser from './parser/parser';
import { boundsToString } from './parser/types';
import { isParseError } from './parser/errors';
import { builtinInfo } from './parser/builtins';
import ResolvedFile, { fileText, hasP8Extension, pathToFileURL } from './parser/file-resolver';
import { Chunk } from './parser/statements';
import {
  DISK_OPERATIONS, forgetWatched, IncludesNoted, isScanned, isUnder, isWatched, listP8AndLuaFiles, makeFileResolver, nearP8File, onDisk,
  ProjectDocument, ProjectIndex, readFoldersWithinBudget, ScanBudget, scansFolder, setExcludes, smallFoldersFirst,
} from './projects';
import { Exclude, excludeOf } from './files-exclude';
import * as url from 'url';
import * as fs from 'fs';
import * as path from 'path';
import { buildDocumentSymbols } from './document-symbols';
import { computeFoldingRanges } from './folding-ranges';
import { completionItems, completionRequestAt, Offered, resolveUserItem, wordAt } from './completion';
import { builtinMarkdown } from './hover';
import { builtinSignatureHelp, CallContext, callContextAt } from './signature-help';
import { DEFAULT_SETTINGS, PicoSettings, settingsFrom } from './settings';
import { guarded } from './guarded';

console.log('PICO-8-LS language server starting.');

const connection = createConnection(ProposedFeatures.all);

const documents = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;

const diskText = new Map<string, string>();

let workspaceRoots: string[] = [];

// The index asks whether a file belongs for every file it settles, so the folders that hold a .p8 file are kept as a
// set.
const p8Files = new Set<string>();
let p8Folders: Set<string> | undefined;

function addP8File(filePath: string) {
  p8Files.add(path.normalize(filePath));
  p8Folders = undefined;
}

function deleteP8File(filePath: string) {
  p8Files.delete(path.normalize(filePath));
  p8Folders = undefined;
}

function hasP8File(folder: string): boolean {
  p8Folders ??= new Set([ ...p8Files ].map(p8File => path.dirname(p8File)));
  return p8Folders.has(folder);
}

// Reads the disk, for a file the scan has not seen yet, or one outside the workspace folders.
function folderHasP8File(folder: string): boolean {
  try {
    return fs.readdirSync(folder).some(name => hasP8Extension(name) && isFile(path.join(folder, name)));
  } catch {
    return false;
  }
}

function pathOf(uri: string): string | undefined {
  try {
    return url.fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

// The scans stop reading files for the project-wide features once the text of the files read passes this many
// characters (ScanBudget). At the most the index was measured to keep for a character, 43 bytes, that is about 860 MB,
// a fifth of the 4 GB heap of the Node that VS Code runs the server in.
const SCAN_BUDGET = 20000000;
const budget = new ScanBudget(SCAN_BUDGET);
let budgetShown = false;

// The index asks while it changes, so this answers false for a URI that is not a file's rather than throw. Past the
// budget, a file the index does not hold yet is one only while it is open.
function isMember(uri: string): boolean {
  return documents.get(uri) !== undefined || (isScanMember(uri) && (!budget.reached || index.document(uri) !== undefined));
}

function isScanMember(uri: string): boolean {
  const filePath = pathOf(uri);
  return filePath !== undefined && isScanned(filePath, workspaceRoots)
    && (hasP8Extension(filePath) || nearP8File(filePath, workspaceRoots, hasP8File));
}

// The .p8 files a file can belong to, those of its folder and the folders above it that the scans found, which the
// index does not hold.
function p8FilesNotReadFor(filePath: string): string[] {
  return [ ...p8Files ].filter(p8File => isUnder(filePath, path.dirname(p8File))).map(p8File => pathToFileURL(p8File))
    .filter(uri => !index.document(uri));
}

const fileResolver = makeFileResolver(uri => documents.get(uri)?.getText(), diskText);

// What the files past the budget #include. A file that one the index does not hold includes gives no
// undefined-variable warnings, as that one can define the names it uses; a .p8 file is a root whoever includes it, and
// gives the warnings of its own project.
const includesPastBudget = new IncludesNoted();
const index: ProjectIndex = new ProjectIndex(parseFile, isMember, uri => !hasP8Extension(uri)
  && includesPastBudget.includersOf(url.fileURLToPath(uri)).some(includer => !index.document(includer)));

// The client asks again whether its open lua documents belong to a .p8 file, and switches those that do to PICO-8
// Lua.
function notifyMembershipChanged() {
  connection.sendNotification('pico-8-ls/didChangeCartFiles');
}

function initializeResult(): InitializeResult {
  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      completionProvider: { triggerCharacters: [ '.', ':' ], resolveProvider: true },
      hoverProvider: true,
      signatureHelpProvider: { triggerCharacters: [ '(' ], retriggerCharacters: [ ',' ] },
      foldingRangeProvider: true,
    },
  };

  if (hasWorkspaceFolderCapability) {
    // Let the client know we support workspace folders (if they do)
    result.capabilities.workspace = {
      workspaceFolders: { supported: true },
    };
  }

  return result;
}

// The fallback takes the client to support neither workspace/configuration nor workspace folders.
connection.onInitialize(guarded('read the client capabilities', initializeResult, (params: InitializeParams) => {
  const capabilities = params.capabilities;

  // Does the client support the `workspace/configuration` request?
  // If not, we fall back using global settings.
  hasConfigurationCapability = !!(capabilities.workspace && capabilities.workspace.configuration);
  hasWorkspaceFolderCapability = !!(capabilities.workspace && capabilities.workspace.workspaceFolders);

  return initializeResult();
}));

connection.onInitialized(() => {
  if (hasConfigurationCapability) {
    // Register for all config changes
    // The "void" here is so we don't get a "floating promise" warning
    void connection.client.register(DidChangeConfigurationNotification.type, undefined);
  }

  if (hasWorkspaceFolderCapability) {
    connection.workspace.onDidChangeWorkspaceFolders(event => {
      const removed = event.removed.map(folder => url.fileURLToPath(folder.uri));
      const added = event.added.map(folder => url.fileURLToPath(folder.uri));
      workspaceRoots = [ ...workspaceRoots.filter(root => !removed.includes(root)), ...added ];
      for (const p8File of [ ...p8Files ]) {
        if (!isScanned(p8File, workspaceRoots)) {
          deleteP8File(p8File);
        }
      }
      // The file watcher reports nothing under a removed folder, so an includer reads such a file from the disk from
      // now on, as textOf keeps the text of none that the watcher does not report.
      for (const uri of [ ...diskText.keys() ]) {
        const filePath = pathOf(uri);
        if (filePath === undefined || !isWatched(filePath, workspaceRoots)) {
          diskText.delete(uri);
        }
      }
      const joined = index.joins();
      const resend = index.prune();
      const noted = includesPastBudget.changes;
      includesPastBudget.forget(uri => !isScanned(url.fileURLToPath(uri), workspaceRoots));
      // A file that left gets empty diagnostics, which clears its warnings from the Problems panel. With none leaving
      // and no project changing there is nothing to send here: the scan of an added folder that finds files for the
      // index sends every file's diagnostics, and otherwise nothing changed. A file can still join, one whose parse
      // failed before, and it gets its diagnostics too.
      if (resend.length > 0 || index.joins() > joined || includesPastBudget.changes > noted) {
        publish([ ...index.uris(), ...resend ]);
      }
      // A file under a removed folder and in a dot-folder of it can now belong to a .p8 file in its own folder.
      if (removed.length > 0 || index.joins() > joined) {
        notifyMembershipChanged();
      }
      void fetchExcludes();
      Promise.all(event.added.map(scanWorkspaceFolder)).catch(e => {
        console.log('Error scanning workspace folders', e);
      });
    });
  }

  // The scan does not wait for the settings, which a client can leave unanswered; once they come, the diagnostics are
  // sent again with their limit, and the files that files.exclude hides leave.
  scanWorkspace();
  fetchGlobalSettings().then(() => publish(index.uris())).catch(e => {
    console.error('Failed to send the diagnostics', e);
  });
});

function scanWorkspace() {
  connection.workspace.getWorkspaceFolders().then((workspaceFolders: WorkspaceFolder[] | null) => {
    if (!workspaceFolders) {
      return;
    }

    workspaceRoots = workspaceFolders.map(wf => url.fileURLToPath(wf.uri));
    void fetchExcludes();
    Promise.all(workspaceFolders.map(scanWorkspaceFolder)).catch(e => {
      console.log('Error scanning workspace folders', e);
    });
  }).catch(reason => {
    console.log('Failed to get workspace folder(s):', reason);
  });
}

function scanWorkspaceFolder(workspaceFolder: WorkspaceFolder): Promise<void> {
  return scanFolder(url.fileURLToPath(workspaceFolder.uri));
}

// Each workspace folder's files.exclude as the client last gave it. A scan takes the files it lists to the index by the
// files.exclude it has then, so a change after that is applied to the index once no scan is running (rescan): it drops
// the files now hidden, and lists the folders again when something may have been left out, by the files.exclude of
// before or by the budget.
let excludeSettings = new Map<string, string>();
let excludesHide = false;
let scansRunning = 0;
let scansTookFiles = false;
let rescanWanted: 'drop' | 'list' | undefined;
// The scans take their files to the budget one after another, in the order they started, so that the files read do
// not depend on which listing or read ends first.
let lastBudgetTurn = Promise.resolve();

async function scanFolder(folderPath: string, onlyNew = false, alsoPublish: string[] = []): Promise<void> {
  let published = false;
  let toPublish = alsoPublish;
  const turn = lastBudgetTurn;
  let endTurn!: () => void;
  lastBudgetTurn = new Promise(resolve => {
    endTurn = resolve;
  });
  scansRunning++;
  try {
    // A folder inside a workspace folder is listed as the scan of the outermost one that reaches it would list it.
    const from = workspaceRoots.filter(root => scansFolder(folderPath, [ root ]))
      .reduce((outer, root) => path.normalize(root).length < path.normalize(outer).length ? root : outer, folderPath);
    const allFiles = await listP8AndLuaFiles(folderPath, from);
    await turn;

    // The folder can have been removed while it was being listed.
    for (const filePath of allFiles) {
      if (hasP8Extension(filePath) && isScanned(filePath, workspaceRoots)) {
        addP8File(filePath);
      }
    }
    // A .lua file that belongs to no .p8 file is not read at all, so a folder of plain Lua costs only its listing. One
    // that an #include waits for is read, as it is when the file watcher reports it.
    const members = smallFoldersFirst(allFiles).map(filePath => pathToFileURL(filePath))
      .filter(uri => (isMember(uri) || index.isAwaited(uri)) && !(onlyNew && index.document(uri)));
    scansTookFiles = true;
    const noted = includesPastBudget.changes;
    const read = await readWithinBudget(members);
    endTurn();
    if (includesPastBudget.changes > noted) {
      toPublish = [ ...alsoPublish, ...index.uris() ];
    }
    if (budget.reached) {
      // Past the budget the files open in the editor still get every feature, with the .p8 files they belong to.
      for (const document of documents.all()) {
        const filePath = pathOf(document.uri);
        read.push(...filePath === undefined ? [] : p8FilesNotReadFor(filePath));
      }
      tellBudgetReached();
    }

    // The folder can have been removed while its files were being read, when the index did not have them yet for the
    // removal to drop. Files open in the editor stay, as they do when a folder is removed.
    const stillMembers = new Set(read.filter(uri => documents.get(uri) || isScanMember(uri) || index.isAwaited(uri)));
    for (const uri of read) {
      if (!stillMembers.has(uri)) {
        diskText.delete(uri);
      }
    }
    // A scan of no file would send every file's diagnostics again.
    if (stillMembers.size > 0) {
      publish([ ...toPublish, ...index.scan([ ...stillMembers ]) ]);
      published = true;
    }
  } finally {
    endTurn();
    // Also after a scan that failed, so that whatever waits for the end of the scan is not left waiting.
    if (!published) {
      publish(toPublish);
    }
    notifyMembershipChanged();
    scansRunning--;
    if (rescanWanted !== undefined && scansRunning === 0) {
      rescan();
    }
  }
}

// Once in a session.
function tellBudgetReached(): void {
  if (budgetShown) {
    return;
  }
  budgetShown = true;
  const files = `${budget.files.toLocaleString('en-US')} ${budget.files === 1 ? 'file' : 'files'}`;
  connection.sendNotification(ShowMessageNotification.type, { type: MessageType.Warning,
    message: `PICO-8-LS read ${files} and left out the rest, to keep its memory in bounds: workspace symbols and the problems of files `
      + 'that are not open leave them out. Of the rest it reads only the #include lines, and a .lua file that one of them includes shows '
      + 'no undefined-variable warnings. To have it read everything, exclude large folders you do not work on with files.exclude.' });
}

// Reads the files in order while the budget lasts, and returns those it read; of the rest it notes the #include lines.
// The text of a file that the file watcher does not report would go stale; textOf reads such a file again when it is
// parsed.
async function readWithinBudget(uris: string[]): Promise<string[]> {
  const found = await readFoldersWithinBudget(uris, budget, DISK_OPERATIONS, uri => {
    const filePath = url.fileURLToPath(uri);
    return onDisk(() => fs.promises.readFile(filePath)).then(fileText, e => {
      console.error('Error reading ' + filePath, e);
      return undefined;
    });
  }, (uri, text) => includesPastBudget.note(uri, text));
  for (const { uri, text } of found) {
    if (isWatched(url.fileURLToPath(uri), workspaceRoots)) {
      diskText.set(uri, text);
    }
  }
  return found.map(({ uri }) => uri);
}

async function fetchExcludes(): Promise<void> {
  if (!hasConfigurationCapability || workspaceRoots.length === 0) {
    return;
  }
  const roots = [ ...workspaceRoots ];
  let given: unknown[];
  try {
    given = await connection.workspace.getConfiguration(roots.map(root => ({ scopeUri: pathToFileURL(root), section: 'files.exclude' })));
  } catch (e) {
    console.error('Failed to get files.exclude', e);
    return;
  }
  const settings = new Map(roots.map((root, i) => [ root, JSON.stringify(given[i] ?? null) ]));
  if (settings.size === excludeSettings.size && [ ...settings ].every(([ root, setting ]) => excludeSettings.get(root) === setting)) {
    return;
  }
  excludeSettings = settings;
  const byRoot = new Map<string, Exclude>();
  roots.forEach((root, i) => {
    const exclude = excludeOf(given[i]);
    if (exclude) {
      byRoot.set(root, exclude);
    }
  });
  setExcludes(byRoot);
  if (scansTookFiles) {
    rescanWanted = rescanWanted === 'list' || excludesHide || budget.reached ? 'list' : 'drop';
    if (scansRunning === 0) {
      rescan();
    }
  }
  excludesHide = byRoot.size > 0;
}

// After files.exclude changed: the files it now hides leave, unless they are open or a root includes them, and when
// something may have been left out the workspace folders are listed again, with the budget counted from what is left.
function rescan(): void {
  const list = rescanWanted === 'list';
  rescanWanted = undefined;
  for (const p8File of [ ...p8Files ]) {
    if (!isScanned(p8File, workspaceRoots)) {
      deleteP8File(p8File);
    }
  }
  const joined = index.joins();
  const resend = index.prune();
  // The scans below note again what the files past the budget include, and the files that are now hidden include
  // nothing.
  const noted = includesPastBudget.changes;
  includesPastBudget.forget(uri => !isScanned(url.fileURLToPath(uri), workspaceRoots));
  budget.restart(index.uris().map(uri => index.document(uri)!.textDocument.getText().length));
  publish(includesPastBudget.changes > noted ? [ ...index.uris(), ...resend ] : resend);
  if (index.joins() > joined || resend.length > 0) {
    notifyMembershipChanged();
  }
  for (const root of list ? workspaceRoots : []) {
    void scanFolder(root, true).catch(e => {
      console.error('Error scanning ' + root, e);
    });
  }
}

function parseFile(uri: string): ProjectDocument | undefined {
  const text = textOf(uri);
  if (text === undefined) {
    return undefined;
  }
  const chunk = parseText(uri, text);
  if (!chunk) {
    return undefined;
  }
  const textDocument = documents.get(uri) ?? TextDocument.create(uri, uri.endsWith('p8') ? 'pico-8' : 'pico-8-lua', 0, text);
  return { textDocument, chunk, errors: chunk.errors };
}

function textOf(uri: string): string | undefined {
  const document = documents.get(uri);
  if (document) {
    return document.getText();
  }
  try {
    const filePath = url.fileURLToPath(uri);
    if (!fileResolver.doesFileExist(filePath)) {
      return undefined;
    }
    const kept = diskText.has(uri);
    const text = fileResolver.loadFileContents(filePath);
    // A file the scan did not read, like one only an #include brings in, is kept too, so that its includers do not read
    // the disk on every keystroke; only where the file watcher keeps it current.
    if (!kept && isWatched(filePath, workspaceRoots)) {
      diskText.set(uri, text);
    }
    return text;
  } catch (e) {
    console.error('Error reading ' + uri, e);
    return undefined;
  }
}

function parseText(uri: string, text: string): Chunk | undefined {
  try {
    return new Parser(ResolvedFile.fromFileURL(uri), text, { includeFileResolver: fileResolver }).parse();
  } catch (e) {
    if (isParseError(e)) {
      console.error(`ParseError: ${e.stack ? e.stack : e.message}\nBounds: ${boundsToString(e.bounds)}`);
    } else {
      console.error(e);
    }
    return undefined;
  }
}

function publish(uris: string[]) {
  for (const diagnostics of index.diagnostics(uris, globalSettings.maxNumberOfProblems)) {
    connection.sendDiagnostics(diagnostics);
  }
  // The file watcher skips a file that belongs to no .p8 file, so the text of one that left would not be kept current.
  for (const uri of uris) {
    if (!index.document(uri)) {
      diskText.delete(uri);
    }
  }
}

// Diagnostics are sent synchronously after each parse, so they take the limit last fetched rather than asking for the
// settings each time.
let globalSettings = DEFAULT_SETTINGS;

async function fetchGlobalSettings() {
  if (!hasConfigurationCapability) {
    return;
  }
  try {
    takeSettings(await connection.workspace.getConfiguration('pico-8-ls') as PicoSettings);
  } catch (e) {
    console.error('Failed to get the pico-8-ls settings', e);
  }
}

// VS Code keeps the outline it has until it is asked again, which the client does on the notification. The first
// settings count too: the scan does not wait for them, so an outline given before they came had the defaults.
function takeSettings(given: PicoSettings) {
  const { settings, outlineChanged } = settingsFrom(given, globalSettings);
  globalSettings = settings;
  if (outlineChanged) {
    connection.sendNotification('pico-8-ls/didChangeOutlineOptions');
  }
}

// Past the budget a file opened in the editor still gets every feature, with the .p8 files it belongs to; the file
// itself joins as its content comes.
documents.onDidOpen(({ document }) => {
  const filePath = pathOf(document.uri);
  const unread = budget.reached && filePath !== undefined ? p8FilesNotReadFor(filePath) : [];
  if (unread.length > 0) {
    publish(index.scan(unread));
  }
});

documents.onDidChangeContent(change => {
  const joined = index.joins();
  publish(index.update(change.document.uri));
  if (index.joins() > joined) {
    notifyMembershipChanged();
  }
});

documents.onDidClose(e => {
  const joined = index.joins();
  const uri = e.document.uri;
  const filePath = pathOf(uri);
  let text: string | undefined;
  try {
    text = fileText(fs.readFileSync(url.fileURLToPath(uri)));
  } catch (err) {
    console.error('Error reading closed file ' + uri, err);
  }
  if (text === undefined) {
    diskText.delete(uri);
    publish(index.remove(uri));
  } else {
    // Where the file watcher does not keep the text current, outside the workspace folders or under a link, it is read
    // again when it is needed.
    if (filePath !== undefined && isWatched(filePath, workspaceRoots)) {
      diskText.set(uri, text);
    } else {
      diskText.delete(uri);
    }
    publish(index.update(uri));
  }
  // The text on the disk can #include files that the text in the editor did not.
  if (index.joins() > joined) {
    notifyMembershipChanged();
  }
});

connection.onDidChangeConfiguration(change => {
  if (!hasConfigurationCapability) {
    takeSettings(change.settings?.['pico-8-ls']);
  }

  fetchGlobalSettings().then(() => publish(index.uris())).catch(e => {
    console.error('Failed to send the diagnostics', e);
  });
  void fetchExcludes();
});

connection.onDocumentSymbol(guarded('build the outline', () => [], (params: DocumentSymbolParams) => {
  const { uri } = params.textDocument;
  const document = index.document(uri);
  if (!document) {
    return [];
  }
  return buildDocumentSymbols(document.textDocument, document.chunk.comments ?? [], index.outline(uri, globalSettings.outline));
}));

connection.onWorkspaceSymbol(guarded('give workspace symbols', () => [], (params: WorkspaceSymbolParams) => {
  return index.workspaceSymbols(params.query, globalSettings.outline);
}));

// The client asks for a lua document, uri in VS Code's form, to give it the PICO-8 Lua language. True when a project
// root of the index #includes it, whatever its name, as PICO-8 does; or when it is a .lua file and a .p8 file is in
// its folder or a folder above it, so that a file such as notes.txt that the user shows as Lua keeps that language.
// Only the search for a .p8 file reads the disk, so that the answer does not wait for the scan to find the .p8 files.
connection.onRequest('pico-8-ls/belongsToCart', guarded('tell whether a file belongs to a .p8 file', () => false, (params: { uri: string }) => {
  const filePath = pathOf(params.uri);
  return filePath !== undefined
    && (index.isIncluded(params.uri) || (/\.lua$/i.test(filePath) && nearP8File(filePath, workspaceRoots, folderHasP8File)));
}));

function offsetOf(params: TextDocumentPositionParams): number | undefined {
  return documents.get(params.textDocument.uri)?.offsetAt(params.position);
}

connection.onDefinition(guarded('give definitions', () => [], (params: DefinitionParams) => {
  const offset = offsetOf(params);
  return offset === undefined ? [] : index.definitions(params.textDocument.uri, offset);
}));

connection.onReferences(guarded('give references', () => [], (params: ReferenceParams) => {
  const offset = offsetOf(params);
  return offset === undefined ? [] : index.references(params.textDocument.uri, offset, params.context.includeDeclaration);
}));

connection.onDidChangeWatchedFiles(change => {
  if (change.changes.some(({ type }) => type !== FileChangeType.Changed)) {
    forgetWatched();
  }
  const joined = index.joins();
  const noted = includesPastBudget.changes;
  const uris: string[] = [];
  const newP8Files: string[] = [];
  const newFolders: string[] = [];
  let p8FileDeleted = false;
  for (const { uri, type } of change.changes) {
    const filePath = pathOf(uri);
    if (filePath === undefined) {
      continue;
    }
    if (type === FileChangeType.Deleted) {
      // A folder that is deleted or renamed is reported alone, without the files under it. A tool that deletes a folder
      // file by file can send an event for each, when its deletes span the watcher's batches, so the files the server
      // keeps are matched as text, without converting or normalizing each: a .p8 file by its path, spelled as filePath
      // is, any other file by its URI, in VS Code's form as the event's is.
      const gone = (other: string, folder: string, separator: string) => other === folder || other.startsWith(folder + separator);
      for (const p8File of [ ...p8Files ].filter(p8File => gone(p8File, filePath, path.sep))) {
        deleteP8File(p8File);
        p8FileDeleted = true;
      }
      for (const cached of [ ...diskText.keys() ].filter(cached => gone(cached, uri, '/'))) {
        diskText.delete(cached);
      }
      includesPastBudget.forget(includer => gone(includer, uri, '/'));
      const removed = index.uris().filter(indexed => !documents.get(indexed) && gone(indexed, uri, '/'));
      if (removed.length > 0) {
        uris.push(...index.removeAll(removed));
      }
      continue;
    }
    const named = /\.(p8|lua)$/i.test(filePath);
    if (type === FileChangeType.Created) {
      // A folder that appears with its files, as a renamed one does, is reported alone. The files under it that an
      // #include waits for and that no scan lists, as in a dot-folder, are parsed here.
      const awaited = index.awaitedUnder(uri).filter(file => !isScanned(url.fileURLToPath(file), workspaceRoots));
      if (awaited.length > 0) {
        uris.push(...index.scan(awaited));
      }
      const toScan = scansFolder(filePath, workspaceRoots) && !newFolders.some(folder => isUnder(filePath, folder));
      // A folder can have a name like a .p8 file's or a .lua file's, such as json.lua.
      if ((toScan || named) && isFolder(filePath)) {
        if (toScan) {
          newFolders.push(filePath);
        }
        continue;
      }
    }
    if (!named) {
      continue;
    }
    // A file in a dot-folder is in the index when a project root of the index #includes it, and an #include can wait
    // for one to appear.
    const known = index.document(uri) !== undefined;
    if (!known && !isScanned(filePath, workspaceRoots) && !index.isAwaited(uri)) {
      continue;
    }
    if (type === FileChangeType.Created && hasP8Extension(filePath) && isScanned(filePath, workspaceRoots)) {
      addP8File(filePath);
      newP8Files.push(filePath);
    }
    // Of a file that the scans would read but for the budget, the #include lines are noted.
    const pastBudget = !known && !isMember(uri) && !index.isAwaited(uri);
    if (pastBudget && !(budget.reached && isScanMember(uri))) {
      continue;
    }
    let text: string | undefined;
    try {
      text = fileText(fs.readFileSync(filePath));
    } catch (e) {
      console.error('Error reading ' + uri, e);
    }
    // A file that joins as a member takes from the budget, as the scan's files do.
    if (pastBudget || (!known && text !== undefined && !documents.get(uri) && !index.isAwaited(uri) && !budget.take([ text.length ]))) {
      if (text !== undefined) {
        includesPastBudget.note(uri, text);
      }
      tellBudgetReached();
      continue;
    }
    if (text !== undefined && isWatched(filePath, workspaceRoots)) {
      diskText.set(uri, text);
    }
    if (!documents.get(uri)) {
      uris.push(...index.update(uri));
    }
  }
  if (p8FileDeleted) {
    // The files near the deleted .p8 files that nothing #includes leave; a file that one of them included can now be
    // the root of its own project, and a file whose parse failed before can join.
    const joinedBefore = index.joins();
    const resend = index.prune();
    if (resend.length > 0 || index.joins() > joinedBefore) {
      uris.push(...index.uris(), ...resend);
    }
  }
  if (includesPastBudget.changes > noted) {
    uris.push(...index.uris());
  }
  // The scan of a new .p8 file's folder sends the problems of every file when it parses any, so this batch's go with
  // it, not before.
  if (newP8Files.length === 0) {
    publish(uris);
  }
  // A new .p8 file brings in the .lua files of its folder and the folders below, which the scan left out while no .p8
  // file was near them.
  newP8Files.forEach((p8File, i) => {
    void scanFolder(path.dirname(p8File), true, i === 0 ? uris : []).catch(e => {
      console.error('Error scanning the folder of ' + p8File, e);
    });
  });
  for (const folder of newFolders) {
    void scanFolder(folder).catch(e => {
      console.error('Error scanning ' + folder, e);
    });
  }
  if (index.joins() > joined) {
    notifyMembershipChanged();
  }
});

function isFolder(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

// The user symbols of the last completion list, which the items being resolved come from.
let lastOffered: Offered = new Map();

// This handler provides the initial list of the completion items.
connection.onCompletion(guarded('give completions', () => [], (params: TextDocumentPositionParams): CompletionItem[] => {
  lastOffered = new Map();
  const { uri } = params.textDocument;
  const offset = offsetOf(params);
  const lineText = getTextOnLine(uri, params.position);
  if (offset === undefined || lineText === undefined) {
    return [];
  }
  const { line, character } = params.position;
  return completionItems(index.analyses(uri), ResolvedFile.fromFileURL(uri), offset, completionRequestAt(lineText, character), line, character,
    lastOffered);
}));

connection.onCompletionResolve(guarded('resolve a completion item', item => item, (item: CompletionItem) => {
  try {
    if (resolveUserItem(item, lastOffered)) {
      return item;
    }
  } catch (e) {
    console.error('Failed to resolve the completion item ' + item.label, e);
  }

  const name = item.label;

  const info = builtinInfo(name);
  if (info) {
    item.detail = info.sig;
    item.documentation = {
      kind: 'markdown',
      value: builtinMarkdown(name, info),
    };
    if (info.deprecated) {
      item.tags = [ CompletionItemTag.Deprecated ];
    }
  }

  return item;
}));

function getTextOnLine(textDocumentUri: string, position: Position): string | undefined {
  const text = documents.get(textDocumentUri);
  if (!text) {
    return undefined;
  }

  return text.getText({
    start: Position.create(position.line, 0),
    end: Position.create(position.line, Number.MAX_VALUE),
  });
}

connection.onHover(guarded<HoverParams, Hover | null | undefined>('give the hover', () => null, (params: HoverParams) => {
  const offset = offsetOf(params);
  try {
    const value = offset === undefined ? undefined : index.hover(params.textDocument.uri, offset);
    if (value !== undefined) {
      return { contents: { kind: 'markdown', value } };
    }
  } catch (e) {
    console.error('Failed to give the hover', e);
  }

  const textOnLine = getTextOnLine(params.textDocument.uri, params.position);
  if (!textOnLine) {
    return undefined;
  }
  const identifier = wordAt(textOnLine, params.position.character);

  const info = builtinInfo(identifier);
  if (info) {
    return {
      contents: builtinMarkdown(identifier, info),
    };
  }
}));

connection.onSignatureHelp(guarded<SignatureHelpParams, SignatureHelp | null | undefined>('give signature help', () => null, (params: SignatureHelpParams) => {
  const { uri } = params.textDocument;
  const document = documents.get(uri);
  if (!document) {
    return undefined;
  }
  const offset = document.offsetAt(params.position);
  let call: CallContext | undefined;
  try {
    call = callContextAt(document.getText(), offset);
  } catch (e) {
    console.error('Failed to find the call', e);
    return undefined;
  }
  if (!call) {
    return undefined;
  }
  try {
    return index.signatureHelp(uri, offset, call);
  } catch (e) {
    console.error('Failed to give signature help', e);
    return builtinSignatureHelp(call);
  }
}));

connection.onFoldingRanges(guarded('give folding ranges', () => [], (params: FoldingRangeParams): FoldingRange[] => {
  const document = index.document(params.textDocument.uri);
  return document ? computeFoldingRanges(document.textDocument, document.chunk) : [];
}));

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();

console.log('PICO-8 Language Server launched.');
