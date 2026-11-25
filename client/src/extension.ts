import * as path from 'path';
import { ExtensionContext, Position, Range, TextEdit, TextEditorEdit, commands, languages, window, workspace } from 'vscode';
import { CloseAction, ErrorAction, ErrorHandler, ExecuteCommandParams, LanguageClient, LanguageClientOptions, Message, ServerOptions, State, TransportKind } from 'vscode-languageclient/node';
import { DiagnosticsFilter, diagnosticsFilter, keptLanguages, switchLuaDocuments } from './lua-documents';
import SemanticTokenProvider, { legend } from './semantic-token-provider';

// Should stay in sync with FormatterOptions in server/src/parser/formatter.ts
type FormatterOptions = {
  // Size of a tab in spaces.
  tabSize: number,
  // Prefer spaces over tabs.
  insertSpaces: boolean,
  // Force each statement to be on a separate line.
  forceSeparateLines?: boolean,
};

let defaultErrorHandler: ErrorHandler | undefined;

const picoDocuments = [
  { scheme: 'file', language: 'pico-8' },
  { scheme: 'file', language: 'pico-8-lua' },
];

export function activate(context: ExtensionContext): void {
  languages.registerDocumentSemanticTokensProvider(
    { language: 'pico-8', scheme: 'file' },
    SemanticTokenProvider,
    legend,
  );

  languages.registerDocumentSemanticTokensProvider(
    { language: 'pico-8-lua', scheme: 'file' },
    SemanticTokenProvider,
    legend,
  );

  const kept = keptLanguages(context);
  const filter = diagnosticsFilter(kept);
  const client = new LanguageClient(
    'pico-8-ls',
    'PICO-8-LS',
    getServerOptions(context),
    getClientOptions(filter),
  );
  defaultErrorHandler = client.createDefaultErrorHandler(4);

  // register commands
  registerFormattingCommand(client, context, 'formatFile', false);
  registerFormattingCommand(client, context, 'formatFileSeparateLines', true);

  refreshOutlineOnOptionsChange(context, client);

  // The client tells the user itself when the server does not start, and rejects that start's onReady promise, which
  // would otherwise be reported again as a rejection nothing handles. Each start has a new promise.
  context.subscriptions.push(client.onDidChangeState(({ newState }) => {
    if (newState === State.Starting) {
      client.onReady().catch(e => console.log('The PICO-8-LS server did not start', e));
    }
  }));

  // starts both client and server
  const disposable = client.start();

  // So the client gets deactivated on extension deactivation
  context.subscriptions.push(disposable);

  switchLuaDocuments(context, client, kept, filter);
}

// VS Code caches the outline by document version and list of document symbol providers, and LSP 3.16 has no request
// to refresh document symbols. Only a provider list VS Code has not seen before makes the outline, breadcrumbs, sticky
// scroll and Ctrl+Shift+O ask again, so an empty provider is swapped for a new one when the server says the outline
// options changed; the server says so after it has taken the new options, so the new outline has them. Registering the
// new provider before disposing the old one makes the list differ at each step, and registering one from activation
// on makes the LSP provider's place in the list change only on the first swap.
function refreshOutlineOnOptionsChange(context: ExtensionContext, client: LanguageClient): void {
  const registerEmptyProvider = () => languages.registerDocumentSymbolProvider(picoDocuments, {
    provideDocumentSymbols: () => undefined,
  });
  let provider = registerEmptyProvider();
  context.subscriptions.push({
    dispose: () => {
      provider.dispose();
    },
  });

  // A server that restarts after a crash comes with a new connection, which has none of the old one's handlers.
  context.subscriptions.push(client.onDidChangeState(({ newState }) => {
    if (newState === State.Running) {
      client.onNotification('pico-8-ls/didChangeOutlineOptions', () => {
        const old = provider;
        provider = registerEmptyProvider();
        old.dispose();
      });
    }
  }));
}

// Get options for running Node language server
function getServerOptions(context: ExtensionContext): ServerOptions {
  const serverModule = context.asAbsolutePath(path.join('server', 'out-min', 'main.js'));

  // --inspect=6009: runs the server in Node's Inspector mode so VS Code can attach to the server for debugging
  const debugOptions = {
    execArgv: [ '--nolazy', '--inspect=6009' ],
  };

  // If the extension is launched in debug mode then the debug server options are used.
  // Otherwise the run options are used.
  return {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: debugOptions,
    },
  };
}

function getClientOptions(filter: DiagnosticsFilter): LanguageClientOptions {
  return {
    // Register the server for PICO-8 documents
    documentSelector: picoDocuments,
    synchronize: {
      fileEvents: workspace.createFileSystemWatcher('**/*.{p8,lua}'),
    },
    middleware: {
      handleDiagnostics: filter.middleware,
    },

    errorHandler: {
      error(error: Error, message: Message | undefined, count: number | undefined): ErrorAction {
        console.log('There has been an error!', error, message, count);
        return ErrorAction.Continue;
      },
      closed(): CloseAction {
        return defaultErrorHandler ? defaultErrorHandler.closed() : CloseAction.DoNotRestart;
      },
    },
  };
}

function registerFormattingCommand(client: LanguageClient, context: ExtensionContext, commandName: string, forceSeparateLines: boolean): void {
  const disposable = commands.registerCommand('pico-8-ls.' + commandName, async () => {
    const editor = window.activeTextEditor;
    if (!editor) {
      return;
    }

    const uri = editor.document.uri;

    const opts: FormatterOptions = {
      tabSize: Number(editor.options.tabSize) || 4,
      insertSpaces: !!editor.options.insertSpaces,
      forceSeparateLines: forceSeparateLines,
    };

    const params: ExecuteCommandParams = {
      command: 'pico-8-ls.server.' + commandName,
      arguments: [
        uri.toString(),
        opts,
      ],
    };

    const result: TextEdit | null = await client.sendRequest(
      'workspace/executeCommand',
      params,
    ) ;

    if (!result) {
      // The server doesn't format a document that has errors in it
      void window.showErrorMessage('Can\'t format the document. Make sure it doesn\'t have any errors.');
      return;
    }

    if (result.range && result.newText) {
      await editor.edit((editBuilder: TextEditorEdit) => {
        // Convert the plain object result.range into an instance of the vscode.Range class
        const editRange = new Range(new Position(result.range.start.line, result.range.start.character), new Position(result.range.end.line, result.range.end.character));
        editBuilder.replace(editRange, result.newText);
      });
    } else {
      void window.showErrorMessage('Invalid formatting result from language server backend. Please report an issue on GitHub.');
    }
  });
  context.subscriptions.push(disposable);
}
