import { CodeSymbol } from '../symbols';
import { parse, TestParseOptions } from './test-utils';

export function outlineOf(code: string, opts: TestParseOptions = {}): string {
  const lines: string[] = [];
  const walk = (symbols: CodeSymbol[], depth: number) => {
    for (const s of symbols) {
      lines.push(`${'  '.repeat(depth)}${s.name}${s.detail ?? ''} [${s.type}]`);
      walk(s.children, depth + 1);
    }
  };
  walk(parse(code, opts).symbols, 0);
  return lines.join('\n');
}

export function allSymbols(symbols: CodeSymbol[]): CodeSymbol[] {
  return symbols.reduce((all: CodeSymbol[], s) => all.concat([ s ], allSymbols(s.children)), []);
}
