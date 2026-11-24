import { LuaSymbol } from '../analysis/model';
import { FunctionDeclaration } from '../statements';
import { Bounds } from '../types';

export enum CodeSymbolType {
  Function = 'Function',
  Method = 'Method',
  Table = 'Table',
  Array = 'Array',
  Field = 'Field',
  Variable = 'Variable',
  Label = 'Label',
}

export type CodeSymbol = {
  name: string,
  detail: string | undefined,
  type: CodeSymbolType,
  // loc is the whole definition; selectionLoc is the part to select, usually the name.
  loc: Bounds,
  selectionLoc: Bounds,
  children: CodeSymbol[],
};

export type Owner = { children: OutlineEntry[] };

export type OutlineEntry = Owner & {
  name: string,
  type: CodeSymbolType,
  detail: string | undefined,
  loc: Bounds,
  selectionLoc: Bounds,
  parent: Owner,
  // Data members of a table (rule 3), one per key.
  members: Map<string, OutlineEntry>,
  // Created for a field assignment before the name itself was assigned.
  implicit: boolean,
  // A local declared without a value that later gets a function: the function's entry stands for it, so it is left
  // out unless it has children.
  hidden: boolean,
  // Unset for anonymous functions and the functions of tables that no name holds.
  symbol?: LuaSymbol,
};

export function addEntry(parent: Owner, name: string, type: CodeSymbolType, loc: Bounds, selectionLoc: Bounds, detail?: string): OutlineEntry {
  const entry: OutlineEntry = {
    name, type, detail, loc, selectionLoc, parent,
    children: [],
    members: new Map<string, OutlineEntry>(),
    implicit: false,
    hidden: false,
  };
  parent.children.push(entry);
  return entry;
}

export function moveEntry(entry: OutlineEntry, newParent: Owner): void {
  const siblings = entry.parent.children;
  const index = siblings.indexOf(entry);
  if (index !== -1) {
    siblings.splice(index, 1);
  }
  entry.parent = newParent;
  newParent.children.push(entry);
}

export function signatureOf(fn: FunctionDeclaration): string {
  return '(' + fn.parameters.map(param => param.type === 'Identifier' ? param.name : '...').join(',') + ')';
}
