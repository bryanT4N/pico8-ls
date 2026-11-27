import { MarkupContent, ParameterInformation, SignatureHelp, SignatureInformation } from 'vscode-languageserver/node';
import { builtinMarkdown, pathOf, renderDoc } from './hover';
import { definitionDoc, documentationOf, paramDoc } from './parser/analysis/docs';
import { Analysis, Definition, LuaSymbol } from './parser/analysis/model';
import { methodsNamed, placeOf, symbolOfPath } from './parser/analysis/queries';
import { builtinInfo } from './parser/builtins';
import ResolvedFile from './parser/file-resolver';
import Lexer from './parser/lexer';
import { isColonMethod, parameterNames } from './parser/outline/model';
import { FunctionDeclaration } from './parser/statements';
import { Token, TokenType } from './parser/tokens';

export type CallContext = { path: string[], colon: boolean, argument: number | null };

type Signature = SignatureInformation & { activeParameter: number };

const LEXED_FILE = new ResolvedFile('signature-help', 'signature-help');

type Callee = { path: string[], colon: boolean };
type Paren = Callee | 'unnamed call' | 'parameters' | 'group';
// Blocks open at then and do, not at if and while, so that PICO-8's one-line if (c) and while (c), which have
// neither, open none. The then or do of an elseif opens none either: the block its if opened runs on to the end,
// and a one-line if has none.
type Open = { kind: '(', paren: Paren, commas: number } | { kind: '{' | '[', commas: number } | { kind: 'function' | 'then' | 'do' | 'repeat' };

// The tokens are read from the start of the text, so strings, comments, nesting and calls over several lines count
// as Lua reads them.
export function callContextAt(text: string, offset: number): CallContext | undefined {
  const tokens: Token[] = [];
  try {
    const lexer = new Lexer(text.slice(0, offset), LEXED_FILE);
    for (lexer.next(); lexer.token!.type !== TokenType.EOF; lexer.next()) {
      tokens.push(lexer.token!);
    }
  } catch {
    return undefined;
  }
  const open: Open[] = [];
  // The depths of open where an elseif waits for its then or do.
  const elseifs: boolean[] = [];
  tokens.forEach((token, at) => {
    if (token.type === TokenType.Keyword) {
      switch (token.value) {
      // These only start a statement, which cannot sit inside an open bracket: a ( { or [ still open before one, such as
      // an unclosed call earlier in the file, was never closed. In a block, such as the body of a function passed to a
      // call, the block is on top, so the brackets around it stay open.
      case 'local':
      case 'if':
      case 'for':
      case 'while':
      case 'repeat':
      case 'return':
      case 'goto':
      case 'break':
        closeBrackets(open);
        if (token.value === 'repeat') {
          open.push({ kind: token.value });
        }
        break;
      case 'then':
      case 'do':
        if (elseifs[open.length]) {
          elseifs[open.length] = false;
        } else {
          open.push({ kind: token.value });
        }
        break;
      case 'elseif':
        closeBrackets(open);
        elseifs[open.length] = true;
        break;
      case 'end':
        close(open, [ 'function', 'then', 'do' ]);
        break;
      case 'until':
        close(open, [ 'repeat' ]);
        break;
      }
    } else if (token.type === TokenType.Punctuator) {
      switch (token.value) {
      case '(':
        open.push({ kind: '(', paren: parenAt(tokens, at), commas: 0 });
        break;
      case '{':
      case '[':
        open.push({ kind: token.value, commas: 0 });
        break;
      case ')': {
        const closed = close(open, [ '(' ]);
        if (closed?.kind === '(' && closed.paren === 'parameters') {
          open.push({ kind: 'function' });
        }
        break;
      }
      case '}':
        close(open, [ '{' ]);
        break;
      case ']':
        close(open, [ '[' ]);
        break;
      case ',': {
        const top = open[open.length - 1];
        if (top && 'commas' in top) {
          top.commas++;
        }
        break;
      }
      }
    }
    // The then or do of an elseif still being typed is no longer waited for once its depth closes.
    elseifs.length = Math.min(elseifs.length, open.length + 1);
  });
  let inside = false;
  for (let i = open.length - 1; i >= 0; i--) {
    const item = open[i];
    if (item.kind === '{' || item.kind === '[') {
      inside = true;
    } else if (item.kind === '(') {
      if (item.paren === 'unnamed call') {
        return undefined;
      }
      if (typeof item.paren === 'object') {
        return { ...item.paren, argument: inside ? null : item.commas };
      }
    } else {
      return undefined;
    }
  }
  return undefined;
}

function close(open: Open[], kinds: Array<Open['kind']>): Open | undefined {
  for (let i = open.length - 1; i >= 0; i--) {
    if (kinds.includes(open[i].kind)) {
      return open.splice(i)[0];
    }
  }
  return undefined;
}

function closeBrackets(open: Open[]) {
  while (open.length > 0 && [ '(', '{', '[' ].includes(open[open.length - 1].kind)) {
    open.pop();
  }
}

function parenAt(tokens: Token[], at: number): Paren {
  const previous = tokens[at - 1];
  if (previous?.type === TokenType.StringLiteral || (previous?.type === TokenType.Punctuator && [ ')', ']', '}' ].includes(previous.value as string))) {
    return 'unnamed call';
  }
  if (previous?.type === TokenType.Keyword && previous.value === 'function') {
    return 'parameters';
  }
  if (previous?.type !== TokenType.Identifier) {
    return 'group';
  }
  const path: string[] = [];
  let colon = false;
  let i = at - 1;
  for (;;) {
    path.unshift(tokens[i].value as string);
    const separator = tokens[i - 1];
    if (separator?.type !== TokenType.Punctuator || (separator.value !== '.' && separator.value !== ':')) {
      break;
    }
    if (separator.value === ':') {
      if (path.length > 1) {
        return 'unnamed call';
      }
      colon = true;
    }
    i -= 2;
    if (tokens[i]?.type !== TokenType.Identifier) {
      return 'unnamed call';
    }
  }
  const before = tokens[i - 1];
  return before?.type === TokenType.Keyword && before.value === 'function' ? 'parameters' : { path, colon };
}

