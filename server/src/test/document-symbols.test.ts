import * as assert from 'assert';
import { SymbolKind } from 'vscode-languageserver';
import { CodeSymbolType } from '../parser/symbols';
import { symbolKindFor } from '../document-symbols';

describe('symbolKindFor', () => {
  it('gives each symbol type its icon', () => {
    assert.deepStrictEqual(
      [ CodeSymbolType.Function, CodeSymbolType.Method, CodeSymbolType.Table, CodeSymbolType.Array,
        CodeSymbolType.Field, CodeSymbolType.Variable, CodeSymbolType.Label ].map(symbolKindFor),
      [ SymbolKind.Function, SymbolKind.Method, SymbolKind.Object, SymbolKind.Array,
        SymbolKind.Property, SymbolKind.Variable, SymbolKind.Null ]);
  });
});
