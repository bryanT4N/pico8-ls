import ResolvedFile from '../file-resolver';
import { CodeSymbol, OutlineEntry } from './model';

export function projectToFile(entries: OutlineEntry[], file: ResolvedFile): CodeSymbol[] {
  return entries
    .filter(entry => entry.loc.start.filename.equals(file))
    .map(entry => ({
      name: entry.name,
      detail: entry.detail,
      type: entry.type,
      loc: entry.loc,
      selectionLoc: entry.selectionLoc,
      children: projectToFile(entry.children, file),
    }))
    .sort(bySourcePosition);
}

// Entries defined by the same statement share loc.start, so where their names sit breaks the tie.
function bySourcePosition(a: CodeSymbol, b: CodeSymbol): number {
  return a.loc.start.index - b.loc.start.index || a.selectionLoc.start.index - b.selectionLoc.start.index;
}
