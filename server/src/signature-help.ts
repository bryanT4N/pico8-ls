import { MarkupContent, ParameterInformation, SignatureHelp, SignatureInformation } from 'vscode-languageserver/node';
import { builtinMarkdown, pathOf, renderDoc } from './hover';
import { definitionDoc, documentationOf, paramDoc } from './parser/analysis/docs';
import { Analysis, Definition, LuaSymbol } from './parser/analysis/model';
import { methodsNamed, placeOf, visibleAt } from './parser/analysis/queries';
import { builtinInfo } from './parser/builtins';
import ResolvedFile from './parser/file-resolver';
import Lexer from './parser/lexer';
import { isColonMethod, parameterNames } from './parser/outline/model';
import { FunctionDeclaration } from './parser/statements';
import { Token, TokenType } from './parser/tokens';

// path: the names before the (, as in a.b.c or obj:m; colon: the last separator is ':'; argument: the commas before the
// cursor at the call's depth, null when the cursor is inside a { or [ of the call.
export type CallContext = { path: string[], colon: boolean, argument: number | null };

type Signature = SignatureInformation & { activeParameter: number };

const LEXED_FILE = new ResolvedFile('signature-help', 'signature-help');

type Callee = { path: string[], colon: boolean };
// What a ( opens: the arguments of a call on a name path, or of a call on something else; the parameters of a function;
// or a group.
type Paren = Callee | 'unnamed call' | 'parameters' | 'group';
// A function's body opens where its parameter list closes; the other blocks open at then, do and repeat, so that
// PICO-8's one-line if (c) and while (c), which have neither, open none.
type Open = { kind: '(', paren: Paren, commas: number } | { kind: '{' | '[', commas: number } | { kind: 'function' | 'then' | 'do' | 'repeat' };

// The innermost call still open at offset. The tokens are read from the start of the text, so strings, comments,
// nesting and calls over several lines count as Lua reads them. A grouping parenthesis and a function's parameter list
// are looked past. There is none inside a call on something other than a name path, such as get():hit( or f(x)(, nor
// in a block opened inside the call, such as the body of a function passed to it.
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
  tokens.forEach((token, at) => {
    if (token.type === TokenType.Keyword) {
      switch (token.value) {
      case 'then':
      case 'do':
      case 'repeat':
        open.push({ kind: token.value });
        break;
      case 'elseif':
        close(open, [ 'then' ]);
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

// Closes the innermost open item of one of kinds, and whatever is still open inside it.
function close(open: Open[], kinds: Array<Open['kind']>): Open | undefined {
  for (let i = open.length - 1; i >= 0; i--) {
    if (kinds.includes(open[i].kind)) {
      return open.splice(i)[0];
    }
  }
  return undefined;
}

// The ( at tokens[at] calls the names before it, separated by . or by a last :, as in a.b.c( or obj:m(, unless function
// comes before them, as in function f(. A call on anything else comes after ), ], } or a string, as in f(x)( or f{}(,
// or after names that follow one, as in get():hit(.
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

// The signatures of the functions the call at offset may go to, from the first analysis that finds one. A plain name
// that none finds is looked up among the builtins.
export function signatureHelpAt(analyses: Analysis[], file: ResolvedFile, text: string, offset: number): SignatureHelp | undefined {
  const call = callContextAt(text, offset);
  if (!call) {
    return undefined;
  }
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

function helpOf(signatures: Signature[]): SignatureHelp {
  return { signatures, activeSignature: 0, activeParameter: signatures[0].activeParameter };
}

// For a.b.c, the member c of a.b; when a.b has no c with a definition, every method named c, as the table may inherit
// it. Nothing when a or b is not found.
function calleesOf(analysis: Analysis, file: ResolvedFile, offset: number, path: string[]): LuaSymbol[] {
  const [ first, ...keys ] = path;
  let symbol: LuaSymbol | undefined = visibleAt(analysis, file, offset).find(visible => visible.name === first);
  const last = keys.pop();
  if (last === undefined) {
    return symbol && hasFunction(symbol) ? [ symbol ] : [];
  }
  for (const key of keys) {
    symbol = symbol && (symbol.table ?? symbol).members.get(key);
  }
  if (!symbol) {
    return [];
  }
  const member = (symbol.table ?? symbol).members.get(last);
  if (member && member.definitions.length > 0) {
    return hasFunction(member) ? [ member ] : [];
  }
  return methodsNamed(analysis, last);
}

function hasFunction(symbol: LuaSymbol): boolean {
  return symbol.definitions.some(definition => definition.isFunction);
}

// Shown as the call is written: with a colon, a self that the function names itself is left out; with a dot, the self
// of a method is added.
function userSignature(analysis: Analysis, symbol: LuaSymbol, definition: Definition, fn: FunctionDeclaration, call: CallContext): Signature {
  let names = parameterNames(fn);
  if (call.colon && !isColonMethod(fn) && names[0] === 'self') {
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
