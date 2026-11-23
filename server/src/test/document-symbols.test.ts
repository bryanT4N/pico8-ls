import * as assert from 'assert';
import { SymbolKind } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import Parser from '../parser/parser';
import ResolvedFile from '../parser/file-resolver';
import { CodeSymbolType } from '../parser/symbols';
import { buildDocumentSymbols, symbolKindFor } from '../document-symbols';
import { computeFoldingRanges } from '../folding-ranges';

describe('symbolKindFor', () => {
  it('gives each symbol type its icon', () => {
    assert.deepStrictEqual(
      [ CodeSymbolType.Function, CodeSymbolType.Method, CodeSymbolType.Table, CodeSymbolType.Array,
        CodeSymbolType.Field, CodeSymbolType.Variable, CodeSymbolType.Label ].map(symbolKindFor),
      [ SymbolKind.Function, SymbolKind.Method, SymbolKind.Object, SymbolKind.Array,
        SymbolKind.Property, SymbolKind.Variable, SymbolKind.Null ]);
  });
});

describe('buildDocumentSymbols', () => {
  it('groups the last tab when its -->8 is the last comment', () => {
    const text = 'function f() end\n-->8\nfunction g() end';
    const file = new ResolvedFile('test.lua', 'file:///test.lua');
    const doc = TextDocument.create(file.fileURL, 'pico-8-lua', 1, text);
    const chunk = new Parser(file, text).parseChunk();
    const symbols = buildDocumentSymbols(doc, chunk);
    assert.deepStrictEqual(symbols.map(s => s.name), [ 'f', '0: tab' ]);
    assert.deepStrictEqual(symbols[1].children!.map(s => s.name), [ 'g' ]);
    assert.doesNotThrow(() => computeFoldingRanges(doc, chunk));
  });
});
