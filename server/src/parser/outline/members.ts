import { Expression, TableConstructorExpression } from '../expressions';
import { Bounds } from '../types';
import { addEntry, CodeSymbolType, OutlineEntry } from './model';

export function unwrapValue(value: Expression | undefined): Expression | undefined {
  // x = x or { ... } gives x that table the first time it runs.
  if (value?.type === 'LogicalExpression' && value.operator === 'or') {
    return unwrapValue(value.right);
  }
  if (value?.type === 'CallExpression') {
    if (value.base.type === 'Identifier' && value.base.name === 'setmetatable') {
      const firstArg = value.arguments[0];
      if (firstArg?.type === 'TableConstructorExpression') {
        return firstArg as TableConstructorExpression;
      }
    }
  }
  return value;
}

export function tableTypeOf(ctor: TableConstructorExpression): CodeSymbolType {
  const fields = ctor.fields.filter(f => f.type !== 'Whitespace');
  if (fields.length > 0 && fields.every(f => f.type === 'TableValue')) {
    return CodeSymbolType.Array;
  }
  return CodeSymbolType.Table;
}

export function promoteToTable(entry: OutlineEntry): void {
  if (entry.type === CodeSymbolType.Variable || entry.type === CodeSymbolType.Field || entry.type === CodeSymbolType.Array) {
    entry.type = CodeSymbolType.Table;
  }
}

function getOrAddMember(
  table: OutlineEntry,
  key: string,
  type: CodeSymbolType,
  loc: Bounds,
  selectionLoc: Bounds,
): OutlineEntry {
  promoteToTable(table);
  const existing = table.members.get(key);
  if (existing) {
    return existing;
  }
  const member = addEntry(table, key, type, loc, selectionLoc);
  table.members.set(key, member);
  return member;
}

export function defineMember(table: OutlineEntry, key: string, type: CodeSymbolType, loc: Bounds, selectionLoc: Bounds): OutlineEntry {
  const existing = table.members.get(key);
  if (existing?.implicit) {
    existing.loc = loc;
    existing.selectionLoc = selectionLoc;
    existing.implicit = false;
    return existing;
  }
  return getOrAddMember(table, key, type, loc, selectionLoc);
}

export function pathMember(table: OutlineEntry, key: string, loc: Bounds, selectionLoc: Bounds): OutlineEntry {
  const existing = table.members.get(key);
  if (existing) {
    promoteToTable(table);
    return existing;
  }
  const member = getOrAddMember(table, key, CodeSymbolType.Table, loc, selectionLoc);
  member.implicit = true;
  return member;
}

export function receiveTable(entry: OutlineEntry, ctor: TableConstructorExpression): void {
  if (entry.type === CodeSymbolType.Variable || entry.type === CodeSymbolType.Field) {
    entry.type = tableTypeOf(ctor);
  } else if (entry.type === CodeSymbolType.Array) {
    const fields = ctor.fields.filter(f => f.type !== 'Whitespace');
    if (fields.some(f => f.type === 'TableKeyString' || f.type === 'TableKey')) {
      entry.type = CodeSymbolType.Table;
    }
  }
}