export function signatureHelpAt(analyses: Analysis[], file: ResolvedFile, text: string, offset: number): SignatureHelp | undefined {
  const call = callContextAt(text, offset);
  return call ? signatureHelpFor(analyses, file, offset, call) : undefined;
}

export function signatureHelpFor(analyses: Analysis[], file: ResolvedFile, offset: number, call: CallContext): SignatureHelp | undefined {
  for (const analysis of analyses) {
    const signatures: Signature[] = [];
    // A file included twice has its definitions twice.
    const places = new Set<string>();
    for (const symbol of calleesOf(analysis, file, offset, call.path)) {
      for (const definition of symbol.definitions) {
        const place = placeOf(definition.nameLoc);
        if (definition.value?.type === 'FunctionDeclaration' && !places.has(place)) {
          places.add(place);
          signatures.push(userSignature(analysis, symbol, definition, definition.value, call));
        }
      }
    }
    if (signatures.length > 0) {
      return helpOf(signatures);
    }
  }
  return builtinSignatureHelp(call);
}

// Needs no analysis, so it still answers when the project's signature help throws.
export function builtinSignatureHelp(call: CallContext): SignatureHelp | undefined {
  return call.path.length === 1 ? builtinHelp(call.path[0], call.argument) : undefined;
}

function builtinHelp(name: string, argument: number | null): SignatureHelp | undefined {
  const info = builtinInfo(name);
  if (!info?.sig || !info.params) {
    return undefined;
  }
  return helpOf([{
    label: info.sig,
    documentation: markdown(builtinMarkdown(name, info)),
    activeParameter: argument ?? info.params.length,
    parameters: info.params.map(p => {
      const idxOfColon = p.indexOf(':');
      return {
        label: p.substring(0, idxOfColon),
        documentation: p,
      };
    }),
  }]);
}

// A vararg always takes the argument: activeParameter stops at it.
function helpOf(signatures: Signature[]): SignatureHelp {
  const active = Math.max(0, signatures.findIndex(signature => signature.activeParameter < (signature.parameters?.length ?? 0)));
  return { signatures, activeSignature: active, activeParameter: signatures[active].activeParameter };
}

// When a.b has no c with a definition, the table may inherit c, so every method named c is a candidate. A path
// through a table that nothing defines leads to no known table; self has no definition, but stands for the
// method's table.
function calleesOf(analysis: Analysis, file: ResolvedFile, offset: number, path: string[]): LuaSymbol[] {
  if (path.length === 1) {
    const symbol = symbolOfPath(analysis, file, offset, path);
    return symbol && hasFunction(symbol) ? [ symbol ] : [];
  }
  const table = symbolOfPath(analysis, file, offset, path.slice(0, -1));
  if (!table || (table.kind !== 'self' && table.definitions.length === 0)) {
    return [];
  }
  const last = path[path.length - 1];
  const member = (table.table ?? table).members.get(last);
  if (member && member.definitions.length > 0) {
    return hasFunction(member) ? [ member ] : [];
  }
  return methodsNamed(analysis, last);
}

function hasFunction(symbol: LuaSymbol): boolean {
  return symbol.definitions.some(definition => definition.isFunction);
}

// Shown as the call is written. With a colon, the receiver goes to the first parameter of a function not declared with
// one, whatever its name, so that parameter is left out; a ... takes the receiver and the rest, so it stays. With a dot,
// the self of a method is added.
function userSignature(analysis: Analysis, symbol: LuaSymbol, definition: Definition, fn: FunctionDeclaration, call: CallContext): Signature {
  let names = parameterNames(fn);
  if (call.colon && !isColonMethod(fn) && names[0] !== '...') {
    names = names.slice(1);
  } else if (!call.colon && isColonMethod(fn)) {
    names = [ 'self', ...names ];
  }
  const owner = symbol.kind === 'member' && symbol.owner ? pathOf(symbol.owner) : undefined;
  const head = (owner === undefined ? '' : owner + (call.colon ? ':' : '.')) + symbol.name + '(';
  const doc = definitionDoc(analysis, definition) ?? documentationOf(analysis, symbol).doc;
  let start = head.length;
  const parameters = names.map(name => {
    const parameter: ParameterInformation = { label: [ start, start + name.length ] };
    start += name.length + ', '.length;
    const text = paramDoc(doc, name);
    return text === undefined ? parameter : { ...parameter, documentation: markdown(text) };
  });
  const description = doc ? renderDoc({ description: doc.description, tags: doc.tags.filter(tag => tag.name !== 'param') }) : '';
  return {
    label: head + names.join(', ') + ')',
    ...(description === '' ? {} : { documentation: markdown(description) }),
    parameters,
    activeParameter: activeParameter(names, call.argument),
  };
}

// Inside a { or [, one past the last parameter, so that none is marked: the client takes a null as the first.
function activeParameter(names: string[], argument: number | null): number {
  if (argument === null) {
    return names.length;
  }
  if (names[names.length - 1] === '...' && argument >= names.length - 1) {
    return names.length - 1;
  }
  return argument;
}

function markdown(value: string): MarkupContent {
  return { kind: 'markdown', value };
}
