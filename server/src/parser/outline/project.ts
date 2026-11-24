import ResolvedFile from '../file-resolver';
import { CodeSymbol, CodeSymbolType, OutlineEntry } from './model';

export function projectToFile(entries: OutlineEntry[], file: ResolvedFile): CodeSymbol[] {
  const { listed, lifted } = project(entries, file);
  return inOrder([ ...listed, ...lifted ]);
}

// listed: the symbols of this level. lifted: this file's entries inside a function of another file, which is where an
// #include in a function body puts them. No entry of the other file can hold them in this file's outline, so they go
// up to the nearest entry of this file, or to the top.
function project(entries: OutlineEntry[], file: ResolvedFile): { listed: CodeSymbol[], lifted: CodeSymbol[] } {
  const listed: CodeSymbol[] = [];
  const lifted: CodeSymbol[] = [];
  for (const entry of entries) {
    const inner = project(entry.children, file);
    if (entry.loc.start.filename.equals(file)) {
      const children = inOrder([ ...inner.listed, ...inner.lifted ]);
      if (!entry.hidden || children.length > 0) {
        const { name, detail, type, loc, selectionLoc } = entry;
        listed.push({ name, detail, type, loc, selectionLoc, children });
      }
      continue;
    }
    lifted.push(...inner.lifted);
    if (entry.type === CodeSymbolType.Function || entry.type === CodeSymbolType.Method) {
      lifted.push(...inner.listed);
    } else if (inner.listed.length > 0) {
      // Members this file adds to a table from another file still need a parent in this file's outline.
      const children = inOrder(inner.listed);
      const { loc, selectionLoc } = children[0];
      listed.push({ name: entry.name, detail: undefined, type: CodeSymbolType.Table, loc, selectionLoc, children });
    }
  }
  return { listed, lifted };
}

function inOrder(symbols: CodeSymbol[]): CodeSymbol[] {
  return listedOnce(symbols.sort(bySourcePosition));
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
