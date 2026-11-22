import {
  DocumentSymbol, FoldingRange, SymbolKind,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Comment_ } from './parser/expressions';
import { Chunk } from './parser/statements';
import { FoldingRangeVisitor } from './parser/folding-range-visitor';
import { getSectionFoldingRegions } from './parser/folding-regions';

function getFoldingRangesFromSymbols(symbols: DocumentSymbol[]): FoldingRange[] {
  const ranges: FoldingRange[] = [];

  for (const symbol of symbols) {
    if (symbol.range.start.line < symbol.range.end.line) {
      ranges.push({
        startLine: symbol.range.start.line,
        endLine: symbol.range.end.line,
        kind: symbol.kind === SymbolKind.Namespace ? 'region' : undefined,
      });
    }

    if (symbol.children) {
      ranges.push(...getFoldingRangesFromSymbols(symbol.children));
    }
  }

  return ranges;
}

function getCommentFoldingRanges(comments: Comment_[]): FoldingRange[] {
  const ranges: FoldingRange[] = [];
  for (const comment of comments) {
    if (comment.loc && comment.loc.start.line < comment.loc.end.line) {
      ranges.push({
        startLine: comment.loc.start.line - 1,
        endLine: comment.loc.end.line - 1,
        kind: 'comment',
      });
    }
  }
  return ranges;
}

export function computeFoldingRanges(textDocument: TextDocument, chunk: Chunk, documentSymbols: DocumentSymbol[]): FoldingRange[] {
  // 1. Get ranges for the cartridge sections themselves (__lua__, __gfx__, etc)
  const sectionRanges: FoldingRange[] = getSectionFoldingRegions(textDocument).map(section => ({
    startLine: section.startLine,
    endLine: section.endLine,
    kind: 'region' as string,
  }));

  // 2. Get ranges from symbols (for PICO-8 regions and functions/vars)
  const symbolRanges = getFoldingRangesFromSymbols(documentSymbols);

  // 3. Get ranges from AST blocks (if, for, while, etc.)
  const visitor = new FoldingRangeVisitor();
  visitor.visit(chunk);
  const blockRanges = visitor.ranges;

  // 4. Get ranges from multi-line comments
  const commentRanges = getCommentFoldingRanges(chunk.comments || []);

  // 5. Combine and deduplicate
  const allRanges = [ ...sectionRanges, ...symbolRanges, ...blockRanges, ...commentRanges ];
  const uniqueRanges = Array.from(new Map(allRanges.map(r => [ `${r.startLine}-${r.endLine}`, r ])).values());

  return uniqueRanges;
}
