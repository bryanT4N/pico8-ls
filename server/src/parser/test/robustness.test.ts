import * as assert from 'assert';
import { performance } from 'perf_hooks';
import Parser from '../parser';
import { getTestFileContents, parseManyInChild, TEST_CARTS, testFile } from './test-utils';

const SAMPLES = 40;
const EDIT_SAMPLES = 20;
const MAX_MS = 2000;

// Each version changes one code line, sampled from those edit applies to, as code is changed while it is typed. In a
// .p8, only the __lua__ section is code.
function editedVersions(name: string, text: string, count: number, edit: (line: string) => string | undefined): string[] {
  const lines = text.split('\n');
  let first = 0;
  let last = lines.length;
  if (name.endsWith('.p8')) {
    first = lines.findIndex(l => l.trim() === '__lua__') + 1;
    const next = lines.findIndex((l, i) => i >= first && /^__[a-z0-9]+__$/.test(l.trim()));
    last = next === -1 ? lines.length : next;
  }
  const edits = new Map<number, string>();
  for (let i = first; i < last; i++) {
    const edited = edit(lines[i].replace(/\r$/, ''));
    if (edited !== undefined) {
      edits.set(i, edited);
    }
  }
  const candidates = [ ...edits.keys() ];
  const n = Math.min(count, candidates.length);
  return Array.from({ length: n }, (_, k) => {
    const i = candidates[Math.floor(k * candidates.length / n)];
    const copy = lines.slice();
    copy[i] = edits.get(i)! + (copy[i].endsWith('\r') ? '\r' : '');
    return copy.join('\n');
  });
}

// As if the line were being typed.
const cutInHalf = (line: string) => line.trim().length > 1 ? line.slice(0, Math.ceil(line.length / 2)) : undefined;

// x = 1 becomes x =, with the value still to be typed; += and the like too.
function cutAfterAssignment(line: string): string | undefined {
  const match = /[^=~<>!]=(?!=)/.exec(line);
  return match ? line.slice(0, match.index + 2) : undefined;
}

// A table being typed, before its } is.
function deleteLastBrace(line: string): string | undefined {
  const i = line.lastIndexOf('}');
  return i === -1 ? undefined : line.slice(0, i) + line.slice(i + 1);
}

describe('robustness on half-typed lines', function () {
  this.timeout(120000);

  for (const name of TEST_CARTS) {
    it(`parses ${name} with sampled lines cut in half or after an =, or missing a }`, () => {
      const text = getTestFileContents(name);
      const versions = [
        ...editedVersions(name, text, SAMPLES, cutInHalf),
        ...editedVersions(name, text, EDIT_SAMPLES, cutAfterAssignment),
        ...editedVersions(name, text, EDIT_SAMPLES, deleteLastBrace),
      ];
      const results = parseManyInChild(versions.map(code => ({ code })), 60000);
      results.forEach((r, i) => {
        assert.strictEqual(r.threw, null, `version ${i}: ${r.threw}`);
        assert.ok(r.ms < MAX_MS, `version ${i}: ${r.ms} ms`);
        assert.deepStrictEqual(r.invalid, [], `version ${i}: invalid outline entries`);
      });
      assert.ok(results.reduce((sum, r) => sum + r.queries, 0) > 0, 'no queries ran');
      assert.ok(results.reduce((sum, r) => sum + r.hovers, 0) > 0, 'no hover ran');
      assert.ok(results.reduce((sum, r) => sum + r.signatureHelps, 0) > 0, 'no signature help ran');
      assert.ok(results.reduce((sum, r) => sum + r.symbols, 0) > 0, 'no workspace symbols');
    });
  }
});

// Statements that each fail on the line where their value starts, each in the function value of the one around it:
// parsing each of them again would double the work at every level.
function nestedInFunctionValues(depth: number, innermost: string, atEachLevel = ''): string {
  let code = innermost;
  for (let i = 0; i < depth; i++) {
    code = `v = g(function()\n${atEachLevel}${code}end) +\nw.x = 3\n`;
  }
  return code;
}

describe('robustness on unfinished statements nested in function values', function () {
  this.timeout(120000);

  // Mocha sets Error.stackTraceLimit to Infinity, so each parse error would copy the parser's whole stack, which is
  // deep here; the server runs with Node's default.
  let stackTraceLimit: number;
  before(() => {
    stackTraceLimit = Error.stackTraceLimit;
    Error.stackTraceLimit = 10;
  });
  after(() => {
    Error.stackTraceLimit = stackTraceLimit;
  });

  // The parse alone is timed: the analysis and lookups the other tests run take seconds on 3,000 locals.
  const NESTED: [string, string][] = [
    [ '20 deep', nestedInFunctionValues(20, 'y = 1\n') ],
    [ '60 deep around 3,000 lines', nestedInFunctionValues(60, 'local a = b + c * d\n'.repeat(3000)) ],
    [ '400 deep with another at each level', nestedInFunctionValues(400, 'x =\ny.z = 2\n', 'x =\ny.z = 2\n') ],
  ];
  for (const [ name, code ] of NESTED) {
    it(`parses them ${name} within ${MAX_MS} ms`, () => {
      const start = performance.now();
      new Parser(testFile(), code).parseChunk();
      const ms = performance.now() - start;
      assert.ok(ms < MAX_MS, `${ms} ms`);
    });
  }
});
