import {
  CompletionItem, CompletionItemTag, createConnection, DefinitionParams,
  DidChangeConfigurationNotification, DocumentSymbolParams,
  FileChangeType, FoldingRange, FoldingRangeParams, Hover, HoverParams, InitializeParams, InitializeResult, Position, ProposedFeatures,
  ReferenceParams, SignatureHelp, SignatureHelpParams, TextDocumentPositionParams,
  TextDocuments, TextDocumentSyncKind, WorkspaceFolder, WorkspaceSymbolParams,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import Parser from './parser/parser';
import { boundsToString } from './parser/types';
import { isParseError } from './parser/errors';
import { builtinInfo } from './parser/builtins';
import ResolvedFile, { pathToFileURL } from './parser/file-resolver';
import { Chunk } from './parser/statements';
import { isScanned, isUnder, isWatched, listCartFiles, makeFileResolver, nearCart, ProjectDocument, ProjectIndex, scansFolder } from './projects';
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

// The text of the index's files that the file watcher keeps current, as the scan, the file watcher or a first read took
// it from the disk.
const diskText = new Map<string, string>();

// The paths of the workspace folders, which change as folders are added and removed. Which files belong to a cart
// depends on them: the scan of the folders lists the carts and the .lua files, and a .lua file looks for a cart up to
// the outermost folder that lists it.
let workspaceRoots: string[] = [];

// The carts that the scan and the file watcher found, by path.normalize. The index asks whether a file belongs for
// every file it settles, so the folders that hold a cart are kept as a set, made again after the carts change.
const carts = new Set<string>();
let cartFolders: Set<string> | undefined;

function addCart(filePath: string) {
  carts.add(path.normalize(filePath));
  cartFolders = undefined;
}

function deleteCart(filePath: string) {
  carts.delete(path.normalize(filePath));
  cartFolders = undefined;
}

function hasCart(folder: string): boolean {
  cartFolders ??= new Set([ ...carts ].map(cart => path.dirname(cart)));
  return cartFolders.has(folder);
}

// Reads the disk, for a file the scan has not seen yet, or one outside the workspace folders.
function folderHasCart(folder: string): boolean {
  try {
    return fs.readdirSync(folder).some(name => /\.p8$/i.test(name) && isFile(path.join(folder, name)));
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

// A file open in the editor, a cart the scan lists, or a .lua file the scan lists near a cart. The index asks while it
// changes, so this answers false for a URI that is not a file's rather than throw.
function isMember(uri: string): boolean {
  if (documents.get(uri)) {
    return true;
  }
  const filePath = pathOf(uri);
  return filePath !== undefined && isScanned(filePath, workspaceRoots)
    && (/\.p8$/i.test(filePath) || nearCart(filePath, workspaceRoots, hasCart));
}

const fileResolver = makeFileResolver(uri => documents.get(uri)?.getText(), diskText);

const index = new ProjectIndex(parseFile, isMember);

// The client asks again whether its open lua documents belong to a cart, and switches those that do to PICO-8 Lua.
function notifyCartFiles() {
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
      for (const cart of [ ...carts ]) {
        if (!isScanned(cart, workspaceRoots)) {
          deleteCart(cart);
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
      const left = index.prune();
      // A file that left gets empty diagnostics, which clears its warnings from the Problems panel. With none leaving
      // there is nothing to send here: the scan of an added folder that finds files for the index sends every file's
      // diagnostics, and otherwise nothing changed. A file can still join, one whose parse failed before, and it gets
      // its diagnostics too.
      if (left.length > 0 || index.joins() > joined) {
        publish([ ...index.uris(), ...left ]);
      }
      // A file under a removed folder and in a dot-folder of it can now belong to a cart in its own folder.
      if (removed.length > 0 || index.joins() > joined) {
        notifyCartFiles();
      }
      Promise.all(event.added.map(scanWorkspaceFolder)).catch(e => {
        console.log('Error scanning workspace folders', e);
      });
    });
  }

  // The scan does not wait for the settings, which a client can leave unanswered; once they come, the diagnostics are
  // sent again with their limit.
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

async function scanFolder(folderPath: string, onlyNew = false, alsoPublish: string[] = []): Promise<void> {
  let published = false;
  try {
    // A folder inside a workspace folder is listed as the scan of the outermost one that reaches it would list it.
    const from = workspaceRoots.filter(root => scansFolder(folderPath, [ root ]))
      .reduce((outer, root) => path.normalize(root).length < path.normalize(outer).length ? root : outer, folderPath);
    const allFiles = await listCartFiles(folderPath, from);

    // The folder can have been removed while it was being listed.
    for (const filePath of allFiles) {
      if (/\.p8$/i.test(filePath) && isScanned(filePath, workspaceRoots)) {
        addCart(filePath);
      }
    }
    // A .lua file that belongs to no cart is not read at all, so a folder of plain Lua costs only its listing. One that an
    // #include waits for is read, as it is when the file watcher reports it.
    const members = allFiles.map(filePath => pathToFileURL(filePath))
      .filter(uri => (isMember(uri) || index.isAwaited(uri)) && !(onlyNew && index.document(uri)));
    await readFromDisk(members);

    // The folder can have been removed while its files were being read, when the index did not have them yet for the
    // removal to drop. Files open in the editor stay, as they do when a folder is removed.
    const stillMembers = new Set(members.filter(uri => isMember(uri) || index.isAwaited(uri)));
    for (const uri of members) {
      if (!stillMembers.has(uri)) {
        diskText.delete(uri);
      }
    }
    // A scan of no file would send every file's diagnostics again.
    if (stillMembers.size > 0) {
      publish([ ...alsoPublish, ...index.scan([ ...stillMembers ]) ]);
      published = true;
    }
  } finally {
    // Also after a scan that failed, so that whatever waits for the end of the scan is not left waiting.
    if (!published) {
      publish(alsoPublish);
    }
    notifyCartFiles();
  }
}

// The text of a file that the file watcher does not report would go stale; textOf reads such a file when it is parsed.
async function readFromDisk(uris: string[]) {
  await Promise.all(uris.map(async uri => {
    const filePath = url.fileURLToPath(uri);
    if (!isWatched(filePath, workspaceRoots)) {
      return;
    }
    try {
      diskText.set(uri, (await fs.promises.readFile(filePath)).toString());
    } catch (e) {
      console.error('Error reading ' + filePath, e);
    }
  }));
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
  // The file watcher skips a file that belongs to no cart, so the text of one that left would not be kept current.
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

// Set up validation handler for when document changes
documents.onDidChangeContent(change => {
  const joined = index.joins();
  publish(index.update(change.document.uri));
  if (index.joins() > joined) {
    notifyCartFiles();
  }
});

documents.onDidClose(e => {
  const joined = index.joins();
  const uri = e.document.uri;
  const filePath = pathOf(uri);
  let text: string | undefined;
  try {
    text = fs.readFileSync(url.fileURLToPath(uri)).toString();
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
    notifyCartFiles();
  }
});

connection.onDidChangeConfiguration(change => {
  if (!hasConfigurationCapability) {
    takeSettings(change.settings?.['pico-8-ls']);
  }

  // The diagnostics come from the index, so the files need not be read again.
  fetchGlobalSettings().then(() => publish(index.uris())).catch(e => {
    console.error('Failed to send the diagnostics', e);
  });
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

// The client asks for a lua document, uri in VS Code's form, to give it the PICO-8 Lua language. True when a member of
// the index #includes it, whatever its name, as PICO-8 does; or when it is a .lua file and a cart is in its folder or a
// folder above it, so that a file such as notes.txt that the user shows as Lua keeps that language. Only the search for
// a cart reads the disk, so that the answer does not wait for the scan to find the carts.
connection.onRequest('pico-8-ls/belongsToCart', guarded('tell whether a file belongs to a cart', () => false, (params: { uri: string }) => {
  const filePath = pathOf(params.uri);
  return filePath !== undefined
    && (index.isIncluded(params.uri) || (/\.lua$/i.test(filePath) && nearCart(filePath, workspaceRoots, folderHasCart)));
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
  const joined = index.joins();
  const uris: string[] = [];
  const newCarts: string[] = [];
  const newFolders: string[] = [];
  let cartDeleted = false;
  for (const { uri, type } of change.changes) {
    const filePath = pathOf(uri);
    if (filePath === undefined) {
      continue;
    }
    if (type === FileChangeType.Deleted) {
      // A folder that is deleted or renamed is reported alone, without the files under it. A tool that deletes a folder
      // file by file can send an event for each, when its deletes span the watcher's batches, so the files the server
      // keeps are matched as text, without converting or normalizing each: a cart by its path, spelled as filePath is,
      // any other file by its URI, in VS Code's form as the event's is.
      const gone = (other: string, folder: string, separator: string) => other === folder || other.startsWith(folder + separator);
      for (const cart of [ ...carts ].filter(cart => gone(cart, filePath, path.sep))) {
        deleteCart(cart);
        cartDeleted = true;
      }
      for (const cached of [ ...diskText.keys() ].filter(cached => gone(cached, uri, '/'))) {
        diskText.delete(cached);
      }
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
      // A folder can have a name like a cart's or a .lua file's, such as json.lua.
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
    // A file in a dot-folder is in the index when a member of the index #includes it, and an #include can wait for one
    // to appear.
    const known = index.document(uri) !== undefined;
    if (!known && !isScanned(filePath, workspaceRoots) && !index.isAwaited(uri)) {
      continue;
    }
    if (type === FileChangeType.Created && /\.p8$/i.test(filePath) && isScanned(filePath, workspaceRoots)) {
      addCart(filePath);
      newCarts.push(filePath);
    }
    // A file that belongs to no cart is neither read nor parsed.
    if (!known && !isMember(uri) && !index.isAwaited(uri)) {
      continue;
    }
    if (isWatched(filePath, workspaceRoots)) {
      try {
        diskText.set(uri, fs.readFileSync(filePath).toString());
      } catch (e) {
        console.error('Error reading ' + uri, e);
      }
    }
    if (!documents.get(uri)) {
      uris.push(...index.update(uri));
    }
  }
  if (cartDeleted) {
    // The files near the deleted carts that nothing #includes leave; a file that one of them included can now be the
    // root of its own project, and a file whose parse failed before can join.
    const joinedBefore = index.joins();
    const left = index.prune();
    if (left.length > 0 || index.joins() > joinedBefore) {
      uris.push(...index.uris(), ...left);
    }
  }
  // The scan of a new cart's folder sends the problems of every file when it parses any, so this batch's go with it,
  // not before.
  if (newCarts.length === 0) {
    publish(uris);
  }
  // A new cart brings in the .lua files of its folder and the folders below, which the scan left out while no cart was
  // near them.
  newCarts.forEach((cart, i) => {
    void scanFolder(path.dirname(cart), true, i === 0 ? uris : []).catch(e => {
      console.error('Error scanning the folder of ' + cart, e);
    });
  });
  for (const folder of newFolders) {
    void scanFolder(folder).catch(e => {
      console.error('Error scanning ' + folder, e);
    });
  }
  if (index.joins() > joined) {
    notifyCartFiles();
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
    // With no analysis, only the builtins.
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
