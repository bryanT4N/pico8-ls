import * as fs from 'fs';
import { performance } from 'perf_hooks';
import ResolvedFile from '../file-resolver';
import Parser from '../parser';
import { analyze } from '../analysis/binder';
import { Analysis } from '../analysis/model';
import { definitionsAt, membersAt, referenceAt, referencesOf, visibleAt, warningsOf } from '../analysis/queries';
import { outlineFor, CodeSymbol, CodeSymbolType } from '../symbols';
import { Chunk } from '../statements';
import { codeLocationToString } from '../types';
import { completionItems, completionRequestAt } from '../../completion';
import { hoverMarkdown } from '../../hover';
import { signatureHelpAt } from '../../signature-help';
import { searchSymbols, symbolItems } from '../../workspace-symbols';
import { outlineLines } from './outline-utils';
import { ALL_OUTLINE_OPTIONS, ChildParseJob, ChildParseResult, formatError, TestFilesResolver } from './test-utils';

const PLACES = 25;

function collectInvalid(syms: CodeSymbol[], mainFile: ResolvedFile): string[] {
  const invalid: string[] = [];
  function walk(list: CodeSymbol[], block?: CodeSymbol) {
    for (const s of list) {
      if (
        s.loc.start.index > s.loc.end.index ||
        s.selectionLoc.start.index < s.loc.start.index ||
        s.selectionLoc.end.index > s.loc.end.index ||
        !mainFile.equals(s.loc.start.filename) ||
        !mainFile.equals(s.loc.end.filename) ||
        !mainFile.equals(s.selectionLoc.start.filename) ||
        !mainFile.equals(s.selectionLoc.end.filename) ||
        s.name === '' ||
        (block !== undefined && (s.loc.start.index < block.loc.start.index || s.loc.end.index > block.loc.end.index))
      ) {
        invalid.push(s.name);
      }
      walk(s.children, s.type === CodeSymbolType.Block ? s : undefined);
    }
  }
  walk(syms);
  return invalid;
}

type Counts = Pick<ChildParseResult, 'queries' | 'hovers' | 'signatureHelps' | 'symbols'>;

// The lookups the editor asks for while code is being typed, counted as they return, so that a throw leaves the counts
// of those before it.
function runQueries(analysis: Analysis, file: ResolvedFile, code: string, counts: Counts): void {
  for (const reference of analysis.referencesByFile.get(file.path) ?? []) {
    const found = referenceAt(analysis, file, reference.loc.start.index);
    if (!found) {
      throw new Error(`no reference at ${codeLocationToString(reference.loc.start)}`);
    }
    definitionsAt(analysis, found);
    referencesOf(found.symbol, true);
    hoverMarkdown(analysis, found);
    counts.hovers++;
    counts.queries += 4;
  }
  warningsOf(analysis);
  counts.queries++;
  const items = [ ...symbolItems(analysis).values() ].flat();
  counts.symbols += items.length;
  searchSymbols(items, 'e');
  searchSymbols([ ...symbolItems(analysis, ALL_OUTLINE_OPTIONS).values() ].flat(), 'e');
  const lines = code.split('\n');
  for (let k = 0; k < PLACES; k++) {
    const index = Math.floor(k * code.length / (PLACES - 1));
    const before = code.slice(0, index).split('\n');
    const line = before.length - 1;
    const column = before[line].length;
    visibleAt(analysis, file, index);
    membersAt(analysis, file, index, [ 'self' ], false);
    completionItems([ analysis ], file, index, completionRequestAt(lines[line], column), line, column);
    signatureHelpAt([ analysis ], file, code, index);
    counts.signatureHelps++;
    counts.queries += 4;
  }
}

function parseJob(job: ChildParseJob): ChildParseResult {
  const mainFile = new ResolvedFile('main_test_file', 'main_test_file');
  const parser = new Parser(mainFile, job.code, {
    includeFileResolver: new TestFilesResolver(job.files ?? {}),
  });
  const start = performance.now();
  let chunk: Chunk;
  try {
    chunk = parser.parseChunk();
  } catch (e) {
    return {
      ms: performance.now() - start,
      threw: e instanceof Error ? e.stack ?? e.message : String(e),
      errors: [],
      statements: [],
      outline: [],
      invalid: [],
      queries: 0,
      hovers: 0,
      signatureHelps: 0,
      symbols: 0,
    };
  }

  // A throw in the analysis or in a query shows up in `threw` too, along with
  // what the parse found.
  let symbols: CodeSymbol[];
  let allOptions: CodeSymbol[];
  const counts: Counts = { queries: 0, hovers: 0, signatureHelps: 0, symbols: 0 };
  try {
    const analysis = analyze(chunk);
    symbols = outlineFor(analysis, mainFile);
    allOptions = outlineFor(analysis, mainFile, ALL_OUTLINE_OPTIONS, job.code);
    runQueries(analysis, mainFile, job.code, counts);
  } catch (e) {
    return {
      ms: performance.now() - start,
      threw: e instanceof Error ? e.stack ?? e.message : String(e),
      errors: chunk.errors.map(formatError),
      statements: chunk.block.body.map(s => s.type + (s.included ? '*' : '')),
      outline: [],
      invalid: [],
      ...counts,
    };
  }

  const ms = performance.now() - start;
  return {
    ms,
    threw: null,
    errors: chunk.errors.map(formatError),
    statements: chunk.block.body.map(s => s.type + (s.included ? '*' : '')),
    outline: outlineLines(symbols),
    invalid: [ ...collectInvalid(symbols, mainFile), ...collectInvalid(allOptions, mainFile).map(name => 'all options: ' + name) ],
    ...counts,
  };
}

const { jobs } = JSON.parse(fs.readFileSync(0, 'utf8')) as { jobs: ChildParseJob[] };
process.stdout.write(JSON.stringify(jobs.map(parseJob)));
