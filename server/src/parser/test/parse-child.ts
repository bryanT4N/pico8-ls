import * as fs from 'fs';
import { performance } from 'perf_hooks';
import ResolvedFile from '../file-resolver';
import Parser from '../parser';
import { Chunk } from '../statements';
import { outlineLines } from './outline-utils';
import { ChildParseJob, ChildParseResult, formatError, TestFilesResolver } from './test-utils';

function parseJob(job: ChildParseJob): ChildParseResult {
  const parser = new Parser(new ResolvedFile('main_test_file', 'main_test_file'), job.code, {
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
    };
  }
  const ms = performance.now() - start;
  return {
    ms,
    threw: null,
    errors: chunk.errors.map(formatError),
    statements: chunk.block.body.map(s => s.type + (s.included ? '*' : '')),
    outline: outlineLines(chunk.symbols),
  };
}

const { jobs } = JSON.parse(fs.readFileSync(0, 'utf8')) as { jobs: ChildParseJob[] };
process.stdout.write(JSON.stringify(jobs.map(parseJob)));
