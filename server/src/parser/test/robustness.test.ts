import * as assert from 'assert';
import { performance } from 'perf_hooks';
import { readCode } from '../code';
import Lexer from '../lexer';
import Parser from '../parser';
import { Token, TokenType } from '../tokens';
import { getTestFileContents, nestedInFunctionValues, parseManyInChild, TEST_CARTS, testFile } from './test-utils';

const SAMPLES = 40;
const EDIT_SAMPLES = 20;
const MAX_MS = 2000;

// The tokens of the code that match, by line from 0: an = or a } in a comment or a string is none.
function tokensOf(text: string, matches: (token: Token) => boolean): Map<number, Token[]> {
  const result = new Map<number, Token[]>();
  const lexer = new Lexer(readCode(text), testFile());
  do {
    lexer.next();
    if (lexer.token!.type !== TokenType.EOF && matches(lexer.token!)) {
      const line = lexer.token!.bounds.start.line - 1;
      const list = result.get(line) ?? [];
      list.push(lexer.token!);
      result.set(line, list);
    }
  } while (lexer.token!.type !== TokenType.EOF);
  return result;
}

function isAssignment(token: Token): boolean {
  return token.type === TokenType.Punctuator &&
    typeof token.value === 'string' && token.value.endsWith('=') &&
    token.value !== '==' && token.value !== '~=' && token.value !== '!=' && token.value !== '<=' && token.value !== '>=';
}

function isClosingBrace(token: Token): boolean {
  return token.type === TokenType.Punctuator && token.value === '}';
}

function editedVersions(name: string, text: string, count: number, edit: (line: string, index: number) => string | undefined): string[] {
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
    const edited = edit(lines[i].replace(/\r$/, ''), i);
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

const cutInHalf = (line: string) => line.trim().length > 1 ? line.slice(0, Math.ceil(line.length / 2)) : undefined;

// x = 1 becomes x =, with the value still to be typed; += and the like too.
function cutAfterAssignment(text: string): (line: string, index: number) => string | undefined {
  const byLine = tokensOf(text, isAssignment);
  return (line, index) => {
    const tokens = byLine.get(index);
    if (!tokens || tokens.length === 0) {
      return undefined;
    }
    return line.slice(0, tokens[0].bounds.end.column);
  };
}

// A table being typed, before its } is.
function deleteLastBrace(text: string): (line: string, index: number) => string | undefined {
  const byLine = tokensOf(text, isClosingBrace);
  return (line, index) => {
    const tokens = byLine.get(index);
    if (!tokens || tokens.length === 0) {
      return undefined;
    }
    const col = tokens[tokens.length - 1].bounds.start.column;
    return line.slice(0, col) + line.slice(col + 1);
  };
}

function bracesIn(text: string): number {
  let count = 0;
  for (const tokens of tokensOf(text, isClosingBrace).values()) {
    count += tokens.length;
  }
  return count;
}

describe('robustness on half-typed lines', function () {
  this.timeout(120000);

  for (const name of TEST_CARTS) {
    it(`parses ${name} with sampled lines cut in half or after an =, or missing a }`, () => {
      const text = getTestFileContents(name);
      const withoutBrace = editedVersions(name, text, EDIT_SAMPLES, deleteLastBrace(text));
      assert.deepStrictEqual(withoutBrace.map(bracesIn), withoutBrace.map(() => bracesIn(text) - 1));
      const versions = [
        ...editedVersions(name, text, SAMPLES, cutInHalf),
        ...editedVersions(name, text, EDIT_SAMPLES, cutAfterAssignment(text)),
        ...withoutBrace,
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

  // The parse alone is timed: the helper the other tests run looks up each reference in turn, which takes seconds on
  // 3,000 locals.
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
