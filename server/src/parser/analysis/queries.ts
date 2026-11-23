import ResolvedFile from '../file-resolver';
import { Analysis, Reference } from './model';

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
