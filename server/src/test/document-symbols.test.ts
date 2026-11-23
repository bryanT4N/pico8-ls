import * as assert from 'assert';
import { DocumentSymbol, Range, SymbolKind } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import Parser from '../parser/parser';
import ResolvedFile from '../parser/file-resolver';
import { CodeSymbolType } from '../parser/symbols';
import { buildDocumentSymbols, symbolKindFor } from '../document-symbols';
import { computeFoldingRanges } from '../folding-ranges';

const lines = (...l: string[]) => l.join('\n');
const P8 = 'pico-8 cartridge // http://www.pico-8.com\nversion 43\n__lua__\n';

function documentSymbolsOf(filename: string, text: string): DocumentSymbol[] {
  const file = new ResolvedFile(filename, `file:///${filename}`);
  const doc = TextDocument.create(file.fileURL, filename.endsWith('.p8') ? 'pico-8' : 'pico-8-lua', 1, text);
  return buildDocumentSymbols(doc, new Parser(file, text).parseChunk());
}

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
    assert.deepStrictEqual(symbols.map(s => s.name), [ '0: tab', '1: tab' ]);
    assert.deepStrictEqual(symbols[0].children!.map(s => s.name), [ 'f' ]);
    assert.deepStrictEqual(symbols[1].children!.map(s => s.name), [ 'g' ]);
    assert.doesNotThrow(() => computeFoldingRanges(doc, chunk));
  });

  it('nests regions in the outline', () => {
    const symbols = documentSymbolsOf('test.lua',
      lines('-- #region outer', '-- #region inner', 'function f() end', '-- #endregion', 'function g() end', '-- #endregion'));
    assert.deepStrictEqual(symbols.map(s => s.name), [ 'outer' ]);
    const outer = symbols[0];
    assert.deepStrictEqual(outer.range, Range.create(0, 0, 5, 13));
    assert.deepStrictEqual(outer.selectionRange, outer.range);
    assert.deepStrictEqual(outer.children!.map(s => s.name), [ 'inner', 'g' ]);
    const inner = outer.children![0];
    assert.deepStrictEqual(inner.range, Range.create(1, 0, 3, 13));
    assert.deepStrictEqual(inner.children!.map(s => s.name), [ 'f' ]);
  });

  it('puts a region in the nearest region around it and lists children in order', () => {
    const symbols = documentSymbolsOf('test.lua', lines('-- #region a', 'function f() end', '-- #region b', '-- #region c',
      'function g() end', '-- #endregion', '-- #endregion', '-- #endregion'));
    const a = symbols[0];
    assert.deepStrictEqual(a.children!.map(s => s.name), [ 'f', 'b' ]);
    const b = a.children![1];
    assert.deepStrictEqual(b.children!.map(s => s.name), [ 'c' ]);
    assert.deepStrictEqual(b.children![0].children!.map(s => s.name), [ 'g' ]);
  });

  it('puts a region inside a tab with the same range', () => {
    const symbols = documentSymbolsOf('test.p8',
      P8 + lines('f()', '-->8', '-- #region player', 'function player() end', '-- #endregion', '__gfx__'));
    assert.deepStrictEqual(symbols.map(s => s.name), [ '0: tab', '1: #region player' ]);
    assert.deepStrictEqual(symbols[0].range, Range.create(3, 0, 3, 3));
    const regions = symbols[1].children!;
    assert.deepStrictEqual(regions.map(s => [ s.name, s.kind ]), [[ 'player', SymbolKind.Namespace ]]);
    assert.deepStrictEqual(regions[0].children!.map(s => [ s.name, s.kind ]), [[ 'player', SymbolKind.Function ]]);
  });
});
