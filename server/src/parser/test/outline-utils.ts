import { CodeSymbol } from '../symbols';
import { Bounds } from '../types';
import { parse, TestParseOptions } from './test-utils';

export function outlineLines(symbols: CodeSymbol[]): string[] {
  return linesOf(symbols, s => `${s.name}${s.detail ?? ''} [${s.type}]`);
}

export function outlineLinesWithRanges(symbols: CodeSymbol[]): string[] {
  const at = (b: Bounds) => `${b.start.line}:${b.start.column}-${b.end.line}:${b.end.column}`;
  return linesOf(symbols, s => `${s.name}${s.detail ?? ''} [${s.type}] ${at(s.loc)} ${at(s.selectionLoc)}`);
}

function linesOf(symbols: CodeSymbol[], describe: (s: CodeSymbol) => string): string[] {
  const lines: string[] = [];
  const walk = (level: CodeSymbol[], depth: number) => {
    for (const s of level) {
      lines.push(`${'  '.repeat(depth)}${describe(s)}`);
      walk(s.children, depth + 1);
    }
  };
  walk(symbols, 0);
  return lines;
}

export function outlineOf(code: string, opts: TestParseOptions = {}): string {
  return outlineLines(parse(code, opts).symbols).join('\n');
}

export function allSymbols(symbols: CodeSymbol[]): CodeSymbol[] {
  return symbols.reduce((all: CodeSymbol[], s) => all.concat([ s ], allSymbols(s.children)), []);
}
