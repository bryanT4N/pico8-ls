import { isBuiltinName } from '../builtins';
import { createWarning, errMessages, Warning } from '../errors';
import ResolvedFile from '../file-resolver';
import { ByName, pico8Text } from '../p8scii';
import { Bounds, containsIndex } from '../types';
import { Analysis, LuaSymbol, Reference, Scope } from './model';

// The reference whose name covers index. The end counts, so a cursor right after a name still finds it.
export function referenceAt(analysis: Analysis, file: ResolvedFile, index: number): Reference | undefined {
  const references = analysis.referencesByFile.get(file.path) ?? [];
  // Only the last reference that starts at or before index can cover it: names don't overlap.
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
    return uniqueInOrder(targetsOf(symbol.table));
  }
  const targets = targetsOf(symbol);
  if (targets.length === 0 && symbol.kind === 'member' && symbol.definitions.length === 0 && reference.isCall) {
    // The table may inherit the method (entity:extend and the like), so offer every method of that name.
    return uniqueInOrder(methodsNamed(analysis, symbol.name).flatMap(targetsOf));
  }
  return uniqueInOrder(targets);
}

export function methodsNamed(analysis: Analysis, name: string): LuaSymbol[] {
  return (analysis.membersByKey.get(name) ?? [])
    .flatMap(member => {
      const first = member.definitions.find(definition => definition.isFunction);
      return first ? [{ member, place: first.nameLoc }] : [];
    })
    .sort((a, b) => byPlace(a.place, b.place))
    .map(({ member }) => member);
}

// Where the outline lists the symbol, or would list it; an implicit entry only when there is no other.
export function targetsOf(symbol: LuaSymbol): Bounds[] {
  const functions = symbol.definitions.filter(definition => definition.isFunction).map(definition => definition.nameLoc);
  if (symbol.kind === 'local' && functions.length > 0) {
    return functions;
  }
  const explicit = symbol.entries.filter(entry => !entry.implicit);
  if (explicit.length > 0) {
    return explicit.map(entry => entry.selectionLoc);
  }
  const firstPerFile = new Map<string, Bounds>();
  for (const definition of symbol.definitions) {
    const file = definition.nameLoc.start.filename.path;
    if (!definition.compound && !firstPerFile.has(file)) {
      firstPerFile.set(file, definition.nameLoc);
    }
  }
  const defined = [ ...firstPerFile.values(), ...functions ];
  return defined.length > 0 ? defined : symbol.entries.map(entry => entry.selectionLoc);
}

export function referencesOf(symbol: LuaSymbol, includeDeclaration: boolean): Bounds[] {
  const declarations = new Set(includeDeclaration ? [] : symbol.definitions.map(definition => placeOf(definition.nameLoc)));
  return uniqueInOrder(symbol.references.map(reference => reference.loc).filter(loc => !declarations.has(placeOf(loc))));
}

// Through its global table _ENV, code can define globals that no name in it shows, as _ENV[k] = v does, so a cart that
// refers to that table gets no warnings at all.
export function warningsOf(analysis: Analysis): Warning[] {
  const env = analysis.globals.get('_ENV');
  if (env && env.references.length > 0) {
    return [];
  }
  const warnings: Warning[] = [];
  for (const symbol of analysis.globals.values()) {
    // Under a local _ENV, Lua assigns the field of that table, and a read can find a field that code elsewhere sets.
    if (symbol.definitions.some(definition => !definition.underLocalEnv) || isBuiltinName(symbol.name) || symbol.name === 'self') {
      continue;
    }
    const reads = uniqueInOrder(symbol.references.filter(reference => reference.read && !reference.underLocalEnv).map(reference => reference.loc));
    warnings.push(...reads.map(loc => createWarning(loc, errMessages.undefinedVariable, symbol.name)));
  }
  return warnings.sort((a, b) => byPlace(a.bounds, b.bounds));
}

// A declaration in another file counts if the analysis came to it before index: the parser pastes an #included file
// in where its #include is.
export function visibleAt(analysis: Analysis, file: ResolvedFile, index: number): LuaSymbol[] {
  const order = orderAt(analysis, file, index);
  const visible = new ByName<LuaSymbol>();
  for (let scope: Scope | undefined = innermostScope(analysis.scope, file, index); scope; scope = scope.parent) {
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
  const inner = scope.children.find(child => (child.loc && containsIndex(child.loc, file, index))
    || child.elsewhere?.some(part => containsIndex(part, file, index)));
  return inner ? innermostScope(inner, file, index) : scope;
}

// Where two checkpoints share a place (a file included twice), the first inclusion's counts.
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

export function symbolOfPath(analysis: Analysis, file: ResolvedFile, index: number, path: string[]): LuaSymbol | undefined {
  const name = pico8Text(path[0]);
  let symbol = visibleAt(analysis, file, index).find(visible => pico8Text(visible.name) === name);
  for (const key of path.slice(1)) {
    symbol = symbol && (symbol.table ?? symbol).members.get(key);
  }
  return symbol;
}

// With no definitions, as for a parameter, the members used through the same variable stand in, apart from the use
// being typed. nothingTyped: no name follows the separator yet, so Lua reads the next name in the file as the member
// (`p.` above `x = 1` reads as `p.x = 1`); when that reference is to a member of the table, it doesn't count, nor
// a definition at its place.
export function membersAt(analysis: Analysis, file: ResolvedFile, index: number, path: string[], colon: boolean,
  nothingTyped = false): LuaSymbol[] | undefined {
  const symbol = symbolOfPath(analysis, file, index, path);
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

export function placeOf(bounds: Bounds): string {
  return `${bounds.start.filename.path}:${bounds.start.index}:${bounds.end.index}`;
}

function uniqueInOrder(list: Bounds[]): Bounds[] {
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
