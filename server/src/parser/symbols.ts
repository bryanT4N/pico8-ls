import { Analysis } from './analysis/model';
import ResolvedFile from './file-resolver';
import { CodeSymbol } from './outline/model';
import { projectToFile } from './outline/project';

export { CodeSymbolType, CodeSymbol } from './outline/model';

export function outlineFor(analysis: Analysis, file: ResolvedFile): CodeSymbol[] {
  return projectToFile(analysis.outline, file);
}
