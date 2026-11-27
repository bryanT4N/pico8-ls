import {
  DocumentSymbol, Position, Range, SymbolKind,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CodeSymbolType, CodeSymbol } from './parser/symbols';
import { Comment_ } from './parser/expressions';
import { FoldingRegion, getFoldingRegions, tabAt } from './parser/folding-regions';
import { rangeOf } from './ranges';

const symbolTypeLookup: Record<CodeSymbolType, SymbolKind> = {
  [CodeSymbolType.Function]: SymbolKind.Function,
  [CodeSymbolType.Method]: SymbolKind.Method,
  [CodeSymbolType.Table]: SymbolKind.Object,
  [CodeSymbolType.Array]: SymbolKind.Array,
  [CodeSymbolType.Field]: SymbolKind.Property,
  [CodeSymbolType.Variable]: SymbolKind.Variable,
  // Obviously a label is not null but there's no Label thing and the Null has a cool icon
  [CodeSymbolType.Label]: SymbolKind.Null,
  // Like a tab or a #region: a place in the code, not a definition.
  [CodeSymbolType.Block]: SymbolKind.Namespace,
};

export function symbolKindFor(type: CodeSymbolType): SymbolKind {
  return symbolTypeLookup[type];
}

export function toDocumentSymbol(symbol: CodeSymbol): DocumentSymbol {
  return {
    name: symbol.name,
    detail: symbol.detail,
    kind: symbolKindFor(symbol.type),
    range: rangeOf(symbol.loc),
    selectionRange: rangeOf(symbol.selectionLoc),
    children: symbol.children.map(child => toDocumentSymbol(child)),
  };
}

export function buildDocumentSymbols(textDocument: TextDocument, comments: Comment_[], symbols: CodeSymbol[]): DocumentSymbol[] {
  const foldingRegions = getFoldingRegions(textDocument, comments);
  const regions = foldingRegions
    // A region that runs into a later tab would take that tab in, so in the
    // outline it ends with its own tab and the tabs stay at the top.
    .map(region => {
      const tab = region.kind === 'region' ? tabAt(foldingRegions, region.startLine) : undefined;
      return tab && tab.endLine < region.endLine ? { ...region, endLine: tab.endLine } : region;
    })
    .sort(outerFirst)
    .map(region => {
      const range = Range.create(Position.create(region.startLine, 0), endOfLine(textDocument, region.endLine));
      return DocumentSymbol.create(region.name, '', SymbolKind.Namespace, range, range, []);
    });

  const topLevelRegions: DocumentSymbol[] = [];
  regions.forEach((region, i) => {
    const parent = regions.slice(0, i).reverse().find(outer => containsLines(outer, region));
    (parent ? parent.children! : topLevelRegions).push(region);
  });

  const outsideRegions: DocumentSymbol[] = [];
  for (const entry of symbols.map(symbol => toDocumentSymbol(symbol))) {
    let innermost: DocumentSymbol | undefined;
    for (const region of regions) {
      // Of two regions over the same lines, the later one is inside the other.
      if (containsLines(region, entry) && (!innermost || lineSpan(region) <= lineSpan(innermost))) {
        innermost = region;
      }
    }
    (innermost ? innermost.children! : outsideRegions).push(entry);
  }

  for (const region of regions) {
    region.children!.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
  }
  return outsideRegions.concat(topLevelRegions);
}

function outerFirst(a: FoldingRegion, b: FoldingRegion): number {
  const kindOrder = { tab: 0, region: 1 };
  return a.startLine - b.startLine || b.endLine - a.endLine || kindOrder[a.kind] - kindOrder[b.kind];
}

function endOfLine(textDocument: TextDocument, line: number): Position {
  const text = textDocument.getText(Range.create(line, 0, line + 1, 0));
  return Position.create(line, text.replace(/[\r\n]+$/, '').length);
}

function containsLines(outer: DocumentSymbol, inner: DocumentSymbol): boolean {
  return outer.range.start.line <= inner.range.start.line && inner.range.end.line <= outer.range.end.line;
}

function lineSpan(symbol: DocumentSymbol): number {
  return symbol.range.end.line - symbol.range.start.line;
}
