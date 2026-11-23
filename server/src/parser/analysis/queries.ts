import { isBuiltinName } from '../builtins';
import { createWarning, errMessages, Warning } from '../errors';
import ResolvedFile from '../file-resolver';
import { Bounds } from '../types';
import { Analysis, LuaSymbol, Reference } from './model';

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
