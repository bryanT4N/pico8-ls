import {
  DocumentSymbol, Range, SymbolKind,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Bounds } from './parser/types';
import { CodeSymbolType, CodeSymbol } from './parser/symbols';
import { Chunk } from './parser/statements';
import { getFoldingRegions } from './parser/folding-regions';

const symbolTypeLookup: Record<CodeSymbolType, SymbolKind> = {
  [CodeSymbolType.Function]: SymbolKind.Function,
  [CodeSymbolType.Method]: SymbolKind.Method,
  [CodeSymbolType.Table]: SymbolKind.Object,
  [CodeSymbolType.Array]: SymbolKind.Array,
  [CodeSymbolType.Field]: SymbolKind.Property,
  [CodeSymbolType.Variable]: SymbolKind.Variable,
  // Obviously a label is not null but there's no Label thing and the Null has a cool icon
  [CodeSymbolType.Label]: SymbolKind.Null,
};

export function symbolKindFor(type: CodeSymbolType): SymbolKind {
  return symbolTypeLookup[type];
}

export function boundsToRange(textDocument: TextDocument, bounds: Bounds): Range {
  return {
    start: textDocument.positionAt(bounds?.start?.index ?? 0),
    end: textDocument.positionAt(bounds?.end?.index ?? 0),
  };
}

export function toDocumentSymbol(textDocument: TextDocument, symbol: CodeSymbol): DocumentSymbol {
  return {
    name: symbol.name,
    detail: symbol.detail,
    kind: symbolKindFor(symbol.type),
    range: boundsToRange(textDocument, symbol.loc),
    selectionRange: boundsToRange(textDocument, symbol.selectionLoc),
    children: symbol.children.map(child => toDocumentSymbol(textDocument, child)),
  };
}

export function buildDocumentSymbols(textDocument: TextDocument, chunk: Chunk): DocumentSymbol[] {
  const symbolInfo: DocumentSymbol[] = chunk.symbols.map(sym => toDocumentSymbol(textDocument, sym));
  const foldingRegions = getFoldingRegions(textDocument, chunk.comments || []);
  const rootSymbols: DocumentSymbol[] = [];
  const regionSymbols: DocumentSymbol[] = foldingRegions.map(region => {
    const range = Range.create(region.startLine, 0, region.endLine, 0);
    const regionSymbol = DocumentSymbol.create(
      region.name,
      '',
      SymbolKind.Namespace,
      range,
      range,
    );
    regionSymbol.children = [];
    return regionSymbol;
  });

  for (const symbol of symbolInfo) {
    let parent: DocumentSymbol | undefined;
    for (const regionSymbol of regionSymbols) {
      if (regionSymbol.range.start.line <= symbol.range.start.line && regionSymbol.range.end.line >= symbol.range.end.line) {
        parent = regionSymbol;
        break;
      }
    }

    if (parent) {
      parent.children!.push(symbol);
    } else {
      rootSymbols.push(symbol);
    }
  }

  return rootSymbols.concat(regionSymbols);
}
