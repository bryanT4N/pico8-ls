/* eslint-disable @typescript-eslint/no-unsafe-call */
import * as assert from 'assert';
import { ParseError } from '../errors';
import ResolvedFile from '../file-resolver';
import Lexer from '../lexer';
import { Token, TokenType, TokenValue } from '../tokens';
import { deepEquals, getLexedTokens, lexWithErrors } from './test-utils';

function formatLexError(e: ParseError): string {
  return `${e.bounds.start.line}:${e.bounds.start.column} ${e.message}`;
}

function assertNextToken(tokens: Token[], type: TokenType, value?: TokenValue) {
  if (tokens.length === 0) {
    assert.fail('no more tokens!');
  }

  const token = tokens[0];
  tokens.shift();

  assert.strictEqual(token.type, type);

  if (value !== undefined) {
    assert.strictEqual(token.value, value);
  }
}

function assertNoMoreTokens(tokens: Token[]) {
  assertNextToken(tokens, TokenType.EOF);

  if (tokens.length !== 0) {
    assert.fail('extra tokens! ' + tokens.map(t => `${t.type}[${t.value}]`).join(', '));
  }

}

// Asserts we get the right tokens from: `print("hi")`
function assertPrintHi(tokens: Token[]) {
  assertNextToken(tokens, TokenType.Identifier, 'print');
  assertNextToken(tokens, TokenType.Punctuator, '(');
  assertNextToken(tokens, TokenType.StringLiteral, 'hi');
  assertNextToken(tokens, TokenType.Punctuator, ')');
}

