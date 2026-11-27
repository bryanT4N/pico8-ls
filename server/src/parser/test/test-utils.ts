import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';
import { spawnSync } from 'child_process';
import { fail } from 'assert';
import { readCode } from '../code';
import Lexer from '../lexer';
import Parser, { ParserOptions } from '../parser';
import { Token, TokenType, TokenValue } from '../tokens';
import { Bounds, codeLocationToString } from '../types';
import ResolvedFile, { FileResolver } from '../file-resolver';
import { CodeProblem, ParseError } from '../errors';
import { Comment_ } from '../expressions';
import { Chunk } from '../statements';
import { analyze } from '../analysis/binder';
import { Analysis, LuaSymbol, Reference } from '../analysis/model';
import { definitionsAt, referenceAt, referencesOf, warningsOf } from '../analysis/queries';
import { CodeSymbol, outlineFor } from '../symbols';
import { OutlineOptions } from '../outline/model';

export const ALL_OUTLINE_OPTIONS: OutlineOptions = { showParameters: true, showLoopVariables: true, showBlocks: true };

export function getTestFileContents(filename: string): string {
  const filepath = path.join(__dirname, '../../../../testfiles/', filename);
  return fs.readFileSync(filepath).toString();
}

export const TEST_CARTS = [
  'beetrootpaul-dart-07/game.lua', 'beetrootpaul-dart-07/hud.lua', 'beetrootpaul-dart-07/mission_1.lua',
  'beetrootpaul-dart-07/movement_fixed_factory.lua', 'beetrootpaul-dart-07/multicart.lua',
  'beetrootpaul-dart-07/player_bullet.lua', 'beetrootpaul-dart-07/screen_title.lua',
  'code-region.lua', 'code-region.p8', 'low.lua', 'low.p8', 'simple-and-short.lua', 'tabs.p8',
  'tweettweetjam-fly.p8', 'tweettweetjam-hop.p8', 'tweettweetjam-tet.p8',
];

export function getLexedTokens(input: string): Token[] {
  return lexWithErrors(input).tokens;
}

export function lexWithErrors(input: string): { tokens: Token[], errors: ParseError[], comments: Comment_[] } {
  const lexer = new Lexer(readCode(input), new ResolvedFile('main_test_file', 'main_test_file'));

  const tokens: Token[] = [];

  // Every token but the last takes at least one character, so more would mean the lexer stopped moving.
  do {
    lexer.next();
    tokens.push(lexer.token!);
    if (tokens.length > input.length + 1) {
      fail(`the lexer does not reach the end of ${JSON.stringify(input)}`);
    }
  } while (lexer.token!.type !== TokenType.EOF);

  return { tokens, errors: lexer.errors, comments: lexer.comments };
}

export type TestParseOptions = ParserOptions & { filename?: string };

export type ParsedForTest = Chunk & { symbols: CodeSymbol[] };

export function parse(input: string, opts: TestParseOptions = {}): ParsedForTest {
  // If a filename is given, resolve it the same way #include'd files are
  // resolved, so they can be compared
  const file = opts?.filename ? ResolvedFile.fromPath(opts.filename) : testFile();
  const chunk = new Parser(file, input, opts).parseChunk();
  return { ...chunk, symbols: outlineFor(analyze(chunk), file) };
}

export type Analyzed = { chunk: Chunk, analysis: Analysis, texts: Record<string, string> };

export function analyzeCode(code: string, files: Record<string, string> = {}): Analyzed {
  const chunk = new Parser(testFile(), code, { includeFileResolver: new TestFilesResolver(files) }).parseChunk();
  return { chunk, analysis: analyze(chunk), texts: { main_test_file: code, ...files } };
}

export function testFile(filename = 'main_test_file'): ResolvedFile {
  return filename === 'main_test_file' ? new ResolvedFile(filename, filename) : ResolvedFile.fromPath(path.normalize(filename));
}

export function indexAt(a: Analyzed, line: number, column: number, filename = 'main_test_file'): number {
  return a.texts[filename].split('\n').slice(0, line - 1).reduce((index, text) => index + text.length + 1, 0) + column;
}

