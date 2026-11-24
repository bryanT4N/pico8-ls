import {
  CompletionItem, CompletionItemTag, createConnection, DefinitionParams,
  DidChangeConfigurationNotification, DocumentFormattingParams, DocumentSymbolParams,
  ExecuteCommandParams, FoldingRange, FoldingRangeParams, HoverParams, InitializeParams, InitializeResult, Position, ProposedFeatures,
  ReferenceParams, SignatureHelpParams, SignatureInformation, TextDocumentPositionParams,
  TextDocuments, TextDocumentSyncKind, TextEdit, WorkspaceFolder,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import Parser from './parser/parser';
import { boundsToString } from './parser/types';
import { isParseError } from './parser/errors';
import { Builtins, BuiltinFunctionInfo } from './parser/builtins';
import { isIdentifierPart } from './parser/lexer';
import ResolvedFile, { pathToFileURL } from './parser/file-resolver';
import { Chunk } from './parser/statements';
import Formatter, { FormatterOptions } from './parser/formatter';
import { makeFileResolver, ProjectDocument, ProjectIndex } from './projects';
import * as url from 'url';
import * as fs from 'fs';
import * as path from 'path';
import { buildDocumentSymbols } from './document-symbols';
import { computeFoldingRanges } from './folding-ranges';
import { errorsInFile } from './diagnostics';
import { completionItems, completionRequestAt } from './completion';

console.log('PICO-8-LS language server starting.');

const connection = createConnection(ProposedFeatures.all);

const documents = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;

// The text of the workspace's files as the scan read them.
const diskText = new Map<string, string>();

function openText(uri: string): string | undefined {
  return documents.get(uri)?.getText() ?? diskText.get(uri);
}

const fileResolver = makeFileResolver(openText);

const index = new ProjectIndex(parseFile);

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
    // Register for workspace change folders event -- just logging it out for now
    connection.workspace.onDidChangeWorkspaceFolders(event => {
      connection.console.log('Workspace folder change event received: ' + JSON.stringify(event));
    });
  }

  void fetchGlobalSettings().then(rescanEverything);
});

function rescanEverything() {
  connection.workspace.getWorkspaceFolders().then((workspaceFolders: WorkspaceFolder[] | null) => {
    if (!workspaceFolders) {
      return;
    }

    Promise.all(workspaceFolders.map(scanWorkspaceFolder)).catch(e => {
      console.log('Error scanning workspace folders', e);
    });
  }).catch(reason => {
    console.log('Failed to get workspace folder(s):', reason);
  });
}

async function scanWorkspaceFolder(workspaceFolder: WorkspaceFolder) {
  const folderPath = url.fileURLToPath(workspaceFolder.uri);

  // List all files in directory & subdirs
  const allFiles = await getFilesRecursive(folderPath);

  const uris = await Promise.all(allFiles.map(async filePath => {
    const uri = pathToFileURL(filePath);
    try {
      diskText.set(uri, (await fs.promises.readFile(filePath)).toString());
    } catch (e) {
      console.error('Error reading ' + filePath, e);
    }
    return uri;
  }));

  publish(index.scan(uris));
}

