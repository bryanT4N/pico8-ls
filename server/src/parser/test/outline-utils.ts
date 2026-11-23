import { CodeSymbol } from '../symbols';
import { parse, TestParseOptions } from './test-utils';

export function outlineLines(symbols: CodeSymbol[]): string[] {
  const lines: string[] = [];
  const walk = (level: CodeSymbol[], depth: number) => {
    for (const s of level) {
      lines.push(`${'  '.repeat(depth)}${s.name}${s.detail ?? ''} [${s.type}]`);
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
