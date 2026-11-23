import { Comment_ } from '../expressions';
import { Statement } from '../statements';
import { Bounds } from '../types';
import { CodeSymbolType, moveEntry, OutlineEntry } from './model';

// For a statement that assigns a table T, or members or methods of T: about is T, and defines is T
// when the statement assigns T itself.
export type StatementInfo = { about?: OutlineEntry, defines?: OutlineEntry, methods?: Array<{ entry: OutlineEntry, key: string }> };

export function findBoundaryLines(comments: Comment_[]): number[] {
  return comments
    .filter(comment => comment.raw === '-->8' || /^#(end)?region/.test(comment.value.trim()))
    .map(comment => comment.loc!.start.line);
}

export function groupMethodRuns(statements: Statement[], info: Map<Statement, StatementInfo>, boundaryLines: number[]): void {
  const tables = new Set<OutlineEntry>();
  for (const statement of statements) {
    const { about, methods } = info.get(statement) ?? {};
    if (about && methods?.length) {
      tables.add(about);
    }
  }
  for (const table of tables) {
    groupRun(table, statements, info, boundaryLines);
  }
}

function groupRun(table: OutlineEntry, statements: Statement[], info: Map<Statement, StatementInfo>, boundaryLines: number[]): void {
  const first = statements.findIndex(statement => info.get(statement)?.defines === table);
  if (first === -1) {
    return;
  }
  const definition = statements[first];
  // A table first defined somewhere else (in _init, say) would be stretched from there, over other entries.
  if (!contains(definition.loc!, table.selectionLoc)) {
    return;
  }

  const methodIndices: number[] = [];
  statements.forEach((statement, i) => {
    const { about, methods } = info.get(statement) ?? {};
    if (about === table && methods?.length) {
      methodIndices.push(i);
    }
  });
  if (methodIndices[0] < first) {
    return;
  }
  const last = methodIndices[methodIndices.length - 1];
  const lastMethod = statements[last];
  // #include puts the included file's statements in the same list as the including file's.
  if (!lastMethod.loc!.start.filename.equals(definition.loc!.start.filename)) {
    return;
  }
  if (statements.slice(first + 1, last + 1).some(statement => info.get(statement)?.about !== table)) {
    return;
  }
  if (boundaryLines.some(line => definition.loc!.start.line < line && line <= lastMethod.loc!.end.line)) {
    return;
  }
  const moving = methodIndices.flatMap(i => info.get(statements[i])!.methods!);
  // Breadcrumbs only follow ranges that contain the cursor, so the stretched table must not cover an entry
  // the cursor could reach before. The moving methods are exempt, and so is anything inside them, which they
  // covered already.
  const wouldCover = (entry: OutlineEntry) => entry !== table
    && entry.loc.start.filename.equals(definition.loc!.start.filename)
    && definition.loc!.end.index < entry.loc.start.index && entry.loc.start.index <= lastMethod.loc!.end.index
    && !moving.some(method => contains(method.entry.loc, entry.loc));
  if (table.parent.children.some(wouldCover)) {
    return;
  }

  for (const { entry, key } of moving) {
    entry.name = key;
    moveEntry(entry, table);
  }
  table.loc = { start: table.loc.start, end: lastMethod.loc!.end };
  if (table.type === CodeSymbolType.Variable || table.type === CodeSymbolType.Field || table.type === CodeSymbolType.Array) {
    table.type = CodeSymbolType.Table;
  }
}

function contains(outer: Bounds, inner: Bounds): boolean {
  return inner.start.filename.equals(outer.start.filename)
    && outer.start.index <= inner.start.index && inner.end.index <= outer.end.index;
}
