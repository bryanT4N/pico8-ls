import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import Parser from '../parser/parser';
import ResolvedFile from '../parser/file-resolver';
import { computeFoldingRanges } from '../folding-ranges';
import { TEST_CARTS } from '../parser/test/test-utils';

const TESTFILES = path.join(__dirname, '../../../testfiles');
const GOLDEN = path.join(__dirname, '../../src/test/goldens/folding-ranges.json');

function rangesFor(name: string): string[] {
  const filepath = path.join(TESTFILES, name);
  const text = fs.readFileSync(filepath, 'utf8');
  const file = ResolvedFile.fromPath(filepath);
  const doc = TextDocument.create(file.fileURL, name.endsWith('.p8') ? 'pico-8' : 'pico-8-lua', 1, text);
  const chunk = new Parser(file, text).parseChunk();
  return computeFoldingRanges(doc, chunk)
    .map(r => `${r.startLine}-${r.endLine}${r.kind ? ' ' + r.kind : ''}`)
    .sort();
}

describe('computeFoldingRanges', () => {
  it('gives the same ranges as before for every test cart', () => {
    const actual: Record<string, string[]> = {};
    for (const name of TEST_CARTS) {
      actual[name] = rangesFor(name);
    }
    if (process.env.UPDATE_GOLDENS) {
      fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
      fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 1) + '\n');
    }
    assert.deepStrictEqual(actual, JSON.parse(fs.readFileSync(GOLDEN, 'utf8')));
  });
});
