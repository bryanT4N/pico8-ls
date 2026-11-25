import { Diagnostic, ExtensionContext, TextDocument, Uri, languages, window, workspace } from 'vscode';
import { HandleDiagnosticsSignature, LanguageClient, State } from 'vscode-languageclient/node';

// VS Code restores a language the user chose when the window reloads, so a choice remembered only for the session
// would be undone when the extension starts again.
const KEY = 'pico-8-ls.keptLanguage';

// PICO-8, the language of .p8 files, is as much PICO-8 as PICO-8 Lua.
function isPico(languageId: string): boolean {
  return languageId === 'pico-8' || languageId === 'pico-8-lua';
}

// The uris of the documents the user moved away from PICO-8 Lua. They are read before the client is made, because its
// diagnostics middleware needs them too. Also drops the uris of documents already open in a PICO-8 language, which no
// open event reports: they were given it back while the extension was not running.
export function keptLanguages(context: ExtensionContext): Set<string> {
  const kept = new Set(context.workspaceState.get<string[]>(KEY, []));
  let changed = false;
  for (const document of workspace.textDocuments) {
    if (isPico(document.languageId) && kept.delete(document.uri.toString())) {
      changed = true;
    }
  }
  if (changed) {
    void context.workspaceState.update(KEY, [ ...kept ]);
  }
  return kept;
}

export type DiagnosticsFilter = {
  middleware: (uri: Uri, diagnostics: Diagnostic[], next: HandleDiagnosticsSignature) => void,
  // Shows or hides again what the server sent, after the kept languages or files.associations changed.
  refresh: (client: LanguageClient) => void,
};

// A .lua file near a cart stays in the cart's project whatever language its editor has, as a file stays in its tsconfig
// project, so the server goes on sending its warnings, from its text on the disk. A file the user moved away from
// PICO-8 Lua, or that files.associations gives a language other than PICO-8, shows none, as a file that the TypeScript
// extension no longer has open as TypeScript shows no errors.
export function diagnosticsFilter(kept: Set<string>): DiagnosticsFilter {
  // A change of the kept languages or of files.associations shows or hides what the server sent before, which it has
  // no reason to send again: for a closed file it does not know about the change at all.
  const received = new Map<string, { uri: Uri, diagnostics: Diagnostic[] }>();
  const hidden = (uri: Uri) => kept.has(uri.toString()) || givenOtherLanguage(uri);
  return {
    middleware: (uri, diagnostics, next) => {
      if (diagnostics.length > 0) {
        received.set(uri.toString(), { uri, diagnostics });
      } else {
        received.delete(uri.toString());
      }
      next(uri, hidden(uri) ? [] : diagnostics);
    },
    refresh: client => {
      for (const { uri, diagnostics } of received.values()) {
        client.diagnostics?.set(uri, hidden(uri) ? [] : diagnostics);
      }
    },
  };
}

