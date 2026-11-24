import { isBuiltinName } from '../builtins';
import { createWarning, errMessages, Warning } from '../errors';
import ResolvedFile from '../file-resolver';
import { Bounds, containsIndex } from '../types';
import { Analysis, LuaSymbol, Reference, Scope } from './model';

// The reference whose name covers index. The end counts, so a cursor right after a name still finds it.
export function referenceAt(analysis: Analysis, file: ResolvedFile, index: number): Reference | undefined {
  const references = analysis.referencesByFile.get(file.path) ?? [];
  // Count the references that start at or before index; the last of them is the only candidate.
  let low = 0;
  let high = references.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (references[middle].loc.start.index <= index) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const reference = references[low - 1];
  return reference && index <= reference.loc.end.index ? reference : undefined;
}

export function definitionsAt(analysis: Analysis, reference: Reference): Bounds[] {
  const { symbol } = reference;
  if (symbol.kind === 'self' && symbol.table) {
    return inOrder(targetsOf(symbol.table));
  }
  const targets = targetsOf(symbol);
  if (targets.length === 0 && symbol.kind === 'member' && symbol.definitions.length === 0 && reference.isCall) {
    // The table may inherit the method (entity:extend and the like), so offer every method of that name.
    const methods = (analysis.membersByKey.get(symbol.name) ?? [])
      .filter(member => member.definitions.some(definition => definition.isFunction));
    return inOrder(methods.flatMap(targetsOf));
  }
  return inOrder(targets);
}

// A local declared first and given a function later goes to the function, not to its declaration. Anything else goes
// where the outline lists it, or, for a symbol the outline never lists (a field set through a parameter, say), where it
// would: its first plain definition in each file, and every function definition.
function targetsOf(symbol: LuaSymbol): Bounds[] {
  const functions = symbol.definitions.filter(definition => definition.isFunction).map(definition => definition.nameLoc);
  if (symbol.kind === 'local' && functions.length > 0) {
    return functions;
  }
  if (symbol.entries.length > 0) {
    const explicit = symbol.entries.filter(entry => !entry.implicit);
    return (explicit.length > 0 ? explicit : symbol.entries).map(entry => entry.selectionLoc);
  }
  const firstPerFile = new Map<string, Bounds>();
  for (const definition of symbol.definitions) {
    const file = definition.nameLoc.start.filename.path;
    if (!definition.compound && !firstPerFile.has(file)) {
      firstPerFile.set(file, definition.nameLoc);
    }
  }
  return [ ...firstPerFile.values(), ...functions ];
}

export function referencesOf(symbol: LuaSymbol, includeDeclaration: boolean): Bounds[] {
  const declarations = new Set(includeDeclaration ? [] : symbol.definitions.map(definition => placeOf(definition.nameLoc)));
  return inOrder(symbol.references.map(reference => reference.loc).filter(loc => !declarations.has(placeOf(loc))));
}

export function warningsOf(analysis: Analysis): Warning[] {
  const warnings: Warning[] = [];
  for (const symbol of analysis.globals.values()) {
    // self never warns, not even the global one that top-level code reads.
    if (symbol.definitions.length > 0 || isBuiltinName(symbol.name) || symbol.name === 'self') {
      continue;
    }
    const reads = inOrder(symbol.references.filter(reference => reference.read).map(reference => reference.loc));
    warnings.push(...reads.map(loc => createWarning(loc, errMessages.undefinedVariable, symbol.name)));
  }
  return warnings.sort((a, b) => byPlace(a.bounds, b.bounds));
}

