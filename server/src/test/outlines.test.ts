import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import Parser from '../parser/parser';
import ResolvedFile from '../parser/file-resolver';
import { analyze } from '../parser/analysis/binder';
import { outlineFor } from '../parser/symbols';
import { NO_OUTLINE_OPTIONS, OutlineOptions } from '../parser/outline/model';
import { outlineLinesWithRanges } from '../parser/test/outline-utils';
import { ALL_OUTLINE_OPTIONS, TEST_CARTS } from '../parser/test/test-utils';

const TESTFILES = path.join(__dirname, '../../../testfiles');
const GOLDEN = path.join(__dirname, '../../src/test/goldens/outlines.json');
const ALL_OPTIONS_GOLDEN = path.join(__dirname, '../../src/test/goldens/outlines-all-options.json');
const ALL_OPTIONS_CARTS = [ 'beetrootpaul-dart-07/game.lua', 'beetrootpaul-dart-07/screen_title.lua', 'low.lua', 'tweettweetjam-hop.p8' ];

function goldenLinesFor(name: string, options: OutlineOptions = NO_OUTLINE_OPTIONS): string[] {
  const filepath = path.join(TESTFILES, name);
  const file = ResolvedFile.fromPath(filepath);
  const text = fs.readFileSync(filepath, 'utf8');
  return outlineLinesWithRanges(outlineFor(analyze(new Parser(file, text).parseChunk()), file, options, text));
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

  it('gives the outline with all three options on for four test carts', () => {
    const actual: Record<string, string[]> = {};
    for (const name of ALL_OPTIONS_CARTS) {
      actual[name] = goldenLinesFor(name, ALL_OUTLINE_OPTIONS);
    }
    if (process.env.UPDATE_GOLDENS) {
      fs.writeFileSync(ALL_OPTIONS_GOLDEN, JSON.stringify(actual, null, 1) + '\n');
    }
    assert.deepStrictEqual(actual, JSON.parse(fs.readFileSync(ALL_OPTIONS_GOLDEN, 'utf8')));
  });
});
