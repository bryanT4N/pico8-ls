import * as assert from 'assert';
import { ParseError, Warning } from '../parser/errors';
import ResolvedFile from '../parser/file-resolver';
import { Bounds } from '../parser/types';
import { errorsInFile, FileDiagnostics, mergeDiagnostics } from '../diagnostics';

const at = (uri: string, line: number): Bounds => ({
  start: { line, column: 0, index: 0, filename: new ResolvedFile(uri, uri) },
  end: { line, column: 1, index: 1, filename: new ResolvedFile(uri, uri) },
});
const show = (list: FileDiagnostics[]) =>
  list.map(f => `${f.uri}:` + f.diagnostics.map(d => ` ${d.severity}@${d.range.start.line} ${d.message}`).join(''));

describe('mergeDiagnostics', () => {
  it('sends a file\'s parse errors and warnings together', () => {
    assert.deepStrictEqual(show(mergeDiagnostics([ 'a' ], new Map([[ 'a', [ new ParseError('bad', at('a', 3)) ]]]),
      [ new Warning('undefined variable: x', at('a', 1)) ])), [ 'a: 1@2 bad 2@0 undefined variable: x' ]);
  });

  it('sends an empty list for a file with neither, to clear it', () => {
    assert.deepStrictEqual(show(mergeDiagnostics([ 'a', 'b' ], new Map(), [ new Warning('w', at('b', 1)) ])), [ 'a:', 'b: 2@0 w' ]);
  });

  it('lists each file once', () => {
    assert.deepStrictEqual(show(mergeDiagnostics([ 'a', 'a' ], new Map(), [])), [ 'a:' ]);
  });

  it('adds files that only have warnings', () => {
    assert.deepStrictEqual(show(mergeDiagnostics([ 'a' ], new Map(), [ new Warning('w', at('c', 1)) ])), [ 'a:', 'c: 2@0 w' ]);
  });

  it('sends nothing when there are no files', () => {
    assert.deepStrictEqual(mergeDiagnostics([], new Map(), []), []);
  });

  it('does not send the parse errors of a file that is not listed and has no warnings', () => {
    assert.deepStrictEqual(show(mergeDiagnostics([ 'a' ], new Map([[ 'z', [ new ParseError('bad', at('z', 1)) ]]]), [])), [ 'a:' ]);
  });

  it('sends the parse errors of a file added for its warnings, errors first', () => {
    assert.deepStrictEqual(show(mergeDiagnostics([ 'a' ], new Map([[ 'c', [ new ParseError('bad', at('c', 3)) ]]]), [ new Warning('w', at('c', 1)) ])),
      [ 'a:', 'c: 1@2 bad 2@0 w' ]);
  });

  it('keeps the order of a file\'s warnings', () => {
    assert.deepStrictEqual(show(mergeDiagnostics([ 'a' ], new Map(), [ new Warning('w2', at('a', 5)), new Warning('w1', at('a', 1)) ])),
      [ 'a: 2@4 w2 2@0 w1' ]);
  });

  it('sends at most the given number of problems per file, parse errors first', () => {
    const errors = [ new ParseError('e1', at('a', 3)), new ParseError('e2', at('a', 4)), new ParseError('e3', at('a', 5)) ];
    const warnings = [ new Warning('w1', at('a', 1)), new Warning('w2', at('a', 2)), new Warning('wb1', at('b', 1)), new Warning('wb2', at('b', 2)) ];
    assert.deepStrictEqual(show(mergeDiagnostics([ 'a', 'b' ], new Map([[ 'a', errors ]]), warnings, 4)),
      [ 'a: 1@2 e1 1@3 e2 1@4 e3 2@0 w1', 'b: 2@0 wb1 2@1 wb2' ]);
  });
});

describe('errorsInFile', () => {
  it('keeps only the errors that start in the file', () => {
    const errors = [ new ParseError('in a', at('a', 1)), new ParseError('in b', at('b', 1)) ];
    assert.deepStrictEqual(errorsInFile('a', errors).map(e => e.message), [ 'in a' ]);
  });
});