// The locals, parameters and loop variables declared above index in the scopes around it, innermost and latest first,
// each name once; then every global that has a definition. A declaration in another file counts if the analysis came
// to it before index: the parser pastes an #included file in where its #include is.
export function visibleAt(analysis: Analysis, file: ResolvedFile, index: number): LuaSymbol[] {
  const order = orderAt(analysis, file, index);
  const visible = new Map<string, LuaSymbol>();
  // Code #included in a function body sees the locals of that function.
  const start = analysis.includeScopes.get(file.path) ?? analysis.scope;
  for (let scope: Scope | undefined = innermostScope(start, file, index); scope; scope = scope.parent) {
    for (let i = scope.declarations.length - 1; i >= 0; i--) {
      const { symbol, file: declaredIn, visibleFrom, order: declaredAt } = scope.declarations[i];
      const isVisible = declaredIn.path === file.path ? visibleFrom <= index : declaredAt < order;
      if (isVisible && !visible.has(symbol.name)) {
        visible.set(symbol.name, symbol);
      }
    }
  }
  for (const global of analysis.globals.values()) {
    if (global.definitions.length > 0 && !visible.has(global.name)) {
      visible.set(global.name, global);
    }
  }
  return [ ...visible.values() ];
}

function innermostScope(scope: Scope, file: ResolvedFile, index: number): Scope {
  const inner = scope.children.find(child => child.loc && containsIndex(child.loc, file, index));
  return inner ? innermostScope(inner, file, index) : scope;
}

// Where index falls in the order the analysis came to things: just after the last checkpoint of file at or before
// index, a reference or the end of an #include, or else where the file's content starts. Where two checkpoints share
// a place (a file included twice), the first inclusion's counts.
function orderAt(analysis: Analysis, file: ResolvedFile, index: number): number {
  let at = -1;
  let order = analysis.includeStarts.get(file.path) ?? 0;
  const pass = (place: number, reached: number) => {
    if (place <= index && place > at) {
      at = place;
      order = reached + 0.5;
    }
  };
  for (const reference of analysis.referencesByFile.get(file.path) ?? []) {
    pass(reference.loc.start.index, reference.order);
  }
  for (const checkpoint of analysis.includeCheckpoints.get(file.path) ?? []) {
    pass(checkpoint.index, checkpoint.order);
  }
  return order;
}

// The members to offer after `path.` or `path:`: those with a definition, only functions after a colon. When there
// are none, as for a parameter, the ones used through the same variable, apart from the use being typed at index:
// only those called, after a colon. Undefined when the path leads nowhere.
// nothingTyped: no name follows the separator yet, so Lua takes the next name in the file as the member (`p.` above
// `x = 1` reads as `p.x = 1`). When the first reference from index on is to a member of the table, it doesn't count,
// nor a definition at the same place.
export function membersAt(analysis: Analysis, file: ResolvedFile, index: number, path: string[], colon: boolean,
  nothingTyped = false): LuaSymbol[] | undefined {
  let symbol = visibleAt(analysis, file, index).find(visible => visible.name === path[0]);
  for (const key of path.slice(1)) {
    symbol = symbol && (symbol.table ?? symbol).members.get(key);
  }
  if (!symbol) {
    return undefined;
  }
  const table = symbol.table ?? symbol;
  const members = [ ...table.members.values() ];
  const next = nothingTyped ? analysis.referencesByFile.get(file.path)?.find(reference => reference.loc.start.index >= index) : undefined;
  const glued = next?.symbol.owner === table ? placeOf(next.loc) : undefined;
  const counts = (loc: Bounds) => glued === undefined || placeOf(loc) !== glued;
  const defined = members.filter(member => member.definitions.some(definition => counts(definition.nameLoc)
    && (!colon || definition.isFunction)));
  if (defined.length > 0) {
    return defined;
  }
  return members.filter(member => member.references.some(reference => counts(reference.loc) && (!colon || reference.isCall)
    && !containsIndex(reference.loc, file, index)));
}

function placeOf(bounds: Bounds): string {
  return `${bounds.start.filename.path}:${bounds.start.index}:${bounds.end.index}`;
}

// Each place once, by file path and then by start.
function inOrder(list: Bounds[]): Bounds[] {
  const unique = new Map(list.map(bounds => [ placeOf(bounds), bounds ]));
  return [ ...unique.values() ].sort(byPlace);
}

function byPlace(a: Bounds, b: Bounds): number {
  const fileA = a.start.filename.path;
  const fileB = b.start.filename.path;
  if (fileA !== fileB) {
    return fileA < fileB ? -1 : 1;
  }
  return a.start.index - b.start.index;
}
