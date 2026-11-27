import * as assert from 'assert';
import { ParseError } from '../errors';
import { Code, textCode } from '../code';
import ResolvedFile from '../file-resolver';
import Lexer from '../lexer';
import Parser from '../parser';
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

    it('StringLiteral - an escape gives the text of the byte PICO-8 holds for it, the text PICO-8 reads as that byte', () => {
      const values = (code: string) => getLexedTokens(code).filter(t => t.type === TokenType.StringLiteral).map(t => t.value);
      assert.deepStrictEqual(values('"\\65" "\\065" "\\0065" "\\1234" "a\\0b" "\\9" "\\x41" "\\xAb" "\\xff"'),
        [ 'A', 'A', '\u20765', '{4', 'a\0b', '\t', 'A', '\u3064', '\u25dd' ]);
      assert.deepStrictEqual(values('"\\a\\b\\t\\n\\v\\f\\r" "\\*\\#\\-\\|\\+\\^" "\\\\\\"\\\'"'),
        [ '\u2077\u2078\t\n\u1d47\u1d9c\r', '\u00b9\u00b2\u00b3\u2074\u2075\u2076', '\\"\'' ]);
      // PICO-8 reads each of these glyphs as the byte the escape gives.
      assert.deepStrictEqual(values('"\\1" "\\16" "\\127" "\\128" "\\x82" "\\139"'), values('"\u00b9" "\u25ae" "\u25cb" "\u2588" "\u{1f431}" "\u2b05\ufe0f"'));
    });

    it('StringLiteral - the line breaks after a \\z or a \\ and in a long string, as PICO-8 holds them', () => {
      const values = (code: string) => getLexedTokens(code).filter(t => t.type === TokenType.StringLiteral).map(t => t.value);
      assert.deepStrictEqual(values('"a\\z \t\n  \r\n b" "a\\\nb" "a\\\r\nb"'), [ 'ab', 'a\nb', 'a\nb' ]);
      assert.deepStrictEqual(values('[[\na]] [[\r\na]] [[a\r\nb\nc]] [==[a]]b]==] [[a\\65]]'), [ 'a', 'a', 'a\nb\nc', 'a]]b', 'a\\65' ]);
    });

    it('StringLiteral - the code as the bytes PICO-8 holds for it, a glyph as its byte and any other character as its UTF-8 bytes', () => {
      const values = (code: string) => getLexedTokens(code).filter(t => t.type === TokenType.StringLiteral).map(t => t.value);
      // é is the bytes 195 169, and ⬅ without its ️ the bytes 226 172 133.
      assert.deepStrictEqual(values('"é" "\\195\\169" [[é]] "⬅" "⬅️" "¹\x01" "a\tb"'),
        [ 'れた', 'れた', 'れた', 'ヌて✽', '⬅️', '¹¹', 'a\tb' ]);
    });

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
      const tokens = getLexedTokens('123 45.03 .03 0x34');
      assertNextToken(tokens, TokenType.NumericLiteral, 123);
      assertNextToken(tokens, TokenType.NumericLiteral, 45.03);
      assertNextToken(tokens, TokenType.NumericLiteral, .03);
      assertNextToken(tokens, TokenType.NumericLiteral, 52);
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

    it('NumericLiteral - binary, with the value PICO-8 gives it', () => {
      const tokens = getLexedTokens('0b101 0B1.11 0b1.1 0b.01 0b11. 0b0001 0b0.0000000000000001');
      assertNextToken(tokens, TokenType.NumericLiteral, 5);
      assertNextToken(tokens, TokenType.NumericLiteral, 1.75);
      assertNextToken(tokens, TokenType.NumericLiteral, 1.5);
      assertNextToken(tokens, TokenType.NumericLiteral, 0.25);
      assertNextToken(tokens, TokenType.NumericLiteral, 3);
      assertNextToken(tokens, TokenType.NumericLiteral, 1);
      assertNextToken(tokens, TokenType.NumericLiteral, 1 / 65536);
      assertNoMoreTokens(tokens);
    });

    it('NumericLiteral - malformed hexadecimal fraction', () => {
      const { tokens, errors } = lexWithErrors('0x.');
      assertNextToken(tokens, TokenType.NumericLiteral);
      assertNoMoreTokens(tokens);
      assert.deepStrictEqual(errors.map(formatLexError), [ '1:0 malformed number near \'0x.\'' ]);
    });

    it('NumericLiteral - a hexadecimal number takes no p exponent, as in PICO-8', () => {
      const { tokens, errors } = lexWithErrors('0x3p1 0x3pQ');
      assertNextToken(tokens, TokenType.NumericLiteral, 3);
      assertNextToken(tokens, TokenType.Identifier, 'p1');
      assertNextToken(tokens, TokenType.NumericLiteral, 3);
      assertNextToken(tokens, TokenType.Identifier, 'pQ');
      assertNoMoreTokens(tokens);
      assert.deepStrictEqual(errors, []);
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

  it('reads a text given to it as code of its own, by none of the rules of a file, as a parser does code given to it', () => {
    const text = 'x = "pico-8 cartridge"';
    const file = new ResolvedFile('comment', 'comment');
    const lexer = new Lexer(text, file);
    lexer.next();
    assert.deepStrictEqual([ lexer.token!.type, lexer.token!.value ], [ TokenType.Identifier, 'x' ]);
    // The text of a file is read as PICO-8 reads it, here a cart with no code.
    const statements = (input: string | Code) => {
      const chunk = new Parser(file, input).parseChunk();
      return [ chunk.errors.length, chunk.block.body.length ];
    };
    assert.deepStrictEqual([ statements(text), statements(textCode(text)) ], [[ 0, 0 ], [ 0, 1 ]]);
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

    it('errors on a number with a second dot, as PICO-8 reads its digits and dots together', () => {
      const { tokens, errors } = lexWithErrors('1..2 1.5.2 0x1.8.1 0b1.1.1 1..y');
      for (let i = 0; i < 5; i++) {
        assertNextToken(tokens, TokenType.NumericLiteral);
      }
      assertNextToken(tokens, TokenType.Identifier, 'y');
      assertNoMoreTokens(tokens);
      assert.deepStrictEqual(errors.map(formatLexError), [
        '1:0 malformed number near \'1..2\'',
        '1:5 malformed number near \'1.5.2\'',
        '1:11 malformed number near \'0x1.8.1\'',
        '1:19 malformed number near \'0b1.1.1\'',
        '1:27 malformed number near \'1..\'',
      ]);
      assert.deepStrictEqual(lexWithErrors('0x..1 0b..1').errors.map(formatLexError), [
        '1:0 malformed number near \'0x..1\'',
        '1:6 malformed number near \'0b..1\'',
      ]);
    });

    it('errors on 0b with no binary digit after it', () => {
      const { tokens, errors } = lexWithErrors('0b2');
      assertNextToken(tokens, TokenType.NumericLiteral);
      assertNextToken(tokens, TokenType.NumericLiteral, 2);
      assertNoMoreTokens(tokens);
      assert.deepStrictEqual(errors.map(formatLexError), [ '1:0 malformed number near \'0b\'' ]);
      assert.deepStrictEqual(lexWithErrors('0b. 0b.1 0b1.').errors.map(formatLexError), [ '1:0 malformed number near \'0b.\'' ]);
    });

    it('errors on a number that starts with .0x or .0b, as PICO-8 reads its hexadecimal or binary digits and dots', () => {
      const { tokens, errors } = lexWithErrors('.0x1.8 .0x1g .0b12 .0B .0X1p4 .0b1..1 .00x1 .1x1 10x1');
      for (const type of [ 'N', 'N', 'I', 'N', 'N', 'N', 'N', 'I', 'N', 'N', 'I', 'N', 'I', 'N', 'I' ]) {
        assertNextToken(tokens, type === 'N' ? TokenType.NumericLiteral : TokenType.Identifier);
      }
      assertNoMoreTokens(tokens);
      assert.deepStrictEqual(errors.map(formatLexError), [
        '1:0 malformed number near \'.0x1.8\'',
        '1:7 malformed number near \'.0x1\'',
        '1:13 malformed number near \'.0b1\'',
        '1:19 malformed number near \'.0B\'',
        '1:23 malformed number near \'.0X1\'',
        '1:30 malformed number near \'.0b1..1\'',
      ]);
    });

    it('errors on a decimal escape over 255', () => {
      const { tokens, errors } = lexWithErrors('"\\256" "\\255" "\\2555"');
      assertNextToken(tokens, TokenType.StringLiteral);
      assertNextToken(tokens, TokenType.StringLiteral);
      assertNextToken(tokens, TokenType.StringLiteral);
      assertNoMoreTokens(tokens);
      assert.deepStrictEqual(errors.map(formatLexError), [ '1:0 decimal escape too large near \'\\256\'' ]);
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

    it('ends a string unfinished at a backslash at the end of the code, which takes the line break PICO-8 reads after it', () => {
      const { tokens, errors } = lexWithErrors('"a\\');
      assert.deepStrictEqual(tokens.map(t => t.bounds.end.index), [ 3, 3 ]);
      assertNextToken(tokens, TokenType.StringLiteral, 'a\n');
      assertNoMoreTokens(tokens);
      assert.deepStrictEqual(errors.map(formatLexError), [ '1:0 unfinished string near \'"a\n\'' ]);
      const header = 'pico-8 cartridge // http://www.pico-8.com\nversion 42\n__lua__\n';
      for (const cart of [ 'x="a\\\n__gfx__\n0000\n', 'x=1\n-->8\nx="a\\\n__gfx__\n', 'x="a\\' ]) {
        assert.deepStrictEqual(lexWithErrors(header + cart).errors.map(e => e.message), [ 'unfinished string near \'"a\n\'' ], cart);
      }
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

    it('records the text before a comment on its line', () => {
      assert.deepStrictEqual(lexWithErrors('x = 1 -- c\n  -- d').comments.map(c => c.lineBefore), [ 'x = 1 ', '  ' ]);
    });

    it('records whether only blanks and comments that end the line follow a comment on its last line', () => {
      assert.deepStrictEqual(lexWithErrors('--[[ a ]] x = 1\n--[[ b\n]]\n-- c').comments.map(c => c.endsLine), [ false, true, true ]);
      assert.deepStrictEqual(lexWithErrors('-- c\r\nx = 1').comments.map(c => c.endsLine), [ true ]);
      assert.deepStrictEqual(lexWithErrors('--[[ a ]]--\n--[[ b ]] --[[ c ]] x = 1\n--[[ d ]] // e').comments.map(c => c.endsLine),
        [ true, true, false, false, true, true ]);
      assert.deepStrictEqual(lexWithErrors('--[[ a ]]--\r\nx = 1').comments.map(c => c.endsLine), [ true, true ]);
    });
  });
});
