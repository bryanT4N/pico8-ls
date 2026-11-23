import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import Parser from '../parser/parser';
import ResolvedFile from '../parser/file-resolver';
import { computeFoldingRanges } from '../folding-ranges';
import { AssignmentStatement } from '../parser/statements';
import { formatError, TEST_CARTS } from '../parser/test/test-utils';

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

  describe('in a cart with a long comment or string left open', () => {
    const P8 = 'pico-8 cartridge // http://www.pico-8.com\nversion 43\n__lua__\n';
    const GFX_LINE = 6;

    function parseCart(openLine: string) {
      const text = P8 + [ 'a = 1', openLine, 'b = 2', '__gfx__', '0000' ].join('\n');
      const file = new ResolvedFile('main_test_file', 'main_test_file');
      const chunk = new Parser(file, text).parseChunk();
      const crossing = computeFoldingRanges(TextDocument.create('file:///test.p8', 'pico-8', 1, text), chunk)
        .filter(r => r.startLine < GFX_LINE && r.endLine >= GFX_LINE);
      return { chunk, crossing };
    }

    it('ends a long comment at the end of the code', () => {
      const { chunk, crossing } = parseCart('--[[ open');
      assert.deepStrictEqual(chunk.comments!.map(c => [ c.loc!.start.line, c.loc!.end.line ]), [[ 5, 6 ]]);
      assert.deepStrictEqual(chunk.errors.map(formatError), [ 'main_test_file 5:0 unfinished long comment (starting at line 5) near \'<eof>\'' ]);
      assert.deepStrictEqual(crossing, []);
    });

    it('ends a long string at the end of the code', () => {
      const { chunk, crossing } = parseCart('s = [[ open');
      const string = (chunk.block.body[1] as AssignmentStatement).init[0];
      assert.deepStrictEqual([ string.loc!.start.line, string.loc!.end.line ], [ 5, 6 ]);
      assert.deepStrictEqual(chunk.errors.map(formatError), [ 'main_test_file 5:4 unfinished long string (starting at line 5) near \'<eof>\'' ]);
      assert.deepStrictEqual(crossing, []);
    });
  });
});
