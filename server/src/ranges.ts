import { Range } from 'vscode-languageserver/node';
import { Bounds } from './parser/types';

export function rangeOf(bounds: Bounds): Range {
  return {
    start: { line: bounds.start.line - 1, character: bounds.start.column },
    end: { line: bounds.end.line - 1, character: bounds.end.column },
  };
}
