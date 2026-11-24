import { Doc, DocTag, documentationOf } from './parser/analysis/docs';
import { Analysis, Definition, LuaSymbol, Reference } from './parser/analysis/model';
import { methodsNamed } from './parser/analysis/queries';
import { BuiltinFunctionInfo } from './parser/builtins';
import { Expression } from './parser/expressions';
import { unwrapValue } from './parser/outline/members';
import { isColonMethod, parameterNames } from './parser/outline/model';

// Undefined when the reference names nothing the user defined, so that a builtin can answer. A method call that its
// table does not define shows each method of that name, as Go to Definition offers them all.
export function hoverMarkdown(analysis: Analysis, reference: Reference): string | undefined {
  const { symbol } = reference;
  const describe = (described: LuaSymbol) => {
    const { definition, doc } = documentationOf(analysis, described);
    const text = doc ? renderDoc(doc) : '';
    return '```pico-8-lua\n' + declarationOf(described, definition) + '\n```' + (text === '' ? '' : '\n\n' + text);
  };
  if (symbol.definitions.length > 0 || symbol.kind === 'self') {
    return describe(symbol);
  }
  if (symbol.kind === 'member' && reference.isCall) {
    const methods = methodsNamed(analysis, symbol.name);
    if (methods.length > 0) {
      return methods.map(describe).join('\n\n---\n\n');
    }
  }
  return undefined;
}

// definition: the one documentationOf gives, which may be none.
export function declarationOf(symbol: LuaSymbol, definition?: Definition): string {
  // The value of x += 1 is what x changes by.
  const value = definition?.compound ? undefined : definition?.value;
  const fn = value?.type === 'FunctionDeclaration' ? value : undefined;
  const parameters = fn ? parameterNames(fn).join(', ') : '';
  switch (symbol.kind) {
  case 'global':
    return fn ? `function ${symbol.name}(${parameters})` : `(global) ${symbol.name}${literalOf(value)}`;
  case 'local':
    return fn ? `local function ${symbol.name}(${parameters})` : `local ${symbol.name}${literalOf(value)}`;
  case 'param':
    return `(parameter) ${symbol.name}`;
  case 'loopvar':
    return `(loop variable) ${symbol.name}`;
  case 'label':
    return `::${symbol.name}::`;
  case 'self': {
    const table = symbol.table && pathOf(symbol.table);
    return table === undefined ? '(parameter) self' : `(self) ${table}`;
  }
  case 'member':
  case 'value': {
    const owner = symbol.owner && pathOf(symbol.owner);
    if (fn) {
      return `function ${owner === undefined ? '' : owner + (isColonMethod(fn) ? ':' : '.')}${symbol.name}(${parameters})`;
    }
    return `(field) ${owner === undefined ? '' : owner + '.'}${symbol.name}${literalOf(value)}`;
  }
  }
}

// Undefined when a table on the way is one no name holds.
export function pathOf(symbol: LuaSymbol): string | undefined {
  const names: string[] = [];
  for (let on: LuaSymbol | undefined = symbol; on; on = on.owner) {
    if (on.name === '') {
      return undefined;
    }
    names.unshift(on.name);
  }
  return names.join('.');
}

// PICO-8 code often keeps its constants in globals, so a value written as a literal is worth showing.
function literalOf(value: Expression | undefined): string {
  switch (value?.type) {
  case 'NumericLiteral':
    return ` = ${value.raw}`;
  case 'UnaryExpression':
    return value.operator === '-' && value.argument.type === 'NumericLiteral' ? ` = -${value.argument.raw}` : '';
  case 'StringLiteral':
    // A string on several lines would end the code block early, or carry a \r into it.
    return value.raw.length <= 40 && !/[\r\n]/.test(value.raw) ? ` = ${value.raw}` : '';
  case 'BooleanLiteral':
    return ` = ${value.value}`;
  case 'NilLiteral':
    return ' = nil';
  }
  return unwrapValue(value)?.type === 'TableConstructorExpression' ? ' = {\u2026}' : '';
}

// As VS Code shows a JSDoc comment. An @return with no text says nothing, so it is left out, as TypeScript does.
export function renderDoc(doc: Doc): string {
  const tags = doc.tags.filter(tag => tag.name !== 'return' || tag.text !== '').map(renderTag).join('  \n\n');
  return [ doc.description, tags ].filter(part => part !== '').join('\n\n');
}

function renderTag(tag: DocTag): string {
  const label = tag.name === 'param' && tag.param ? `*@param* \`${tag.param}\`` : `*@${tag.name}*`;
  if (tag.text === '') {
    return label;
  }
  return label + (tag.text.includes('\n') ? '  \n' + tag.text : ' \u2014 ' + tag.text);
}

export function builtinMarkdown(name: string, info: BuiltinFunctionInfo): string {
  if (!info.sig) {
    return '';
  }

  return `## ${name}

\`${info.sig}\`

${info.desc}

### Params:
${info.params?.map(p => ` - ${p}`).join('\n')}`;
}