describe('Lexer', () => {
  describe('all token types', () => {
    it('StringLiteral', () => {
      let tokens = getLexedTokens('"hi"');
      assertNextToken(tokens, TokenType.StringLiteral, 'hi');
      assertNoMoreTokens(tokens);

      tokens = getLexedTokens('\'hi\'');
      assertNextToken(tokens, TokenType.StringLiteral, 'hi');
      assertNoMoreTokens(tokens);
    });

    // TODO
    // it('StringLiteral with escape characters', () => {});

    it('Keyword', () => {
      const tokens = getLexedTokens('function break goto if then while end');
      assertNextToken(tokens, TokenType.Keyword, 'function');
      assertNextToken(tokens, TokenType.Keyword, 'break');
      assertNextToken(tokens, TokenType.Keyword, 'goto');
      assertNextToken(tokens, TokenType.Keyword, 'if');
      assertNextToken(tokens, TokenType.Keyword, 'then');
      assertNextToken(tokens, TokenType.Keyword, 'while');
      assertNextToken(tokens, TokenType.Keyword, 'end');
      assertNoMoreTokens(tokens);
    });

    it('Identifier', () => {
      const tokens = getLexedTokens('func a b this_is_my_var camelCase _startsWithUnderscore containsNumbers1234');
      assertNextToken(tokens, TokenType.Identifier, 'func');
      assertNextToken(tokens, TokenType.Identifier, 'a');
      assertNextToken(tokens, TokenType.Identifier, 'b');
      assertNextToken(tokens, TokenType.Identifier, 'this_is_my_var');
      assertNextToken(tokens, TokenType.Identifier, 'camelCase');
      assertNextToken(tokens, TokenType.Identifier, '_startsWithUnderscore');
      assertNextToken(tokens, TokenType.Identifier, 'containsNumbers1234');
      assertNoMoreTokens(tokens);
    });

    it('NumericLiteral', () => {
      // TODO more types of numeric literals
      const tokens = getLexedTokens('123 45.03 .03 0x34 0x3p1 0x3p-2');
      assertNextToken(tokens, TokenType.NumericLiteral, 123);
      assertNextToken(tokens, TokenType.NumericLiteral, 45.03);
      assertNextToken(tokens, TokenType.NumericLiteral, .03);
      assertNextToken(tokens, TokenType.NumericLiteral, 52);
      assertNextToken(tokens, TokenType.NumericLiteral, 6);
      assertNextToken(tokens, TokenType.NumericLiteral, 0.75);
      assertNoMoreTokens(tokens);
    });

    it('NumericLiteral - hexadecimal', () => {
      const tokens = getLexedTokens('0x34 0x1 0x01 0x0.1 0x00.1 0x0.aa 0x3a.1 0x.1');
      assertNextToken(tokens, TokenType.NumericLiteral, 52);
      assertNextToken(tokens, TokenType.NumericLiteral, 1);
      assertNextToken(tokens, TokenType.NumericLiteral, 1);
      assertNextToken(tokens, TokenType.NumericLiteral, 0.0625);
      assertNextToken(tokens, TokenType.NumericLiteral, 0.0625);
      assertNextToken(tokens, TokenType.NumericLiteral, 0.6640625);
      assertNextToken(tokens, TokenType.NumericLiteral, 58.0625);
      assertNextToken(tokens, TokenType.NumericLiteral, 0.0625);
      assertNoMoreTokens(tokens);
    });

    it('NumericLiteral - malformed hexadecimal fraction', () => {
      const { tokens, errors } = lexWithErrors('0x.');
      assertNextToken(tokens, TokenType.NumericLiteral);
      assertNoMoreTokens(tokens);
      assert.deepStrictEqual(errors.map(formatLexError), [ '1:0 malformed number near \'0x.\'' ]);
    });

    it('NumericLiteral - hexadecimal with exponents', () => {
      const tokens = getLexedTokens('0x3p1 0x3p-2');
      assertNextToken(tokens, TokenType.NumericLiteral, 6);
      assertNextToken(tokens, TokenType.NumericLiteral, 0.75);
      assertNoMoreTokens(tokens);
    });

    describe('Punctuators', () => {
      function assertLexesOperators(...ops: string[]) {
        const tokens = getLexedTokens(ops.join(' '));
        for (const op of ops) {
          assertNextToken(tokens, TokenType.Punctuator, op);
        }

        assertNoMoreTokens(tokens);
      }

      it('lexes arithmetic operators', () => {
        assertLexesOperators('-', '+', '/', '\\', '%', '^');
      });

      it('lexes bitwise operators', () => {
        assertLexesOperators('~', '|', '&', '^^', '<<', '>>', '>>>', '<<>', '>><');
      });

      it('lexes memory operators', () => {
        assertLexesOperators('@', '%', '$');
      });

      it('lexes comparison operators', () => {
        assertLexesOperators('<', '>', '<=', '>=', '==', '~=', '!=');
      });

      it('lexes assignment operators', () => {
        assertLexesOperators('=', '+=', '-=', '*=', '/=', '\\=', '%=', '^=', '..=', '|=', '&=', '^^=', '<<=', '>>=', '>>>=', '<<>=', '>><=');
      });

      it('lexes misc punctuators', () => {
        assertLexesOperators('.', '..', ':', '[', ']', '(', ')', '#', ',', ';', '{', '}', '?');
      });
    });

    it('BooleanLiteral', () => {
      const tokens = getLexedTokens('true false truee falsee _true _false');
      assertNextToken(tokens, TokenType.BooleanLiteral, true);
      assertNextToken(tokens, TokenType.BooleanLiteral, false);
      for (let i = 0; i < 4; i++) {
        assertNextToken(tokens, TokenType.Identifier);
      }
      assertNoMoreTokens(tokens);
    });

    it('NilLiteral', () => {
      const tokens = getLexedTokens('nil nile');
      assertNextToken(tokens, TokenType.NilLiteral, null);
      assertNextToken(tokens, TokenType.Identifier);
      assertNoMoreTokens(tokens);
    });

    it('VarargLiteral', () => {
      const tokens = getLexedTokens('...');
      assertNextToken(tokens, TokenType.VarargLiteral, '...');
      assertNoMoreTokens(tokens);
    });
  });

  describe('lexes basic lua', () => {
    it('Assignment Statement', () => {
      const tokens = getLexedTokens('i = 1');
      assertNextToken(tokens, TokenType.Identifier, 'i');
      assertNextToken(tokens, TokenType.Punctuator, '=');
      assertNextToken(tokens, TokenType.NumericLiteral, 1);
      assertNoMoreTokens(tokens);
    });

    it('Break Statement', () => {
      const tokens = getLexedTokens('break');
      assertNextToken(tokens, TokenType.Keyword, 'break');
      assertNoMoreTokens(tokens);
    });

    it('Call Statement', () => {
      const tokens = getLexedTokens('somefunc(param1, param2)');
      assertNextToken(tokens, TokenType.Identifier, 'somefunc');
      assertNextToken(tokens, TokenType.Punctuator, '(');
      assertNextToken(tokens, TokenType.Identifier, 'param1');
      assertNextToken(tokens, TokenType.Punctuator, ',');
      assertNextToken(tokens, TokenType.Identifier, 'param2');
      assertNextToken(tokens, TokenType.Punctuator, ')');
      assertNoMoreTokens(tokens);
    });

    it('Do Statement', () => {
      const tokens = getLexedTokens('do print("hi") end');
      assertNextToken(tokens, TokenType.Keyword, 'do');
      assertPrintHi(tokens);
      assertNextToken(tokens, TokenType.Keyword, 'end');
      assertNoMoreTokens(tokens);
    });

    it('ForGeneric Statement', () => {
      const tokens = getLexedTokens('for k, v in pairs(tbl) print("hi") end');
      assertNextToken(tokens, TokenType.Keyword, 'for');
      assertNextToken(tokens, TokenType.Identifier, 'k');
      assertNextToken(tokens, TokenType.Punctuator, ',');
      assertNextToken(tokens, TokenType.Identifier, 'v');
      assertNextToken(tokens, TokenType.Keyword, 'in');
      assertNextToken(tokens, TokenType.Identifier, 'pairs');
      assertNextToken(tokens, TokenType.Punctuator, '(');
      assertNextToken(tokens, TokenType.Identifier, 'tbl');
      assertNextToken(tokens, TokenType.Punctuator, ')');
      assertPrintHi(tokens);
      assertNextToken(tokens, TokenType.Keyword, 'end');
      assertNoMoreTokens(tokens);
    });

    it('ForNumeric Statement', () => {
      const tokens = getLexedTokens('for i=1,10,2 print("hi") end');
      assertNextToken(tokens, TokenType.Keyword, 'for');
      assertNextToken(tokens, TokenType.Identifier, 'i');
      assertNextToken(tokens, TokenType.Punctuator, '=');
      assertNextToken(tokens, TokenType.NumericLiteral, 1);
      assertNextToken(tokens, TokenType.Punctuator, ',');
      assertNextToken(tokens, TokenType.NumericLiteral, 10);
      assertNextToken(tokens, TokenType.Punctuator, ',');
      assertNextToken(tokens, TokenType.NumericLiteral, 2);
      assertPrintHi(tokens);
      assertNextToken(tokens, TokenType.Keyword, 'end');
      assertNoMoreTokens(tokens);
    });

    it('Goto Statement', () => {
      const tokens = getLexedTokens('goto lbl');
      assertNextToken(tokens, TokenType.Keyword, 'goto');
      assertNextToken(tokens, TokenType.Identifier, 'lbl');
      assertNoMoreTokens(tokens);
    });

    it('If Statement', () => {
      const tokens = getLexedTokens('if false then print("hi") elseif false then print("hi") else print("hi")');
      assertNextToken(tokens, TokenType.Keyword, 'if');
      assertNextToken(tokens, TokenType.BooleanLiteral, false);
      assertNextToken(tokens, TokenType.Keyword, 'then');
      assertPrintHi(tokens);
      assertNextToken(tokens, TokenType.Keyword, 'elseif');
      assertNextToken(tokens, TokenType.BooleanLiteral, false);
      assertNextToken(tokens, TokenType.Keyword, 'then');
      assertPrintHi(tokens);
      assertNextToken(tokens, TokenType.Keyword, 'else');
      assertPrintHi(tokens);
      assertNoMoreTokens(tokens);
    });

    it('Label Statement', () => {
      const tokens = getLexedTokens('::lbl::');
      assertNextToken(tokens, TokenType.Punctuator, '::');
      assertNextToken(tokens, TokenType.Identifier, 'lbl');
      assertNextToken(tokens, TokenType.Punctuator, '::');
      assertNoMoreTokens(tokens);
    });

    it('Local Statement', () => {
      const tokens = getLexedTokens('local a = 1');
      assertNextToken(tokens, TokenType.Keyword, 'local');
      assertNextToken(tokens, TokenType.Identifier, 'a');
      assertNextToken(tokens, TokenType.Punctuator, '=');
      assertNextToken(tokens, TokenType.NumericLiteral, 1);
      assertNoMoreTokens(tokens);
    });

    it('Vararg Literal', () => {
      const tokens = getLexedTokens('function(...)');
      assertNextToken(tokens, TokenType.Keyword, 'function');
      assertNextToken(tokens, TokenType.Punctuator, '(');
      assertNextToken(tokens, TokenType.VarargLiteral, '...');
      assertNextToken(tokens, TokenType.Punctuator, ')');
      assertNoMoreTokens(tokens);
    });
  });

  it('skips header and footer sections', () => {
    const code = `pico-8 cartridge // http://www.pico-8.com
version 29
__lua__

__gfx__
0000000000001156eed0ed0eeeeeee`;
    const tokens = getLexedTokens(code);
    assertNoMoreTokens(tokens);
  });

  it('skips __sfx__ section', () => {
    const code = `pico-8 cartridge // http://www.pico-8.com
version 42
__lua__

__sfx__
013c01001815000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
`;
    const tokens = getLexedTokens(code);
    assertNoMoreTokens(tokens);
  });

  it('skips __music__ section', () => {
    const code = `pico-8 cartridge // http://www.pico-8.com
version 42
__lua__

__music__
00 01424344
`;
    const tokens = getLexedTokens(code);
    assertNoMoreTokens(tokens);
  });

  describe('error handling', () => {
    it('returns an error for an unterminated string literal', () => {
      const { tokens, errors } = lexWithErrors('"asdf');
      assertNextToken(tokens, TokenType.StringLiteral, 'asdf');
      assertNoMoreTokens(tokens);
      assert.deepStrictEqual(errors.map(formatLexError), [ '1:0 unfinished string near \'"asdf\'' ]);
    });

    it('ends an unterminated string literal at the end of its line', () => {
      const { tokens, errors } = lexWithErrors('"asdf\nx');
      assert.strictEqual(tokens[1].bounds.start.line, 2);
      assertNextToken(tokens, TokenType.StringLiteral, 'asdf');
      assertNextToken(tokens, TokenType.Identifier, 'x');
      assertNoMoreTokens(tokens);
      assert.deepStrictEqual(errors.map(formatLexError), [ '1:0 unfinished string near \'"asdf\'' ]);
    });

    it('ends an unterminated string literal at the end of its CRLF line', () => {
      const { tokens, errors } = lexWithErrors('"asdf\r\nx');
      assert.strictEqual(tokens[1].bounds.start.line, 2);
      assertNextToken(tokens, TokenType.StringLiteral, 'asdf');
      assertNextToken(tokens, TokenType.Identifier, 'x');
      assertNoMoreTokens(tokens);
      assert.deepStrictEqual(errors.map(formatLexError), [ '1:0 unfinished string near \'"asdf\'' ]);
    });

    it('doesn\'t return an error the second time next() is called', () => {
      const lexer = new Lexer('"asdf', new ResolvedFile('main_test_file', 'main_test_file'));

      lexer.next();
      assert.strictEqual(lexer.token!.type, TokenType.StringLiteral);
      assert.strictEqual(lexer.errors.length, 1);
      lexer.next();
      assert.strictEqual(lexer.token!.type, TokenType.EOF);
      assert.strictEqual(lexer.errors.length, 1);
    });

    it('errors on unterminated long string literal', () => {
      const { tokens, errors } = lexWithErrors('[[asdf');
      assertNextToken(tokens, TokenType.StringLiteral, 'asdf');
      assertNoMoreTokens(tokens);
      assert.deepStrictEqual(errors.map(formatLexError), [ '1:0 unfinished long string (starting at line 1) near \'<eof>\'' ]);
    });

    it('ends an unterminated long string literal at the end of a file that ends in a line break', () => {
      const { tokens } = lexWithErrors('[[asdf\n');
      deepEquals(tokens.map(t => t.bounds.end), [{ index: 7, line: 2, column: 0 }, { index: 7, line: 2, column: 0 }]);
    });

    it('errors on malformed hex number literal', () => {
      const { tokens, errors } = lexWithErrors('0xZ');
      assertNextToken(tokens, TokenType.NumericLiteral);
      assertNextToken(tokens, TokenType.Identifier, 'Z');
      assertNoMoreTokens(tokens);
      assert.deepStrictEqual(errors.map(formatLexError), [ '1:0 malformed number near \'0x\'' ]);
    });

    it('errors on hex number literal with malformed binary exponent', () => {
      const { tokens, errors } = lexWithErrors('0x3pQ');
      assertNextToken(tokens, TokenType.NumericLiteral);
      assertNextToken(tokens, TokenType.Identifier, 'Q');
      assertNoMoreTokens(tokens);
      assert.deepStrictEqual(errors.map(formatLexError), [ '1:0 malformed number near \'0x3p\'' ]);
    });

    it('skips a lone !', () => {
      const { tokens, errors } = lexWithErrors('a ! b');
      assertNextToken(tokens, TokenType.Identifier, 'a');
      assertNextToken(tokens, TokenType.Identifier, 'b');
      assertNoMoreTokens(tokens);
      assert.deepStrictEqual(errors.map(formatLexError), [ '1:2 unexpected symbol \'!\'' ]);
    });

    it('skips a lone ! at the end of a line without taking the line break', () => {
      const { tokens, errors } = lexWithErrors('a !\nb');
      assert.strictEqual(tokens[1].bounds.start.line, 2);
      assertNextToken(tokens, TokenType.Identifier, 'a');
      assertNextToken(tokens, TokenType.Identifier, 'b');
      assertNoMoreTokens(tokens);
      assert.deepStrictEqual(errors.map(formatLexError), [ '1:2 unexpected symbol \'!\'' ]);
    });

    it('still lexes != between names', () => {
      const { tokens, errors } = lexWithErrors('a != b');
      assertNextToken(tokens, TokenType.Identifier, 'a');
      assertNextToken(tokens, TokenType.Punctuator, '!=');
      assertNextToken(tokens, TokenType.Identifier, 'b');
      assertNoMoreTokens(tokens);
      assert.deepStrictEqual(errors.map(formatLexError), []);
    });

    it('skips an unknown character', () => {
      const { tokens, errors } = lexWithErrors('a ` b');
      assertNextToken(tokens, TokenType.Identifier, 'a');
      assertNextToken(tokens, TokenType.Identifier, 'b');
      assertNoMoreTokens(tokens);
      assert.deepStrictEqual(errors.map(formatLexError), [ '1:2 unexpected symbol \'`\'' ]);
    });

    it('keeps the character after an invalid escape sequence', () => {
      const { tokens, errors } = lexWithErrors('"a\\qb"');
      assertNextToken(tokens, TokenType.StringLiteral, 'aqb');
      assertNoMoreTokens(tokens);
      assert.deepStrictEqual(errors.map(formatLexError), [ '1:0 invalid escape sequence near \'\\q\'' ]);
    });

    it('keeps the characters after a \\x without two hexadecimal digits', () => {
      const { tokens, errors } = lexWithErrors('"\\xZZ"');
      assertNextToken(tokens, TokenType.StringLiteral, 'xZZ');
      assertNoMoreTokens(tokens);
      assert.deepStrictEqual(errors.map(formatLexError), [ '1:0 hexadecimal digit expected near \'\\xZ\'' ]);
    });

    it('ends a string at a backslash at the end of the file', () => {
      const { tokens, errors } = lexWithErrors('"a\\');
      assert.deepStrictEqual(tokens.map(t => t.bounds.end.index), [ 3, 3 ]);
      assertNextToken(tokens, TokenType.StringLiteral, 'a');
      assertNoMoreTokens(tokens);
      assert.deepStrictEqual(errors.map(formatLexError), [
        '1:0 invalid escape sequence near \'\\\'',
        '1:0 unfinished string near \'"a\\\'',
      ]);
    });

    it('runs an unterminated long comment to the end of the file', () => {
      const { tokens, errors, comments } = lexWithErrors('a = 1\n--[[ open\nb = 2');
      assertNextToken(tokens, TokenType.Identifier, 'a');
      assertNextToken(tokens, TokenType.Punctuator, '=');
      assertNextToken(tokens, TokenType.NumericLiteral, 1);
      assertNoMoreTokens(tokens);
      assert.deepStrictEqual(comments.map(c => [ c.loc!.start.line, c.loc!.end.line ]), [[ 2, 3 ]]);
      assert.deepStrictEqual(errors.map(formatLexError), [ '2:0 unfinished long comment (starting at line 2) near \'<eof>\'' ]);
    });

    it('lexes [= without a second [ as punctuators', () => {
      const { tokens, errors } = lexWithErrors('t[=x');
      assertNextToken(tokens, TokenType.Identifier, 't');
      assertNextToken(tokens, TokenType.Punctuator, '[');
      assertNextToken(tokens, TokenType.Punctuator, '=');
      assertNextToken(tokens, TokenType.Identifier, 'x');
      assertNoMoreTokens(tokens);
      assert.deepStrictEqual(errors.map(formatLexError), []);
    });
  });

  describe('locations', () => {
    it('gives correct location for tokens in a line', () => {
      const tokens = getLexedTokens('function somefn() end');
      deepEquals(tokens, [
        { value: 'function', bounds: {
          start: { line: 1, column: 0, index: 0 },
          end: { line: 1, column: 8, index: 8 },
        } },
        { value: 'somefn', bounds: {
          start: { line: 1, column: 9, index: 9 },
          end: { line: 1, column: 15, index: 15 },
        } },
        { value: '(', bounds: {
          start: { line: 1, column: 15, index: 15 },
          end: { line: 1, column: 16, index: 16 },
        } },
        { value: ')', bounds: {
          start: { line: 1, column: 16, index: 16 },
          end: { line: 1, column: 17, index: 17 },
        } },
        { value: 'end', bounds: {
          start: { line: 1, column: 18, index: 18 },
          end: { line: 1, column: 21, index: 21 },
        } },
        { value: '<eof>' },
      ]);
    });

    it('gives correct location for tokens on multiple lines', () => {
      const tokens = getLexedTokens('local\nbreak\nend');
      deepEquals(tokens, [
        { value: 'local', bounds: {
          start: { line: 1, column: 0, index: 0 },
          end: { line: 1, column: 5, index: 5 },
        } },
        { value: 'break', bounds: {
          start: { line: 2, column: 0, index: 6 },
          end: { line: 2, column: 5, index: 11 },
        } },
        { value: 'end', bounds: {
          start: { line: 3, column: 0, index: 12 },
          end: { line: 3, column: 3, index: 15 },
        } },
        { value: '<eof>' },
      ]);
    });

    it('gives correct start/end for multiline token', () => {
      const tokens = getLexedTokens('i = [[\nalskjdflkajsdf\n234]]');
      deepEquals(tokens, [
        { value: 'i', bounds: {
          start: { line: 1, column: 0, index: 0 },
          end: { line: 1, column: 1, index: 1 },
        } },
        { value: '=', bounds: {
          start: { line: 1, column: 2, index: 2 },
          end: { line: 1, column: 3, index: 3 },
        } },
        { value: 'alskjdflkajsdf\n234', bounds: {
          start: { line: 1, column: 4, index: 4 },
          end: { line: 3, column: 5, index: 27 },
        } },
        { value: '<eof>' },
      ]);
    });
  });
});