// Switches the open lua documents that belong to a cart to PICO-8 Lua, and leaves alone those the user moved away from it.
export function switchLuaDocuments(context: ExtensionContext, client: LanguageClient, kept: Set<string>, filter: DiagnosticsFilter): void {
  const saveKept = () => void context.workspaceState.update(KEY, [ ...kept ]);

  const mayBecomePicoLua = (document: TextDocument) => !document.isClosed
    && document.languageId === 'lua'
    && document.uri.scheme === 'file'
    && !kept.has(document.uri.toString())
    && !associated(document);

  async function check(document: TextDocument): Promise<void> {
    if (!mayBecomePicoLua(document)) {
      return;
    }
    let belongs: boolean;
    try {
      await client.onReady();
      belongs = await client.sendRequest<boolean>('pico-8-ls/belongsToCart', { uri: document.uri.toString() });
    } catch (e) {
      console.log('Failed to ask whether a lua document belongs to a cart', e);
      return;
    }
    // Asked again because things change during the round trip: the document can be closed or given another language,
    // and a change of files.associations can reach the extension after the change of language it causes.
    if (belongs && mayBecomePicoLua(document)) {
      try {
        await languages.setTextDocumentLanguage(document, 'pico-8-lua');
      } catch (e) {
        console.log('Failed to switch a lua document to PICO-8 Lua', e);
      }
    }
  }

  const checkAll = () => workspace.textDocuments.forEach(document => void check(document));

  // VS Code reports a change of language as a close and then an open of the same document object, the close still
  // with the old language. A document that is really closed and opened again is a new object.
  let lastClosed: { document: TextDocument, languageId: string } | undefined;

  context.subscriptions.push(workspace.onDidCloseTextDocument(document => {
    lastClosed = { document, languageId: document.languageId };
  }));

  context.subscriptions.push(workspace.onDidOpenTextDocument(document => {
    const oldLanguage = lastClosed?.document === document ? lastClosed.languageId : undefined;
    lastClosed = undefined;
    const uri = document.uri.toString();
    if (isPico(document.languageId)) {
      if (kept.delete(uri)) {
        saveKept();
        filter.refresh(client);
      }
    } else if (oldLanguage !== undefined && isPico(oldLanguage) && document.uri.scheme === 'file' && window.activeTextEditor?.document === document) {
      // Change Language Mode acts on the active editor only. A change of files.associations resets every open file
      // while the settings are the active editor, so those files go on to be checked.
      kept.add(uri);
      saveKept();
      // The middleware hides the warnings the server sends from now on; those it sent before are hidden now.
      filter.refresh(client);
    } else {
      void check(document);
    }
  }));

  context.subscriptions.push(workspace.onDidChangeConfiguration(event => {
    // Removing an association turns a file from the lua it gave into the default lua, which VS Code does not report
    // as a change of language.
    if (event.affectsConfiguration('files.associations')) {
      filter.refresh(client);
      checkAll();
    }
  }));

  // A server that restarts after a crash comes with a new connection, which has none of the old one's handlers, and
  // carts and #includes can have changed while it was down.
  context.subscriptions.push(client.onDidChangeState(({ newState }) => {
    if (newState === State.Running) {
      client.onNotification('pico-8-ls/didChangeCartFiles', checkAll);
      checkAll();
    }
  }));
}

// files.associations comes before the languages of every extension, so a file it names has the language the user
// wrote there.
function associated(document: TextDocument): boolean {
  const associations = workspace.getConfiguration('files').get<Record<string, string>>('associations') ?? {};
  return Object.keys(associations).some(pattern => matches(pattern, document.uri));
}

// VS Code matches a key of files.associations without a slash against the file name only, and ignores case, which
// languages.match does not, so the key and the path are both lowercased. languages.match scores a pattern by the
// document's uri alone (the extension host's match calls score(selector, document.uri, document.languageId, ...)), so a
// stand-in with that uri will do, for a closed file as well.
function matches(pattern: string, uri: Uri): boolean {
  const key = pattern.toLowerCase();
  const document = { uri: Uri.file(uri.fsPath.toLowerCase()), languageId: '' } as unknown as TextDocument;
  return languages.match({ pattern: key.includes('/') ? key : '**/' + key }, document) > 0;
}

// An open document has the language its editor shows. A closed one has the language that files.associations gives
// it as VS Code picks it: the longest key that matches, and of two as long the later one. VS Code registers every key
// as a pattern, never as a file name, so its rule that an exact file name comes first does not apply to them.
function givenOtherLanguage(uri: Uri): boolean {
  const open = workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
  if (open) {
    return !isPico(open.languageId) && associated(open);
  }
  const associations = workspace.getConfiguration('files').get<Record<string, string>>('associations') ?? {};
  let longest: string | undefined;
  for (const pattern of Object.keys(associations)) {
    if ((longest === undefined || pattern.length >= longest.length) && matches(pattern, uri)) {
      longest = pattern;
    }
  }
  return longest !== undefined && !isPico(associations[longest]);
}
