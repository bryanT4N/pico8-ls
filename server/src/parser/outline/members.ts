import { Expression, TableConstructorExpression } from '../expressions';
import { Bounds } from '../types';
import { addEntry, CodeSymbolType, OutlineEntry } from './model';

export function unwrapValue(value: Expression | undefined): Expression | undefined {
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

export function getOrAddMember(
  table: OutlineEntry,
  key: string,
  type: CodeSymbolType,
  loc: Bounds,
  selectionLoc: Bounds,
): OutlineEntry {
  if (table.type === CodeSymbolType.Variable ||
      table.type === CodeSymbolType.Field ||
      table.type === CodeSymbolType.Array) {
    table.type = CodeSymbolType.Table;
  }
  const existing = table.members.get(key);
  if (existing) {
    return existing;
  }
  const member = addEntry(table, key, type, loc, selectionLoc);
  table.members.set(key, member);
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
  // Table, Function, and Method stay unchanged.
}
