import {
  CompletionItem, CompletionItemTag, createConnection, DefinitionParams,
  DidChangeConfigurationNotification, DocumentFormattingParams, DocumentSymbolParams,
  ExecuteCommandParams, FileChangeType, FoldingRange, FoldingRangeParams, HoverParams, InitializeParams, InitializeResult, Position, ProposedFeatures,
  ReferenceParams, SignatureHelpParams, TextDocumentPositionParams,
  TextDocuments, TextDocumentSyncKind, TextEdit, WorkspaceFolder, WorkspaceSymbolParams,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import Parser from './parser/parser';
import { boundsToString } from './parser/types';
import { isParseError } from './parser/errors';
import { builtinInfo } from './parser/builtins';
import ResolvedFile, { pathToFileURL } from './parser/file-resolver';
import { Chunk } from './parser/statements';
import Formatter, { FormatterOptions } from './parser/formatter';
import { isScanned, isTrackedPath, isUnder, makeFileResolver, nearCart, ProjectDocument, ProjectIndex } from './projects';
import * as url from 'url';
import * as fs from 'fs';
import * as path from 'path';
import { buildDocumentSymbols } from './document-symbols';
import { computeFoldingRanges } from './folding-ranges';
import { errorsInFile, maxProblems } from './diagnostics';
import { completionItems, completionRequestAt, Offered, resolveUserItem, wordAt } from './completion';
import { builtinMarkdown } from './hover';
import { builtinSignatureHelp, CallContext, callContextAt } from './signature-help';
import { NO_OUTLINE_OPTIONS, OutlineOptions, outlineOptionsFrom } from './parser/outline/model';

console.log('PICO-8-LS language server starting.');

const connection = createConnection(ProposedFeatures.all);

const documents = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;

// The text of the index's files as the scan, the file watcher or a first read took it from the disk.
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
    return fs.readdirSync(folder).some(name => /\.p8$/i.test(name));
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

// Set up some initial configs
connection.onInitialize((params: InitializeParams) => {
  const capabilities = params.capabilities;

  // Does the client support the `workspace/configuration` request?
  // If not, we fall back using global settings.
  hasConfigurationCapability = !!(capabilities.workspace && capabilities.workspace.configuration);
  hasWorkspaceFolderCapability = !!(capabilities.workspace && capabilities.workspace.workspaceFolders);

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
      documentFormattingProvider: true,
      foldingRangeProvider: true,
      executeCommandProvider: {
        commands: [
          'pico-8-ls.server.formatFile',
          'pico-8-ls.server.formatFileSeparateLines',
        ],
      },
    },
  };

  if (hasWorkspaceFolderCapability) {
    // Let the client know we support workspace folders (if they do)
    result.capabilities.workspace = {
      workspaceFolders: { supported: true },
    };
  }

  return result;
});

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
      // now on, as textOf keeps the text of none outside the workspace folders.
      for (const uri of [ ...diskText.keys() ]) {
        const filePath = pathOf(uri);
        if (filePath === undefined || !workspaceRoots.some(root => isUnder(filePath, root))) {
          diskText.delete(uri);
        }
      }
      const joined = index.joins();
      const left = index.prune();
      // A file that left gets empty diagnostics, which clears its warnings from the Problems panel. With none leaving
      // there is nothing to send here: the scans of the added folders send every file's diagnostics, and with no folder
      // added nothing changed. A file can still join, one whose parse failed before, and it gets its diagnostics too.
      if (left.length > 0 || index.joins() > joined) {
        publish([ ...index.uris(), ...left ]);
      }
      if (index.joins() > joined) {
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

async function scanWorkspaceFolder(workspaceFolder: WorkspaceFolder) {
  try {
    const folderPath = url.fileURLToPath(workspaceFolder.uri);

    // List all files in directory & subdirs
    const allFiles = await getFilesRecursive(folderPath, folderPath);

    // The folder can have been removed while it was being listed.
    for (const filePath of allFiles) {
      if (/\.p8$/i.test(filePath) && isScanned(filePath, workspaceRoots)) {
        addCart(filePath);
      }
    }
    // A .lua file that belongs to no cart is not read at all, so a folder of plain Lua costs only its listing.
    const members = allFiles.map(filePath => pathToFileURL(filePath)).filter(isMember);
    await readFromDisk(members);

    // The folder can have been removed while its files were being read, when the index did not have them yet for the
    // removal to drop. Files open in the editor stay, as they do when a folder is removed.
    const stillMembers = new Set(members.filter(isMember));
    for (const uri of members) {
      if (!stillMembers.has(uri)) {
        diskText.delete(uri);
      }
    }
    publish(index.scan([ ...stillMembers ]));
  } finally {
    // Also after a scan that failed, so that whatever waits for the end of the scan is not left waiting.
    notifyCartFiles();
  }
}

// A new cart brings in the .lua files of its folder, which the scan left out while no cart was near them.
async function scanCartFolder(cartPath: string) {
  const folder = path.dirname(cartPath);
  const uris = (await getFilesRecursive(folder, folder)).map(filePath => pathToFileURL(filePath))
    .filter(uri => isMember(uri) && !index.document(uri));
  await readFromDisk(uris);
  publish(index.scan(uris));
  notifyCartFiles();
}

async function readFromDisk(uris: string[]) {
  await Promise.all(uris.map(async uri => {
    const filePath = url.fileURLToPath(uri);
    try {
      diskText.set(uri, (await fs.promises.readFile(filePath)).toString());
    } catch (e) {
      console.error('Error reading ' + filePath, e);
    }
  }));
}

async function getFilesRecursive(folderPath: string, root: string): Promise<string[]> {
  const p8andLuaFiles: string[] = [];
  try {
    const files = await fs.promises.readdir(folderPath);

    await Promise.all(files.map(async file => {
      const filePath = path.join(folderPath, file);

      const stat = await fs.promises.lstat(filePath);
      if (stat.isDirectory() && !file.startsWith('.')) {
        p8andLuaFiles.push(...(await getFilesRecursive(filePath, root)));
      } else if (stat.isFile() && isTrackedPath(filePath, [ root ])) {
        p8andLuaFiles.push(filePath);
      }
    }));

  } catch (e) {
    console.error('Error when scanning workspace folder ' + folderPath, e);
  }

  return p8andLuaFiles;
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
    // the disk on every keystroke; only under a workspace folder, where the file watcher keeps it current.
    if (!kept && workspaceRoots.some(root => isUnder(filePath, root))) {
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

interface DocumentSettings {
  maxNumberOfProblems: number;
  outline: OutlineOptions;
}

// Diagnostics are sent synchronously after each parse, so they take the limit last fetched rather than asking for the
// settings each time.
let globalSettings: DocumentSettings = { maxNumberOfProblems: maxProblems(undefined), outline: NO_OUTLINE_OPTIONS };

type PicoSettings = { maxNumberOfProblems?: unknown, outline?: unknown } | null | undefined;

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
function takeSettings(settings: PicoSettings) {
  const outline = outlineOptionsFrom(settings?.outline);
  const changed = (Object.keys(outline) as Array<keyof OutlineOptions>).some(key => outline[key] !== globalSettings.outline[key]);
  globalSettings = { maxNumberOfProblems: maxProblems(settings?.maxNumberOfProblems), outline };
  if (changed) {
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
  const uri = e.document.uri;
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
    diskText.set(uri, text);
    publish(index.update(uri));
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

connection.onDocumentSymbol((params: DocumentSymbolParams) => {
  const { uri } = params.textDocument;
  const document = index.document(uri);
  if (!document) {
    return [];
  }
  try {
    return buildDocumentSymbols(document.textDocument, document.chunk.comments ?? [], index.outline(uri, globalSettings.outline));
  } catch (e) {
    console.error('Failed to build the outline', e);
    return [];
  }
});

connection.onWorkspaceSymbol((params: WorkspaceSymbolParams) => {
  try {
    return index.workspaceSymbols(params.query, globalSettings.outline);
  } catch (e) {
    console.error('Failed to give workspace symbols', e);
    return [];
  }
});

// The client asks for a lua document, uri in VS Code's form, to give it the PICO-8 Lua language. True when a file of
// the index #includes it, or when a cart is in its folder or a folder above it. Only the search for a cart reads the
// disk, so that the answer does not wait for the scan to find the carts.
connection.onRequest('pico-8-ls/belongsToCart', (params: { uri: string }) => {
  try {
    const filePath = pathOf(params.uri);
    return filePath !== undefined
      && (index.isIncluded(params.uri) || nearCart(filePath, workspaceRoots, folderHasCart));
  } catch (e) {
    console.error('Failed to tell whether a file belongs to a cart', e);
    return false;
  }
});

function offsetOf(params: TextDocumentPositionParams): number | undefined {
  return documents.get(params.textDocument.uri)?.offsetAt(params.position);
}

connection.onDefinition((params: DefinitionParams) => {
  const offset = offsetOf(params);
  return offset === undefined ? [] : index.definitions(params.textDocument.uri, offset);
});

connection.onReferences((params: ReferenceParams) => {
  const offset = offsetOf(params);
  return offset === undefined ? [] : index.references(params.textDocument.uri, offset, params.context.includeDeclaration);
});

connection.onDidChangeWatchedFiles(change => {
  const joined = index.joins();
  const uris: string[] = [];
  const newCarts: string[] = [];
  let cartDeleted = false;
  for (const { uri, type } of change.changes) {
    const filePath = pathOf(uri);
    if (filePath === undefined) {
      continue;
    }
    // A file in a dot-folder is in the index when a file of the index #includes it, and an #include can wait for one
    // to appear.
    const known = index.document(uri) !== undefined;
    if (!known && !isScanned(filePath, workspaceRoots) && !index.isAwaited(uri)) {
      continue;
    }
    if (/\.p8$/i.test(filePath) && isScanned(filePath, workspaceRoots)) {
      if (type === FileChangeType.Created) {
        addCart(filePath);
        newCarts.push(filePath);
      } else if (type === FileChangeType.Deleted) {
        deleteCart(filePath);
        cartDeleted = true;
      }
    }
    if (type === FileChangeType.Deleted) {
      diskText.delete(uri);
      if (known && !documents.get(uri)) {
        uris.push(...index.remove(uri));
      }
      continue;
    }
    // A file that belongs to no cart is neither read nor parsed.
    if (!known && !isMember(uri) && !index.isAwaited(uri)) {
      continue;
    }
    try {
      diskText.set(uri, fs.readFileSync(filePath).toString());
    } catch (e) {
      console.error('Error reading ' + uri, e);
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
  publish(uris);
  for (const cart of newCarts) {
    void scanCartFolder(cart).catch(e => {
      console.error('Error scanning the folder of ' + cart, e);
    });
  }
  if (index.joins() > joined) {
    notifyCartFiles();
  }
});

// The user symbols of the last completion list, which the items being resolved come from.
let lastOffered: Offered = new Map();

// This handler provides the initial list of the completion items.
connection.onCompletion((params: TextDocumentPositionParams): CompletionItem[] => {
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
});

connection.onCompletionResolve((item: CompletionItem) => {
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
});

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

connection.onHover((params: HoverParams) => {
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
});

connection.onSignatureHelp((params: SignatureHelpParams) => {
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
});

connection.onDocumentFormatting((params: DocumentFormattingParams) => {
  const formatResult = executeCommand_formatDocument(params.textDocument.uri, params.options);
  return formatResult ? [ formatResult ] : null;
});

connection.onFoldingRanges((params: FoldingRangeParams): FoldingRange[] => {
  const document = index.document(params.textDocument.uri);
  return document ? computeFoldingRanges(document.textDocument, document.chunk) : [];
});

connection.onExecuteCommand((params: ExecuteCommandParams) => {
  switch (params.command) {
  // Both these commands trigger a format operation -- the difference should be expressed in the FormatterOptions.
  case 'pico-8-ls.server.formatFile':
  case 'pico-8-ls.server.formatFileSeparateLines':
    return executeCommand_formatDocument(params.arguments![0] as string, params.arguments![1] as FormatterOptions);
  default:
    console.error(`onExecuteCommand received unexpected command: ${params.command}`);
    break;
  }
});

const formatterSupportedLanguages = [ 'pico-8', 'pico-8-lua' ];

function executeCommand_formatDocument(documentUri: string, opts: FormatterOptions): TextEdit | null {
  const textDocument = documents.get(documentUri);
  if (!textDocument) {
    console.error('Can\'t find textDocument at uri ' + documentUri);
    return null;
  }

  // Make sure the document language is supported for formatting
  if (!formatterSupportedLanguages.includes(textDocument.languageId)) {
    console.error('Unsupported language for formatter: ' + textDocument.languageId);
    return null;
  }

  // A parse of its own: the formatter adds nodes to the syntax tree that the analysis cannot take.
  const chunk = parseText(documentUri, textDocument.getText());
  if (!chunk || errorsInFile(documentUri, chunk.errors).length > 0) {
    console.error(`Can't format document when there are parsing errors! (document: "${textDocument.uri}")`);
    return null;
  }

  // Actually format it
  const formatResult = new Formatter(opts).formatChunk(
    chunk,
    textDocument.getText(),
    textDocument.languageId === 'pico-8-lua',
    documentUri,
  );

  if (!formatResult) {
    // Couldn't format, for whatever reason
    console.error('Unknown error formatting document');
    return null;
  }

  return TextEdit.replace(
    formatResult.formattedRange,
    formatResult.formattedText,
  );
}

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();

console.log('PICO-8 Language Server launched.');
