import * as fs from 'fs';
import { performance } from 'perf_hooks';
import ResolvedFile from '../file-resolver';
import Parser from '../parser';
import { analyze } from '../analysis/binder';
import { outlineFor, CodeSymbol } from '../symbols';
import { Chunk } from '../statements';
import { outlineLines } from './outline-utils';
import { ChildParseJob, ChildParseResult, formatError, TestFilesResolver } from './test-utils';

function collectInvalid(syms: CodeSymbol[], mainFile: ResolvedFile): string[] {
  const invalid: string[] = [];
  function walk(list: CodeSymbol[]) {
    for (const s of list) {
      if (
        s.loc.start.index > s.loc.end.index ||
        s.selectionLoc.start.index < s.loc.start.index ||
        s.selectionLoc.end.index > s.loc.end.index ||
        !mainFile.equals(s.loc.start.filename) ||
        !mainFile.equals(s.loc.end.filename) ||
        !mainFile.equals(s.selectionLoc.start.filename) ||
        !mainFile.equals(s.selectionLoc.end.filename)
      ) {
        invalid.push(s.name);
      }
      walk(s.children);
    }
  }
  walk(syms);
  return invalid;
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
    };
  }

  // A throw in the analysis shows up in `threw` too, along with what the parse
  // found.
  let symbols: CodeSymbol[];
  try {
    symbols = outlineFor(analyze(chunk), mainFile);
  } catch (e) {
    return {
      ms: performance.now() - start,
      threw: e instanceof Error ? e.stack ?? e.message : String(e),
      errors: chunk.errors.map(formatError),
      statements: chunk.block.body.map(s => s.type + (s.included ? '*' : '')),
      outline: [],
      invalid: [],
    };
  }

  const ms = performance.now() - start;
  return {
    ms,
    threw: null,
    errors: chunk.errors.map(formatError),
    statements: chunk.block.body.map(s => s.type + (s.included ? '*' : '')),
    outline: outlineLines(symbols),
    invalid: collectInvalid(symbols, mainFile),
  };
}

const { jobs } = JSON.parse(fs.readFileSync(0, 'utf8')) as { jobs: ChildParseJob[] };
process.stdout.write(JSON.stringify(jobs.map(parseJob)));