async function getFilesRecursive(folderPath: string): Promise<string[]> {
  const p8andLuaFiles: string[] = [];
  try {
    const files = await fs.promises.readdir(folderPath);

    await Promise.all(files.map(async file => {
      const filePath = path.join(folderPath, file);

      const stat = await fs.promises.lstat(filePath);
      if (stat.isDirectory() && !file.startsWith('.')) {
        p8andLuaFiles.push(...(await getFilesRecursive(filePath)));
      } else if (stat.isFile() && (/\.(p8|lua)$/i.exec(filePath))) {
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
  const text = openText(uri);
  if (text !== undefined) {
    return text;
  }
  try {
    return fs.readFileSync(url.fileURLToPath(uri)).toString();
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
}

interface DocumentSettings {
  maxNumberOfProblems: number;
}

// The settings for every file. A client without the `workspace/configuration`
// request can't be asked for them, so it sends them with each change instead.
const defaultSettings: DocumentSettings = { maxNumberOfProblems: 100 };
let globalSettings: DocumentSettings = defaultSettings;

// Diagnostics are sent synchronously after each parse, so the settings they
// need are fetched before a scan rather than for each file.
async function fetchGlobalSettings() {
  if (!hasConfigurationCapability) {
    return;
  }
  try {
    const settings = await connection.workspace.getConfiguration('pico-8-ls') as Partial<DocumentSettings> | null;
    globalSettings = { ...defaultSettings, ...settings };
  } catch (e) {
    console.error('Failed to get the pico-8-ls settings', e);
  }
}

// Set up validation handler for when document changes
documents.onDidChangeContent(change => {
  publish(index.update(change.document.uri));
});

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<DocumentSettings>> = new Map<string, Thenable<DocumentSettings>>();
// When a document is closed, purge its entry from the cache
documents.onDidClose(e => documentSettings.delete(e.document.uri));

connection.onDidChangeConfiguration(change => {
  if (hasConfigurationCapability) {
    // reset all cached document settings
    documentSettings.clear();
  } else {
    globalSettings = change.settings['pico-8-ls'] || defaultSettings;
  }

  void fetchGlobalSettings().then(rescanEverything);
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function getDocumentSettings(resource: string): Thenable<DocumentSettings> {
  if (!hasConfigurationCapability) {
    return Promise.resolve(globalSettings);
  }

  let result = documentSettings.get(resource);
  if (!result) {
    result = connection.workspace.getConfiguration({
      scopeUri: resource,
      section: 'pico-8-ls',
    });
    documentSettings.set(resource, result);
  }
  return result;
}

connection.onDocumentSymbol((params: DocumentSymbolParams) => {
  const { uri } = params.textDocument;
  const document = index.document(uri);
  if (!document) {
    return [];
  }
  try {
    return buildDocumentSymbols(document.textDocument, document.chunk.comments ?? [], index.outline(uri));
  } catch (e) {
    console.error('Failed to build the outline', e);
    return [];
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

connection.onDidChangeWatchedFiles(_change => {
  // Monitored files have change in VS Code
  connection.console.log('We received a file change event');
});

// This handler provides the initial list of the completion items.
connection.onCompletion((params: TextDocumentPositionParams): CompletionItem[] => {
  const { uri } = params.textDocument;
  const offset = offsetOf(params);
  const lineText = getTextOnLine(uri, params.position);
  if (offset === undefined || lineText === undefined) {
    return [];
  }
  const { line, character } = params.position;
  return completionItems(index.analyses(uri), ResolvedFile.fromFileURL(uri), offset, completionRequestAt(lineText, character), line, character);
});

function toDocumentationMarkdown(name: string, info: BuiltinFunctionInfo) : string {
  if (!info.sig) {
    return '';
  }

  return `## ${name}

\`${info.sig}\`

${info.desc}

### Params:
${info.params?.map(p => ` - ${p}`).join('\n')}`;
}

connection.onCompletionResolve((item: CompletionItem) => {
  const name = item.label;

  const info = Builtins[name];
  if (info) {
    item.detail = info.sig;
    item.documentation = {
      kind: 'markdown',
      value: toDocumentationMarkdown(name, info),
    };
    if (info.deprecated) {
      item.tags = [ CompletionItemTag.Deprecated ];
    }
  }

  return item;
});

function identifierAtPosition(position: number, text: string) {
  let i;
  for (i = position; i >= 0; i--) {
    if (!isIdentifierPart(text.charCodeAt(i))) {
      i++;
      break;
    }
  }
  const begin = i;

  for (i = position; i < text.length; i++) {
    if (!isIdentifierPart(text.charCodeAt(i))) {
      break;
    }

  }
  const end = i;

  return text.substring(begin, end);
}

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
  const textOnLine = getTextOnLine(params.textDocument.uri, params.position);
  if (!textOnLine) {
    return undefined;
  }
  const identifier = identifierAtPosition(params.position.character, textOnLine);

  const info = Builtins[identifier];
  if (info) {
    return {
      contents: toDocumentationMarkdown(identifier, info),
    };
  }
});

connection.onSignatureHelp((params: SignatureHelpParams) => {
  const textOnLine = getTextOnLine(params.textDocument.uri, params.position);
  if (!textOnLine) {
    return undefined;
  }

  // get position of starting (
  let i = params.position.character;
  let numCommas = 0;
  while (i >= 0 && textOnLine[i] !== '(') {
    if (textOnLine[i] === ',') {
      numCommas++;
    }
    i--;
  }

  // not found
  if (i < 0) {
    return undefined;
  }

  const startingParenPos = i;

  // get identifier before that
  const identifier = identifierAtPosition(startingParenPos - 1, textOnLine);
  const info = Builtins[identifier];
  if (!info || !info.sig || !info.params) {
    return undefined;
  }

  const signatureInfo: SignatureInformation = {
    label: info.sig,
    documentation: {
      kind: 'markdown',
      value: toDocumentationMarkdown(identifier, info),
    },
    activeParameter: numCommas,
    parameters: info.params.map(p => {
      const idxOfColon = p.indexOf(':');
      return {
        label: p.substring(0, idxOfColon),
        documentation: p,
      };
    }),
  };

  return {
    signatures: [ signatureInfo ],
    activeSignature: 0,
    activeParameter: numCommas,
  };
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
