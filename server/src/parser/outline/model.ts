import type { LuaSymbol } from '../analysis/model';
import { FunctionDeclaration } from '../statements';
import { Bounds, CodeLocation } from '../types';

export enum CodeSymbolType {
  Function = 'Function',
  Method = 'Method',
  Table = 'Table',
  Array = 'Array',
  Field = 'Field',
  Variable = 'Variable',
  Label = 'Label',
  Block = 'Block',
}

export type OutlineOptions = { showParameters: boolean, showLoopVariables: boolean, showBlocks: boolean };

export const NO_OUTLINE_OPTIONS: OutlineOptions = { showParameters: false, showLoopVariables: false, showBlocks: false };

export function outlineOptionsFrom(settings: unknown): OutlineOptions {
  const given = (typeof settings === 'object' && settings !== null ? settings : {}) as Partial<Record<keyof OutlineOptions, unknown>>;
  return {
    showParameters: given.showParameters === true,
    showLoopVariables: given.showLoopVariables === true,
    showBlocks: given.showBlocks === true,
  };
}

export type OutlineVariable = { name: string, loc: Bounds };

// A for, while, repeat or do block, or one branch of an if.
export type OutlineBlock = {
  keyword: 'for' | 'while' | 'repeat' | 'do' | 'if' | 'elseif' | 'else',
  // A branch followed by another ends where that one starts.
  loc: Bounds,
  // The keyword.
  selectionLoc: Bounds,
  // The end of the condition or of the last iterator; none for repeat, do and else.
  headerEnd?: CodeLocation,
  // The function entry whose body holds it; none at the top of the file.
  owner?: OutlineEntry,
  // The innermost block around it in the same body and the same file.
  parent?: OutlineBlock,
  // A for's loop variables.
  variables: OutlineVariable[],
};

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
  // The innermost block of the body being analysed where the entry was created.
  block?: OutlineBlock,
  // A function's parameters as written, ... left out.
  parameters?: OutlineVariable[],
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
  return '(' + parameterNames(fn).join(',') + ')';
}

export function parameterNames(fn: FunctionDeclaration): string[] {
  return fn.parameters.map(parameter => parameter.type === 'Identifier' ? parameter.name : '...');
}

export function isColonMethod(fn: FunctionDeclaration): boolean {
  return fn.identifier?.type === 'MemberExpression' && fn.identifier.indexer === ':';
}
