import ResolvedFile from '../file-resolver';
import { CodeSymbol, CodeSymbolType, OutlineEntry } from './model';

export function projectToFile(entries: OutlineEntry[], file: ResolvedFile): CodeSymbol[] {
  return listedOnce(entries.flatMap(entry => {
    const children = projectToFile(entry.children, file);
    if (entry.loc.start.filename.equals(file)) {
      const { name, detail, type, loc, selectionLoc } = entry;
      return [{ name, detail, type, loc, selectionLoc, children }];
    }
    // Members this file adds to a table from another file still need a parent in this file's outline.
    if (children.length > 0) {
      const { loc, selectionLoc } = children[0];
      return [{ name: entry.name, detail: undefined, type: CodeSymbolType.Table, loc, selectionLoc, children }];
    }
    return [];
  }).sort(bySourcePosition));
}

// Entries defined by the same statement share loc.start, so where their names sit breaks the tie.
function bySourcePosition(a: CodeSymbol, b: CodeSymbol): number {
  return a.loc.start.index - b.loc.start.index || a.selectionLoc.start.index - b.selectionLoc.start.index;
}

// A file included twice is in the analysis twice, so each of its entries comes twice.
function listedOnce(symbols: CodeSymbol[]): CodeSymbol[] {
  const listed = new Set<string>();
  return symbols.filter(({ name, type, loc }) => {
    const key = JSON.stringify([ name, type, loc.start.filename.path, loc.start.index, loc.end.index ]);
    if (listed.has(key)) {
      return false;
    }
    listed.add(key);
    return true;
  });
}