export function referenceAtPos(a: Analyzed, line: number, column: number, filename?: string): Reference | undefined {
  return referenceAt(a.analysis, testFile(filename), indexAt(a, line, column, filename));
}

export function symbolAt(a: Analyzed, line: number, column: number, filename?: string): LuaSymbol | undefined {
  return referenceAtPos(a, line, column, filename)?.symbol;
}

export function describeSymbol(symbol: LuaSymbol | undefined): string {
  return symbol ? `${symbol.kind} ${symbol.name}` : 'none';
}

export function formatBounds(b: Bounds): string {
  return `${path.basename(b.start.filename.path)} ${b.start.line}:${b.start.column}-${b.end.line}:${b.end.column}`;
}

export function definitionsAtPos(a: Analyzed, line: number, column: number, filename?: string): string[] {
  const reference = referenceAtPos(a, line, column, filename);
  return reference ? definitionsAt(a.analysis, reference).map(formatBounds) : [];
}

export function referencesAtPos(a: Analyzed, line: number, column: number, filename?: string, includeDeclaration = true): string[] {
  const reference = referenceAtPos(a, line, column, filename);
  return reference ? referencesOf(reference.symbol, includeDeclaration).map(formatBounds) : [];
}

export function warningsIn(a: Analyzed): string[] {
  return warningsOf(a.analysis).map(formatError);
}

export function formatError(e: CodeProblem): string {
  return `${codeLocationToString(e.bounds.start)} ${e.message}`;
}

export type ChildParseJob = { code: string, files?: Record<string, string> };

export type ChildParseResult = {
  ms: number,
  threw: string | null,
  errors: string[],
  statements: string[],
  outline: string[],
  invalid: string[],
  queries: number,
  // Hover and signature help calls that returned, whatever they gave: on some files signature help never finds a call.
  hovers: number,
  signatureHelps: number,
  symbols: number,
};

