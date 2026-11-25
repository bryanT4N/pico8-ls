import { Analysis } from './analysis/model';
import ResolvedFile from './file-resolver';
import { CodeSymbol, NO_OUTLINE_OPTIONS, OutlineOptions } from './outline/model';
import { projectToFile } from './outline/project';

export { CodeSymbolType, CodeSymbol } from './outline/model';

// text: the file's text, which names the blocks.
export function outlineFor(analysis: Analysis, file: ResolvedFile, options: OutlineOptions = NO_OUTLINE_OPTIONS, text = ''): CodeSymbol[] {
  return projectToFile(analysis.outline, file, analysis.blocks, options, text);
}
