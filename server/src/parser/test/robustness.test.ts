import * as assert from 'assert';
import { getTestFileContents, parseManyInChild, TEST_CARTS } from './test-utils';

const SAMPLES = 40;
const MAX_MS = 2000;

// Each version cuts one sampled code line in half, as if it were being typed.
function halfTypedVersions(name: string, text: string): string[] {
  const lines = text.split('\n');
  let first = 0;
  let last = lines.length;
  if (name.endsWith('.p8')) {
    first = lines.findIndex(l => l.trim() === '__lua__') + 1;
    const next = lines.findIndex((l, i) => i >= first && /^__[a-z0-9]+__$/.test(l.trim()));
    last = next === -1 ? lines.length : next;
  }
  const code: number[] = [];
  for (let i = first; i < last; i++) {
    if (lines[i].trim().length > 1) {
      code.push(i);
    }
  }
  const n = Math.min(SAMPLES, code.length);
  return Array.from({ length: n }, (_, k) => {
    const i = code[Math.floor(k * code.length / n)];
    const copy = lines.slice();
    const cr = copy[i].endsWith('\r') ? '\r' : '';
    const body = copy[i].replace(/\r$/, '');
    copy[i] = body.slice(0, Math.ceil(body.length / 2)) + cr;
    return copy.join('\n');
  });
}

describe('robustness on half-typed lines', function () {
  this.timeout(120000);

  for (const name of TEST_CARTS) {
    it(`parses ${name} with sampled lines cut in half`, () => {
      const results = parseManyInChild(halfTypedVersions(name, getTestFileContents(name)).map(code => ({ code })), 60000);
      results.forEach((r, i) => {
        assert.strictEqual(r.threw, null, `version ${i}: ${r.threw}`);
        assert.ok(r.ms < MAX_MS, `version ${i}: ${r.ms} ms`);
        assert.deepStrictEqual(r.invalid, [], `version ${i}: invalid outline entries`);
      });
      assert.ok(results.reduce((sum, r) => sum + r.queries, 0) > 0, 'no queries ran');
    });
  }
});
