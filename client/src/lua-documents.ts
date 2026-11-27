import { Diagnostic, ExtensionContext, TextDocument, Uri, languages, window, workspace } from 'vscode';
import { HandleDiagnosticsSignature, LanguageClient, State } from 'vscode-languageclient/node';

// VS Code restores a language the user chose when the window reloads, so a choice remembered only for the session
// would be undone when the extension starts again.
const KEY = 'pico-8-ls.keptLanguage';

// A change of files.associations resets the language of the open files whose language the user did not choose, the
// active one too, so a reset looks like Change Language Mode. VS Code tells of the change of configuration right after
// the resets, with no timer between them but not always in the same task of the extension host, and VS Code 1.63 may
// reset a file just after telling. A file that leaves a PICO-8 language within this many milliseconds of a change of
// files.associations, for the language the change gives it, was reset by it; the margin is for an extension host kept
// busy by other work.
const RESET_WINDOW = 1000;

function isPico(languageId: string): boolean {
  return languageId === 'pico-8' || languageId === 'pico-8-lua';
}

// The uris of the documents the user moved away from a PICO-8 language. One already open in a PICO-8 language was
// given it back while the extension was not running, which no open event reports.
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
  refresh: (client: LanguageClient) => void,
};

// A .lua file near a cart stays in the cart's project whatever language its editor has, as a file stays in its tsconfig
// project, so the server goes on sending its warnings, from its text on the disk. A file the user moved away from a
// PICO-8 language, or that files.associations gives a language other than PICO-8 and PICO-8 Lua, shows none, as a file
// that the TypeScript extension no longer has open as TypeScript shows no errors.
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
      client.diagnostics?.set([ ...received.values() ].map(({ uri, diagnostics }) => [ uri, hidden(uri) ? [] : diagnostics ]));
    },
  };
}

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

  // A reset gives a file the language of its key in files.associations, or, with none, the language of its extension,
  // which is known here only for .lua.
  const hasResetLanguage = (document: TextDocument) => document.languageId
    === (associatedLanguage(document.uri) ?? (document.uri.fsPath.toLowerCase().endsWith('.lua') ? 'lua' : undefined));

  let associationsChangedAt = -Infinity;
  // Kept from the start, so that the file is not switched back and its warnings stay hidden, and forgotten if a change
  // of files.associations that gives the file its new language follows within the window.
  let choice: { document: TextDocument, at: number } | undefined;

  context.subscriptions.push(workspace.onDidOpenTextDocument(document => {
    const oldLanguage = lastClosed?.document === document ? lastClosed.languageId : undefined;
    lastClosed = undefined;
    const uri = document.uri.toString();
    if (isPico(document.languageId)) {
      if (kept.delete(uri)) {
        saveKept();
        filter.refresh(client);
      }
    } else if (oldLanguage !== undefined && isPico(oldLanguage) && document.uri.scheme === 'file' && window.activeTextEditor?.document === document
      && (Date.now() - associationsChangedAt > RESET_WINDOW || !hasResetLanguage(document))) {
      // Change Language Mode acts on the active editor only; the other files were reset and go on to be checked.
      kept.add(uri);
      choice = { document, at: Date.now() };
      saveKept();
      filter.refresh(client);
    } else {
      void check(document);
    }
  }));

  context.subscriptions.push(workspace.onDidChangeConfiguration(event => {
    // Removing an association turns a file from the lua it gave into the default lua, which VS Code does not report
    // as a change of language.
    if (event.affectsConfiguration('files.associations')) {
      associationsChangedAt = Date.now();
      if (choice !== undefined && associationsChangedAt - choice.at <= RESET_WINDOW && hasResetLanguage(choice.document)
        && kept.delete(choice.document.uri.toString())) {
        saveKept();
      }
      choice = undefined;
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

// The language that files.associations gives a file as VS Code picks it: the longest key that matches, and of two as
// long the later one. VS Code registers every key as a pattern, never as a file name, so its rule that an exact file
// name comes first does not apply to them.
function associatedLanguage(uri: Uri): string | undefined {
  const associations = workspace.getConfiguration('files').get<Record<string, string>>('associations') ?? {};
  let longest: string | undefined;
  for (const pattern of Object.keys(associations)) {
    if ((longest === undefined || pattern.length >= longest.length) && matches(pattern, uri)) {
      longest = pattern;
    }
  }
  return longest === undefined ? undefined : associations[longest];
}

// An open document has the language its editor shows. A closed one has the language that files.associations gives it.
function givenOtherLanguage(uri: Uri): boolean {
  const open = workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
  if (open) {
    return !isPico(open.languageId) && associated(open);
  }
  const language = associatedLanguage(uri);
  return language !== undefined && !isPico(language);
}
