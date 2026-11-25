import * as assert from 'assert';
import { getTestFileContents, parseManyInChild, TEST_CARTS } from './test-utils';

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

describe('robustness on half-typed lines', function () {
  this.timeout(120000);

  for (const name of TEST_CARTS) {
    it(`parses ${name} with sampled lines cut in half or after an =`, () => {
      const text = getTestFileContents(name);
      const versions = [
        ...editedVersions(name, text, SAMPLES, cutInHalf),
        ...editedVersions(name, text, EDIT_SAMPLES, cutAfterAssignment),
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