export function parseManyInChild(jobs: ChildParseJob[], timeoutMs: number): ChildParseResult[] {
  // The small heap makes a parse that never ends die of out-of-memory soon,
  // instead of running until the timeout.
  const child = spawnSync(process.execPath, [ '--max-old-space-size=256', path.join(__dirname, 'parse-child.js') ], {
    input: JSON.stringify({ jobs }),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
  });
  if ((child.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
    throw new Error(`parse did not finish within ${timeoutMs} ms`);
  }
  if (child.error) {
    throw child.error;
  }
  if (child.status !== 0) {
    throw new Error(`parse child exited with ${child.status ?? child.signal}\n${child.stderr.trim()}`);
  }
  return JSON.parse(child.stdout) as ChildParseResult[];
}

export function parseInChild(code: string, files?: Record<string, string>, timeoutMs = 10000): ChildParseResult {
  return parseManyInChild([{ code, files }], timeoutMs)[0];
}

export function nestedInFunctionValues(depth: number, innermost: string, atEachLevel = ''): string {
  let code = innermost;
  for (let i = 0; i < depth; i++) {
    code = `v = g(function()\n${atEachLevel}${code}end) +\nw.x = 3\n`;
  }
  return code;
}

export function deepEqualsAST(code: string, expected: any) {
  const { errors, block: { body } } = parse(code);
  deepEquals(errors, []);
  deepEquals(body, expected);
}

export function deepEquals(actual: any, expected: any, options: DeepEqualsOptions = {}) {
  const result = _deepEquals(actual, expected, 'root', options);
  if (!result.matches) {
    fail(
      'Objects are not equal!\n\n' +
      `Mismatch: ${result.location}\n\n` +
      'expected:\n' +
      util.inspect(expected, { depth: 90, colors: true }) +
      '\n\n' +
      'actual:\n' +
      util.inspect(actual, { depth: 90, colors: true }),
    );
  }
}

type DeepEqualsOptions = {
  objectKeyOmitFn?: (key: any) => boolean,
  arrayItemOmitFn?: (item: any) => boolean,
};

type DeepEqualsResult = {
  matches: boolean,
  location?: string,
};

function _deepEquals(actual: any, expected: any, currLocStr: string, options: DeepEqualsOptions): DeepEqualsResult {
  if (typeof actual !== typeof expected) {
    return {
      matches: false,
      location: `${currLocStr}.[typeof(actual:${typeof actual},expected:${typeof expected})]`,
    };
  }

  if (expected === null || expected === undefined) {
    return {
      matches: expected === actual,
      location: `${currLocStr}.[===] (expected: ${expected}, actual: ${actual})`,
    };
  } else if (typeof expected === 'object') {
    if (Array.isArray(expected)) {
      return _deepEqualsArray(actual, expected, currLocStr, options);
    } else {
      return _deepEqualsObject(actual, expected, currLocStr, options);
    }
  } else {
    if (actual !== expected) {
      return {
        matches: false,
        location: `${currLocStr}.[===] (expected: ${expected}, actual: ${actual})`,
      };
    } else {
      return { matches: true };
    }
  }
}

function _deepEqualsArray(actual: any[], expected: any[], currLocStr: string, options: DeepEqualsOptions): DeepEqualsResult {
  const filteredActual = actual.filter(item => !options.arrayItemOmitFn?.(item));
  const filteredExpected = expected.filter(item => !options.arrayItemOmitFn?.(item));
  if (filteredActual.length !== filteredExpected.length) {
    return {
      matches: false,
      location: `${currLocStr}.[length(actual:${filteredActual.length},expected:${filteredExpected.length})]`,
    };
  }

  for (let i = 0; i < filteredExpected.length; i++) {
    const subResult = _deepEquals(filteredActual[i], filteredExpected[i], `${currLocStr}.${i}`, options);
    if (!subResult.matches) {
      return subResult;
    }
  }

  return { matches: true };
}

function _deepEqualsObject(actual: any, expected: any, currLocStr: string, options: DeepEqualsOptions): DeepEqualsResult {
  const keysToCheck = Object.keys(expected).filter(key => !(options.objectKeyOmitFn?.(key)));
  for (const key of keysToCheck) {
    const subResult = _deepEquals(actual && actual[key], expected[key], `${currLocStr}.${key}`, options);
    if (!subResult.matches) {
      return subResult;
    }
  }

  return { matches: true };
}

export function locationOfToken(code: string, tokenValue: TokenValue): Bounds {
  const tokens = getLexedTokens(code);
  for (const token of tokens) {
    if (token.value === tokenValue) {
      return token.bounds;
    }
  }
  throw new Error(`can't find instance of ${tokenValue} in code!`);
}

export function tokenAt(code: string, index: number): Token | undefined {
  const tokens = getLexedTokens(code);
  for (const token of tokens) {
    if (index >= token.bounds.start.index && index <= token.bounds.end.index) {
      return token;
    }
  }
  return undefined;
}

// Not a *real* Bounds object because it's missing index. Useful for making
// something to test against though.
export function bounds(startLine: number, startCol: number, endLine: number, endCol: number) {
  return {
    start: { line: startLine, column: startCol },
    end: { line: endLine, column: endCol },
  };
}

export class MockFileResolver implements FileResolver {
  doesFileExist: (filepath: string) => boolean;
  isFile: (filepath: string) => boolean;
  loadFileContents: (filepath: string) => string;

  constructor() {
    this.doesFileExist = this.defaultDoesFileExist.bind(this);
    this.isFile = this.defaultIsFile.bind(this);
    this.loadFileContents = this.defaultLoadFileContents.bind(this);
  }

  private defaultDoesFileExist(_filepath: string): boolean {
    return true;
  }

  private defaultIsFile(_filepath: string): boolean {
    return true;
  }

  private defaultLoadFileContents(_filepath: string): string {
    return '';
  }
}

type FilesystemMap = { [filename: string]: string };

export class TestFilesResolver implements FileResolver {
  files: FilesystemMap;

  constructor(files: FilesystemMap) {
    this.files = Object.fromEntries(Object.entries(files).map(([ filename, contents ]) => [ path.normalize(filename), contents ]));
  }

  doesFileExist(filepath: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.files, path.normalize(filepath));
  }

  isFile(filepath: string): boolean {
    return this.doesFileExist(filepath);
  }

  loadFileContents(filepath: string): string {
    return this.files[path.normalize(filepath)];
  }
}
