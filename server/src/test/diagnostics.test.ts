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
});

describe('errorsInFile', () => {
  it('keeps only the errors that start in the file', () => {
    const errors = [ new ParseError('in a', at('a', 1)), new ParseError('in b', at('b', 1)) ];
    assert.deepStrictEqual(errorsInFile('a', errors).map(e => e.message), [ 'in a' ]);
  });
});
