import * as assert from 'assert';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyze } from '../parser/analysis/binder';
import { referenceAt, warningsOf } from '../parser/analysis/queries';
import ResolvedFile from '../parser/file-resolver';
import { outlineFor } from '../parser/symbols';
import { outlineLines } from '../parser/test/outline-utils';
import { ALL_OUTLINE_OPTIONS, formatError, parse } from '../parser/test/test-utils';
import { buildDocumentSymbols } from '../document-symbols';
import { computeFoldingRanges } from '../folding-ranges';
import { hoverMarkdown } from '../hover';
import { signatureHelpAt } from '../signature-help';
import { searchSymbols, symbolItems } from '../workspace-symbols';

const N = 30000;
const file = new ResolvedFile('main_test_file', 'main_test_file');

// What the server does with a file when the editor asks for everything. Returns the errors and the outline.
function serve(code: string): { errors: string[], outline: string[] } {
  const chunk = parse(code);
  const analysis = analyze(chunk);
  outlineFor(analysis, file, ALL_OUTLINE_OPTIONS, code);
  const document = TextDocument.create('file:///main_test_file', 'pico-8-lua', 0, code);
  computeFoldingRanges(document, chunk);
  buildDocumentSymbols(document, chunk.comments ?? [], chunk.symbols);
  searchSymbols([ ...symbolItems(analysis, ALL_OUTLINE_OPTIONS).values() ].flat(), 'b');
  warningsOf(analysis);
  const references = analysis.referencesByFile.get(file.path) ?? [];
  for (const reference of [ references[0], references[references.length - 1] ]) {
    if (reference) {
      hoverMarkdown(analysis, referenceAt(analysis, file, reference.loc.start.index)!);
    }
  }
  signatureHelpAt([ analysis ], file, code, code.length);
  return { errors: chunk.errors.map(formatError), outline: outlineLines(chunk.symbols) };
}

describe('code nested deep or chained long', function () {
  this.timeout(20000);

  const chains: [string, string, string[]][] = [
    [ '1+1+... on one line', 'x = 1' + '+1'.repeat(N - 1), [ 'x [Variable]' ]],
    [ '1, then +1 on each line', 'x = 1\n' + '+1\n'.repeat(N - 1), [ 'x [Variable]' ]],
    [ 'a and a and ...', 'x = a' + ' and a'.repeat(N - 1), [ 'x [Variable]' ]],
    [ 'a.b.b...', 'x = a' + '.b'.repeat(N - 1), [ 'x [Variable]' ]],
    [ 'a:m():m()...', 'x = a' + ':m()'.repeat(N - 1), [ 'x [Variable]' ]],
    [ 'f()()...', 'f' + '()'.repeat(N - 1), []],
    [ 'a.b.b... = 1', 'a' + '.b'.repeat(N - 1) + ' = 1', [ 'a [Table]' ]],
  ];
  for (const [ name, code, outline ] of chains) {
    it(`serves ${name} with 30,000 terms`, () => {
      assert.deepStrictEqual(serve(code), { errors: [], outline });
    });
  }

  it('serves function a.b.b...() with 30,000 names', () => {
    const { errors, outline } = serve('function a' + '.b'.repeat(N - 1) + '() end');
    assert.deepStrictEqual([ errors, outline ], [[], [ 'a' + '.b'.repeat(N - 1) + '() [Method]' ]]);
  });

  it('lists a path of 200 keys in the outline and leaves out one of 201', () => {
    assert.strictEqual(serve('a' + '.b'.repeat(200) + ' = 1').outline.length, 201);
    assert.deepStrictEqual(serve('a' + '.b'.repeat(201) + ' = 1').outline, [ 'a [Table]' ]);
  });

  it('serves 1,500 nested ifs and 5,000 nested parentheses', () => {
    assert.strictEqual(serve('if a then\n'.repeat(1500) + 'end\n'.repeat(1500) + 'y = 1').outline.includes('y [Variable]'), true);
    assert.deepStrictEqual(serve('x = ' + '('.repeat(5000) + '1' + ')'.repeat(5000) + '\ny = 1').outline, [ 'y [Variable]' ]);
  });
});
