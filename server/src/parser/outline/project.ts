import ResolvedFile from '../file-resolver';
import { CodeSymbol, CodeSymbolType, OutlineEntry } from './model';

export function projectToFile(entries: OutlineEntry[], file: ResolvedFile): CodeSymbol[] {
  const { listed, lifted } = project(entries, file);
  return inOrder([ ...listed, ...lifted ]);
}

// listed: the symbols of this level. lifted: this file's entries in the body of a function of another file, which is
// where an #include in a function body puts them. No entry of the other file can hold them in this file's outline, so
// they go up to the nearest entry of this file, or to the top.
function project(entries: OutlineEntry[], file: ResolvedFile): { listed: CodeSymbol[], lifted: CodeSymbol[] } {
  const listed: CodeSymbol[] = [];
  const lifted: CodeSymbol[] = [];
  for (const entry of entries) {
    if (entry.loc.start.filename.equals(file)) {
      const inner = project(entry.children, file);
      const children = inOrder([ ...inner.listed, ...inner.lifted ]);
      if (!entry.hidden || children.length > 0) {
        const { name, detail, type, loc, selectionLoc } = entry;
        listed.push({ name, detail, type, loc, selectionLoc, children });
      }
      continue;
    }
    // A function's members are the fields set on it (f.x = 1); the rest, like code #included in its body, go up.
    const isFunction = entry.type === CodeSymbolType.Function || entry.type === CodeSymbolType.Method;
    const members = new Set(entry.members.values());
    const stays = (child: OutlineEntry) => !isFunction || members.has(child);
    const kept = project(entry.children.filter(stays), file);
    const body = project(entry.children.filter(child => !stays(child)), file);
    lifted.push(...kept.lifted, ...body.listed, ...body.lifted);
    if (kept.listed.length > 0) {
      // Members this file adds to an entry of another file still need a parent in this file's outline.
      const children = inOrder(kept.listed);
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
