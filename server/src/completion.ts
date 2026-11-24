import { CompletionItem, CompletionItemKind } from 'vscode-languageserver/node';
import { Analysis, LuaSymbol } from './parser/analysis/model';
import { membersAt, visibleAt } from './parser/analysis/queries';
import { BuiltinConstants, Builtins } from './parser/builtins';
import ResolvedFile from './parser/file-resolver';
import { isIdentifierPart, isIdentifierStart } from './parser/lexer';

// path: [] for a plain name; the names before the last . or : otherwise; null after a . or : that follows something
// other than a name. start: the character where the word being typed begins.
export type CompletionRequest = { path: string[] | null, colon: boolean, start: number };

export function completionRequestAt(lineText: string, character: number): CompletionRequest {
  const start = wordStart(lineText, character);
  const separator = separatorBefore(lineText, start);
  if (!separator) {
    return { path: [], colon: false, start };
  }
  const colon = separator === ':';
  const path: string[] = [];
  let end = start - 1;
  for (;;) {
    const nameStart = wordStart(lineText, end);
    // Only the last separator can be a colon.
    if (nameStart === end || !isIdentifierStart(lineText.charCodeAt(nameStart)) || lineText[nameStart - 1] === ':') {
      return { path: null, colon, start };
    }
    path.unshift(lineText.slice(nameStart, end));
    if (!separatorBefore(lineText, nameStart)) {
      return { path, colon, start };
    }
    end = nameStart - 1;
  }
}

// The . or : right before index i, if there is one. The second dot of .., the concatenation operator, is not.
function separatorBefore(text: string, i: number): '.' | ':' | undefined {
  const char = text[i - 1];
  if (char === ':' || (char === '.' && text[i - 2] !== '.')) {
    return char;
  }
  return undefined;
}

function wordStart(text: string, end: number): number {
  let start = end;
  while (start > 0 && isIdentifierPart(text.charCodeAt(start - 1))) {
    start--;
  }
  return start;
}

// Not filtered by what is typed: VS Code does that.
export function completionItems(analyses: Analysis[], file: ResolvedFile, index: number, request: CompletionRequest,
  line: number, character: number): CompletionItem[] {
  const { path, colon } = request;
  if (path === null) {
    return [];
  }
  const range = { start: { line, character: request.start }, end: { line, character } };
  const items = new Map<string, CompletionItem>();
  const offer = (item: CompletionItem) => {
    if (!items.has(item.label)) {
      items.set(item.label, { ...item, textEdit: { range, newText: item.label } });
    }
  };
  if (path.length === 0) {
    for (const analysis of analyses) {
      visibleAt(analysis, file, index).forEach(symbol => offer(itemFor(symbol)));
    }
    for (const name of Object.keys(Builtins)) {
      offer({ label: name, kind: CompletionItemKind.Function, sortText: '2' + name });
    }
    for (const name of BuiltinConstants) {
      offer({ label: name, kind: CompletionItemKind.Constant, sortText: '2' + name });
    }
  } else {
    for (const analysis of analyses) {
      membersAt(analysis, file, index, path, colon, request.start === character)?.forEach(symbol => offer(itemFor(symbol)));
    }
  }
  return [ ...items.values() ];
}

function itemFor(symbol: LuaSymbol): CompletionItem {
  const isFunction = symbol.definitions.some(definition => definition.isFunction);
  const item: CompletionItem = { label: symbol.name, kind: kindOf(symbol, isFunction), sortText: rankOf(symbol) + symbol.name };
  if (isFunction) {
    item.detail = symbol.signature;
  }
  return item;
}

function kindOf(symbol: LuaSymbol, isFunction: boolean): CompletionItemKind {
  switch (symbol.kind) {
  case 'member':
    return isFunction ? CompletionItemKind.Method : CompletionItemKind.Field;
  case 'global':
  case 'local':
    return isFunction ? CompletionItemKind.Function : CompletionItemKind.Variable;
  default:
    return CompletionItemKind.Variable;
  }
}

// The first character of sortText: 0 for the names of the scopes around the cursor, 1 for globals and members, 2 for
// the built-in names.
function rankOf(symbol: LuaSymbol): string {
  return symbol.kind === 'global' || symbol.kind === 'member' ? '1' : '0';
}
