import * as path from 'path';
import { ExtensionContext, languages, workspace } from 'vscode';
import { CloseAction, ErrorAction, ErrorHandler, LanguageClient, LanguageClientOptions, Message, ServerOptions, State, TransportKind } from 'vscode-languageclient/node';
import { DiagnosticsFilter, diagnosticsFilter, keptLanguages, switchLuaDocuments } from './lua-documents';

let defaultErrorHandler: ErrorHandler | undefined;

const picoDocuments = [
  { scheme: 'file', language: 'pico-8' },
  { scheme: 'file', language: 'pico-8-lua' },
];

export function activate(context: ExtensionContext): void {
  const kept = keptLanguages(context);
  const filter = diagnosticsFilter(kept);
  const client = new LanguageClient(
    'pico-8-ls',
    'PICO-8-LS',
    getServerOptions(context),
    getClientOptions(filter),
  );
  defaultErrorHandler = client.createDefaultErrorHandler(4);

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
      // Deleting or renaming a folder is reported for the folder alone, which the first pattern leaves out.
      fileEvents: [ workspace.createFileSystemWatcher('**/*.{p8,lua}', true, false, true), workspace.createFileSystemWatcher('**/*', false, true, false) ],
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
