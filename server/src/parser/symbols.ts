import ResolvedFile from './file-resolver';
import { CodeSymbol } from './outline/model';
import { projectToFile } from './outline/project';
import { resolveOutline } from './outline/resolver';
import { Chunk } from './statements';

export { CodeSymbolType, CodeSymbol } from './outline/model';

export function findSymbols(chunk: Chunk, file: ResolvedFile): CodeSymbol[] {
  return projectToFile(resolveOutline(chunk), file);
}
