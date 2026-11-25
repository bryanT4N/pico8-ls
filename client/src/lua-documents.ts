import { ExtensionContext, TextDocument, languages, window, workspace } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';

// VS Code restores a language the user chose when the window reloads, so a choice remembered only for the session
// would be undone when the extension starts again.
const KEY = 'pico-8-ls.keptLanguage';

// Switches the open lua documents that belong to a cart to PICO-8 Lua, and leaves alone those the user moved away from it.
export function switchLuaDocuments(context: ExtensionContext, client: LanguageClient): void {
  const kept = new Set(context.workspaceState.get<string[]>(KEY, []));
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
    if (document.languageId === 'pico-8-lua') {
      if (kept.delete(uri)) {
        saveKept();
      }
    } else if (oldLanguage === 'pico-8-lua' && window.activeTextEditor?.document === document) {
      // Change Language Mode acts on the active editor only. A change of files.associations resets every open file
      // while the settings are the active editor, so those files go on to be checked.
      kept.add(uri);
      saveKept();
    } else {
      void check(document);
    }
  }));

  context.subscriptions.push(workspace.onDidChangeConfiguration(event => {
    // Removing an association turns a file from the lua it gave into the default lua, which VS Code does not report
    // as a change of language.
    if (event.affectsConfiguration('files.associations')) {
      checkAll();
    }
  }));

  void client.onReady().then(() => {
    context.subscriptions.push(client.onNotification('pico-8-ls/didChangeCartFiles', checkAll));
    checkAll();
  });
}

// files.associations comes before the languages of every extension, so a file it names has the language the user
// wrote there. VS Code matches a pattern without a slash against the file name only.
function associated(document: TextDocument): boolean {
  const associations = workspace.getConfiguration('files').get<Record<string, string>>('associations') ?? {};
  return Object.keys(associations)
    .some(pattern => languages.match({ pattern: pattern.includes('/') ? pattern : '**/' + pattern }, document) > 0);
}
