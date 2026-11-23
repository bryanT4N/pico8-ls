import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import Parser from '../parser/parser';
import ResolvedFile from '../parser/file-resolver';
import { analyze } from '../parser/analysis/binder';
import { CodeSymbol, outlineFor } from '../parser/symbols';
import { TEST_CARTS } from '../parser/test/test-utils';
import { Bounds } from '../parser/types';

const TESTFILES = path.join(__dirname, '../../../testfiles');
const GOLDEN = path.join(__dirname, '../../src/test/goldens/outlines.json');

const at = (b: Bounds) => `${b.start.line}:${b.start.column}-${b.end.line}:${b.end.column}`;

function goldenLinesFor(name: string): string[] {
  const filepath = path.join(TESTFILES, name);
  const file = ResolvedFile.fromPath(filepath);
  const lines: string[] = [];
  const walk = (symbols: CodeSymbol[], depth: number) => {
    for (const s of symbols) {
      lines.push(`${'  '.repeat(depth)}${s.name}${s.detail ?? ''} [${s.type}] ${at(s.loc)} ${at(s.selectionLoc)}`);
      walk(s.children, depth + 1);
    }
  };
  walk(outlineFor(analyze(new Parser(file, fs.readFileSync(filepath, 'utf8')).parseChunk()), file), 0);
  return lines;
}

describe('outline golden', () => {
  it('gives the same outline as before for every test cart', () => {
    const actual: Record<string, string[]> = {};
    for (const name of TEST_CARTS) {
      actual[name] = goldenLinesFor(name);
    }
    if (process.env.UPDATE_GOLDENS) {
      fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 1) + '\n');
    }
    assert.deepStrictEqual(actual, JSON.parse(fs.readFileSync(GOLDEN, 'utf8')));
  });
});
