import AST from './ast';
import { Code, Run, textCode } from './code';
import { EncodingMode, encodingModes, EncodingModeType } from './encoding-modes';
import * as errors from './errors';
import { errMessages } from './errors';
import { Comment_ } from './expressions';
import ResolvedFile from './file-resolver';
import { Token, tokenText, TokenType, TokenValue } from './tokens';
import { Bounds, CodeLocation } from './types';

// Lexer
// -----
//
// The lexer, or the tokenizer reads the input string character by character
// and derives a token left-right. To be as efficient as possible the lexer
// prioritizes the common cases such as identifiers. It also works with
// character codes instead of characters as string comparisons was the
// biggest bottleneck of the parser.
//
// `lex()` starts lexing and returns the following token in the stream.
export type OpenBracket = { unfinished: errors.ParseError, include?: number } & ({ level: number, isComment: boolean } | { quote: number });

export default class Lexer {
  charCode: number = 0;
  peekCharCodeindex: number = 0;

  // where we currently are
  index: number = 0;
  line: number = 1;
  // Index where the current line started
  lineStart: number = 0;

  // Keep track of where the current token started
  tokenStart: number = 0; // index
  tokenStartLine: number = 0; // line
  // index of the current token start of line (for multi-line tokens like string
  // literal)
  tokenStartLineIdx: number = 0;

  comments: Comment_[] = [];
  // The comments of a run on one line, such as --[[ a ]]--, each followed by blanks and the next: they end the line
  // when the last of the run does. lex() scans a whole run in one call.
  private commentsBeforeComment: Comment_[] = [];
  errors: errors.ParseError[] = [];
  lookahead: Token | undefined;
  previousToken: Token | undefined;
  token: Token | undefined;

  // The code being read, and the text of the file it is read from (Code).
  input: string = '';
  length: number = 0;
  readonly text: string;
  // Where a place in the code is in the text: by an offset, when the code is one run of the text from the start of a
  // line, else by the runs.
  private shift = { index: 0, line: 0 };
  private runs?: Run[];
  private lineStarts?: number[];
  private readonly end?: Code['end'];
  encodingMode: EncodingMode = encodingModes[EncodingModeType.XUserDefined];

  // Special flag that indicates we shouldn't skip over a newline, instead
  // treating it as a special newline token. This is useful for the special
  // PICO-8 one-line if statement.
  newlineSignificant: boolean = false;

  // Set for a file that the parser pastes in, where a long string or comment, or a short string in the blanks after a
  // \z, can go on past the end of the text (openBracket).
  pasted = false;
  // Set for the main file: where the # of each #include line that PICO-8 reads is. A long string or comment, or a short
  // string in the blanks after a \z, stops at one, for the parser to paste the file in and go on in it (openBracket).
  includeLines?: Set<number>;
  // A long string or comment, or a short string in the blanks after a \z, that goes on past the end of a pasted file,
  // or past an #include line of the main file that PICO-8 reads, whose # is at include: its level or quote, and the
  // error to give when nothing closes it.
  openBracket?: OpenBracket;

  filename: ResolvedFile;

  // The code PICO-8 reads from a file (readCode), or a text read as code of its own.
  constructor(input: string | Code, filename: ResolvedFile) {
    const code = typeof input === 'string' ? textCode(input) : input;
    this.text = code.text;
    this.input = code.code;
    this.length = this.input.length;
    this.filename = filename;
    this.end = code.end;
    const from = code.runs[0].from;
    if (code.runs.length > 1) {
      this.runs = code.runs;
    } else if (from > 0) {
      const { breaks, lineStart } = lineBreaks(this.text, 0, from);
      if (lineStart === from) {
        this.shift = { index: from, line: breaks };
      } else {
        this.runs = code.runs;
      }
    }
  }

  // Where the code at index is in the text; at its end, or as the end of a range, it is where the character before it
  // ends, as the code can go on elsewhere in the text after a run.
  private placeOf(index: number, end: boolean): CodeLocation {
    const runs = this.runs!;
    const after = index > 0 && (end || index >= this.length);
    const at = after ? index - 1 : index;
    let low = 0;
    let high = runs.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (runs[middle].at <= at) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return this.textPlace(runs[low].from + at - runs[low].at + (after ? 1 : 0));
  }

  locationAt(index: number, end: boolean): CodeLocation {
    return this.runs ? this.placeOf(index, end) : this.textPlace(index + this.shift.index);
  }

  private textPlace(index: number): CodeLocation {
    const starts = this.lineStarts ??= lineStartsOf(this.text);
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= index) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return { index, line: low + 1, column: index - starts[low], filename: this.filename };
  }

  withSignificantNewline(func: () => void) {
    // If we're nested inside another one-line statement (e.g. `if (a) if (b) c()`),
    // the newline also ends the outer statement, so leave it for that one.
    const nested = this.newlineSignificant;

    this.newlineSignificant = true;
    try {
      func();
    } finally {
      // This goes in 'finally' so it doesn't corrupt the state if there's
      // an error during parsing

      if (nested) {
        this.newlineSignificant = true;
      } else {
        // Consume the significant newline
        if (this.token!.type === TokenType.Newline) {
          this.next();
        }

        this.newlineSignificant = false;
      }
    }
  }

  addError(fmtMessage: string, ...rest: any[]) {
    this.errors.push(errors.createErr(this.getCurrentBounds(), fmtMessage, ...rest));
  }

  getLocation(): CodeLocation {
    if (this.runs) {
      const place = this.placeOf(this.index, false);
      return { ...place, column: place.column + 1 };
    }
    return {
      index: this.index + this.shift.index,
      line: this.line + this.shift.line,
      column: this.index - this.lineStart + 1,
      filename: this.filename,
    };
  }

  getCurrentBounds(): Bounds {
    if (this.runs) {
      return { start: this.placeOf(this.tokenStart, false), end: this.placeOf(this.index, true) };
    }
    return {
      start: {
        index: this.tokenStart + this.shift.index,
        line: this.tokenStartLine + this.shift.line,
        column: this.tokenStart - this.tokenStartLineIdx,
        filename: this.filename,
      },
      end: {
        index: this.index + this.shift.index,
        line: this.line + this.shift.line,
        column: this.index - this.lineStart,
        filename: this.filename,
      },
    };
  }

  // A cart's code that stops at another section ends at the start of that section's line, as the token there.
  private endOfCode(): Token {
    const token = this.makeToken(TokenType.EOF, '<eof>');
    if (this.end) {
      let start: CodeLocation;
      if (this.runs) {
        start = this.textPlace(this.end.index);
      } else {
        // The section's line comes after the line break that ends the last line of the code, which a lone CR can end
        // with the character after it.
        const { breaks, lineStart } = lineBreaks(this.text, this.length + this.shift.index, this.end.index);
        start = {
          index: this.end.index, line: this.line + this.shift.line + breaks,
          column: this.end.index - (breaks > 0 ? lineStart : this.lineStart + this.shift.index), filename: this.filename,
        };
      }
      token.bounds = { start, end: { ...start, index: start.index + this.end.length, column: start.column + this.end.length } };
    }
    return token;
  }

  makeToken(type: TokenType, value: TokenValue): Token {
    const token: Token = {
      type: type,
      value: value,
      bounds: this.getCurrentBounds(),
    };
    if (this.runs) {
      token.line = this.tokenStartLine;
    }
    return token;
  }

  lex(): Token {
    for (;;) {
      this.skipWhiteSpace();

      while (this.isCommentStart(this.index)) {
        const canBeLongComment = 45 === this.input.charCodeAt(this.index);
        this.scanComment(canBeLongComment);
        this.skipWhiteSpace();
      }

      if (this.index >= this.length) {
        return this.endOfCode();
      }

      const charCode = this.input.charCodeAt(this.index);
      const next = this.input.charCodeAt(this.index + 1);

      // Memorize the range index where the token begins.
      this.tokenStart = this.index;
      this.tokenStartLine = this.line;
      this.tokenStartLineIdx = this.lineStart;
      if (isIdentifierStart(charCode)) {
        return this.scanIdentifierOrKeyword();
      }

      switch (charCode) {
      case 39: case 34: // '"
        return this.scanStringLiteral();

      case 48: case 49: case 50: case 51: case 52: case 53:
      case 54: case 55: case 56: case 57: // 0-9
        return this.scanNumericLiteral();

      case 46: // .
        // If the dot is followed by a digit it's a float.
        if (isDecDigit(next)) {
          return this.scanNumericLiteral();
        }
        if (46 === next) {
          const uberNext = this.input.charCodeAt(this.index + 2);
          if (61 === uberNext) {
            return this.scanPunctuator('..=');
          }
          if (46 === uberNext) {
            return this.scanVarargLiteral();
          }
          return this.scanPunctuator('..');
        }
        return this.scanPunctuator('.');

      case 61: // =
        if (61 === next) {
          return this.scanPunctuator('==');
        }
        return this.scanPunctuator('=');

      case 62: // >, >=, >>, >>= (arithmetic right shift), >>>, >>>= (logical right shift), >><, >><= (rotate right)
        if (62 === next) { // it's one of >>, >>=, >>>, >>>=, >><, >><=
          const uberNext = this.input.charCodeAt(this.index + 2);
          if (61 === uberNext) {
            return this.scanPunctuator('>>=');
          }
          if (62 === uberNext) { // it's >>> or >>>=
            if (this.input.charCodeAt(this.index + 3) === 61) {
              return this.scanPunctuator('>>>=');
            }
            return this.scanPunctuator('>>>');
          }
          if (60 === uberNext) { // it's >>< or >><=
            if (this.input.charCodeAt(this.index + 3) === 61) {
              return this.scanPunctuator('>><=');
            }
            return this.scanPunctuator('>><');
          }
          if (62 === next) {
            return this.scanPunctuator('>>');
          }
        }
        if (61 === next) {
          return this.scanPunctuator('>=');
        }
        return this.scanPunctuator('>');

      case 60: // <, <=, <<, <<= (left shift), <<>, <<>= (rotate left)
        if (60 === next) { // it's <<, <<=, <<>, or <<>=
          const uberNext = this.input.charCodeAt(this.index + 2);
          if (61 === uberNext) {
            return this.scanPunctuator('<<=');
          }
          if (62 === uberNext) { // 62 is >
            if (this.input.charCodeAt(this.index + 3) === 61) {
              return this.scanPunctuator('<<>=');
            }
            return this.scanPunctuator('<<>');
          }
          return this.scanPunctuator('<<');
        }
        if (61 === next) {
          return this.scanPunctuator('<=');
        }
        return this.scanPunctuator('<');

      case 126: // ~
        if (61 === next) {
          return this.scanPunctuator('~=');
        }
        return this.scanPunctuator('~');

      case 58: // :
        if (58 === next) {
          return this.scanPunctuator('::');
        }
        return this.scanPunctuator(':');

      case 91: // [
        // Check for a multiline string, they begin with [= or [[
        if (91 === next || 61 === next) {
          return this.scanLongStringLiteral();
        }
        return this.scanPunctuator('[');

      case 94: // ^, ^= (exponentiation), ^^, ^^= (xor)
        if (61 === next) {
          return this.scanPunctuator('^=');
        }
        if (94 === next) {
          if (61 === this.input.charCodeAt(this.index + 2)) {
            return this.scanPunctuator('^^=');
          }
          return this.scanPunctuator('^^');
        }
        return this.scanPunctuator('^');

      case 33: // != only (solitary ! is not allowed)
        if (61 === next) {
          return this.scanPunctuator('!=');
        }
        break;

      // Check for assignment operators (+=, etc.)
      case 37: // %
      case 38: // &
      case 42: // *
      case 43: // +
      case 45: // -
      case 47: // /
      case 92: // \
      case 124: // |
        if (61 === next) {
          return this.scanPunctuator(this.input.charAt(this.index) + '=');
        }
        return this.scanPunctuator(this.input.charAt(this.index));

      case 35: // #
      case 36: // $
      case 40: // (
      case 41: // )
      case 44: // ,
      case 59: // ;
      case 63: // ?
      case 64: // @
      case 93: // ]
      case 123: // {
      case 125: // }
        return this.scanPunctuator(this.input.charAt(this.index));
      }

      this.index++;
      this.addError(errMessages.unexpectedSymbol, this.input.charAt(this.tokenStart));
    }
  }

  consumeEOL() {
    const charCode = this.input.charCodeAt(this.index);
    const peekCharCode = this.input.charCodeAt(this.index + 1);

    if (isLineTerminator(charCode)) {
      // Count \n\r and \r\n as one newline.
      let forward = 1;
      if (10 === charCode && 13 === peekCharCode) {
        this.peekCharCodeindex++; forward = 2;
      }
      if (13 === charCode && 10 === peekCharCode) {
        this.peekCharCodeindex++; forward = 2;
      }
      this.index += forward;

      this.line++;
      this.lineStart = this.index;
      return true;
    }
    return false;
  }

  skipWhiteSpace() {
    while (this.index < this.length) {
      const charCode = this.input.charCodeAt(this.index);
      if (isWhiteSpace(charCode)) {
        this.index++;
      } else if (!this.consumeEOL()) {
        break;
      }
    }
  }

  // Identifiers, keywords, booleans and nil all look the same syntax wise. We
  // simply go through them one by one and defaulting to an identifier if no
  // previous case matched.

  scanIdentifierOrKeyword(): Token {
    let value, type;

    // Slicing the input string is prefered before string concatenation in a
    // loop for performance reasons.
    while (isIdentifierPart(this.input.charCodeAt(this.index))) {
      this.index++;
    }
    value = this.encodingMode.fixup(this.getLocation(), this.input.slice(this.tokenStart, this.index));

    // Decide on the token type and possibly cast the value.
    if (isKeyword(value)) {
      type = TokenType.Keyword;
    } else if ('true' === value || 'false' === value) {
      type = TokenType.BooleanLiteral;
      value = ('true' === value);
    } else if ('nil' === value) {
      type = TokenType.NilLiteral;
      value = null;
    } else {
      type = TokenType.Identifier;
    }

    return this.makeToken(type, value);
  }

  // Once a punctuator reaches this function it should already have been
  // validated so we simply return it as a token.
  scanPunctuator(value: string): Token {
    this.index += value.length;
    return this.makeToken(TokenType.Punctuator, value);
  }

  // A Vararg literal consists of three dots.

  scanVarargLiteral(): Token {
    this.index += 3; // ...
    return this.makeToken(TokenType.VarargLiteral, '...');
  }

  // Find the string literal by matching the delimiter marks used.

  scanStringLiteral(): Token {
    // which quote, either single or double quote
    const delimiter = this.input.charCodeAt(this.index++);
    const { value, reached } = this.readShortString(delimiter, false);
    if (reached === 'include' || (reached === 'end' && this.pasted)) {
      const unfinished = errors.createErr(this.getCurrentBounds(), errMessages.unfinishedString, this.input.slice(this.tokenStart, this.index));
      this.openBracket = { quote: delimiter, unfinished, include: reached === 'include' ? this.index : undefined };
    } else if (reached !== 'close') {
      this.addError(errMessages.unfinishedString, this.input.slice(this.tokenStart, this.index));
    }
    return this.makeToken(TokenType.StringLiteral, value);
  }

  // Reads a short string on to its delimiter and past it: 'close'; or to the line break or end of the text that leaves
  // it unfinished: 'unfinished'. In the blanks and line breaks after a \z, which skipping starts in, it stops at the
  // end of the text: 'end', or at the # of an #include line of includeLines: 'include'; PICO-8 goes on skipping in the
  // text that comes next.
  readShortString(delimiter: number, skipping: boolean): { value: string | null, reached: 'close' | 'unfinished' | 'end' | 'include' } {
    let value = this.encodingMode.discardStrings ? null : '';
    let partStart = this.index;
    const take = (end: number) => {
      if (value !== null) {
        value += this.encodingMode.fixup(this.getLocation(), this.input.slice(partStart, end));
      }
    };
    for (;;) {
      while (skipping) {
        while (isWhiteSpace(this.input.charCodeAt(this.index))) {
          this.index++;
        }
        if (!this.consumeEOL()) {
          if (this.index >= this.length) {
            return { value, reached: 'end' };
          }
          skipping = false;
          partStart = this.index;
        } else if (this.includeLines) {
          let hash = this.index;
          while (this.input.charCodeAt(hash) === 32 || this.input.charCodeAt(hash) === 9) {
            hash++;
          }
          if (this.includeLines.has(hash)) {
            this.index = hash;
            return { value, reached: 'include' };
          }
        }
      }
      this.charCode = this.input.charCodeAt(this.index++);
      if (delimiter === this.charCode) {
        take(this.index - 1);
        return { value, reached: 'close' };
      }
      if (this.index > this.length || isLineTerminator(this.charCode)) {
        take(this.index - 1);
        // Leave the line break to skipWhiteSpace, so that the line gets counted.
        this.index--;
        return { value, reached: 'unfinished' };
      }
      if (92 === this.charCode) { // backslash
        take(this.index - 1);
        if (this.input.charAt(this.index) === 'z') {
          this.index++;
          skipping = true;
          continue;
        }
        const escapeValue = this.readEscapeSequence();
        if (value !== null) {
          value += escapeValue;
        }
        partStart = this.index;
      }
    }
  }

  scanLongStringLiteral(): Token {
    const string = this.readLongString(false);
    // The parser reports what follows the `[`.
    if (false === string) {
      return this.makeToken(TokenType.Punctuator, '[');
    }

    return this.makeToken(
      TokenType.StringLiteral,
      this.encodingMode.discardStrings ? null : this.encodingMode.fixup(this.getLocation(), string),
    );
  }

  scanNumericLiteral(): Token {
    const character = this.input.charAt(this.index);
    const next = this.input.charAt(this.index + 1);

    let literal = undefined;
    if (character === '0') {
      if ([ 'x', 'X' ].includes(next)) {
        literal = this.readHexLiteral();
      } else if ([ 'b', 'B' ].includes(next)) {
        literal = this.readBinaryLiteral();
      }
    }

    if (literal === undefined) {
      // If we didn't already read hex or binary literal, it must be decimal
      literal = this.readDecLiteral();
    }

    const token = this.makeToken(TokenType.NumericLiteral, literal.value);
    token.raw = this.input.slice(this.tokenStart, this.index);
    return token;
  }

  // PICO-8 hexadecimals have an optional fraction part and, unlike Lua's, no p
  // exponent. JavaScript does not read a hexadecimal fraction, so the two parts
  // are computed separately and summed.

  readHexLiteral() {
    let fraction = 0, // defaults to 0 as it gets summed
      fractionStart;

    const digitStart = this.index += 2; // Skip 0x part
    let digit;

    let needAtLeastOneFractionalDigit = false;
    // Support for numbers like 0x.1
    if ('.' !== this.input.charAt(this.index)) {
      // A minimum of one hex digit is required.
      if (!isHexDigit(this.input.charCodeAt(this.index))) {
        return this.malformedNumber();
      }

      while (isHexDigit(this.input.charCodeAt(this.index))) {
        ++this.index;
      }
      // Convert the hexadecimal digit to base 10.
      digit = parseInt(this.input.slice(digitStart, this.index), 16);
    } else {
      digit = 0;
      needAtLeastOneFractionalDigit = true;
    }

    // Fraction part is optional.
    let foundFraction = false;
    if ('.' === this.input.charAt(this.index)) {
      foundFraction = true;
      fractionStart = ++this.index;

      while (isHexDigit(this.input.charCodeAt(this.index))) {
        needAtLeastOneFractionalDigit = false;
        ++this.index;
      }

      if ('.' === this.input.charAt(this.index)) {
        return this.malformedWithDots(isHexDigit);
      }
      if (needAtLeastOneFractionalDigit) {
        return this.malformedNumber();
      }

      const fracStr = this.input.slice(fractionStart, this.index);

      // Empty fraction parts should default to 0, others should be converted
      // 0.x form so we can use summation at the end.
      fraction = (fractionStart === this.index) ? 0
        : parseInt(fracStr, 16) / Math.pow(16, this.index - fractionStart);
    }

    return {
      value: digit + fraction,
      hasFractionPart: foundFraction,
    };
  }

  malformedNumber() {
    this.addError(errMessages.malformedNumber, this.input.slice(this.tokenStart, this.index));
    return { value: 0, hasFractionPart: false };
  }

  // PICO-8 reads a number's digits and dots together, so a second dot makes it malformed, as in 1..2 or 1.."a".
  malformedWithDots(isDigit: (charCode: number) => boolean) {
    while ('.' === this.input.charAt(this.index) || isDigit(this.input.charCodeAt(this.index))) {
      ++this.index;
    }
    return this.malformedNumber();
  }

  // Decimal numbers are exactly the same in Lua and in JavaScript, because of
  // this we check where the token ends and then parse it with native
  // functions.

  readDecLiteral() {
    while (isDecDigit(this.input.charCodeAt(this.index))) {
      ++this.index;
    }

    // Fraction part is optional
    let foundFraction = false;
    if ('.' === this.input.charAt(this.index)) {
      foundFraction = true;
      ++this.index;
      // Fraction part defaults to 0
      while (isDecDigit(this.input.charCodeAt(this.index))) {
        ++this.index;
      }
      if ('.' === this.input.charAt(this.index)) {
        return this.malformedWithDots(isDecDigit);
      }
    }

    return {
      value: parseFloat(this.input.slice(this.tokenStart, this.index)),
      hasFractionPart: foundFraction,
    };
  }

  readBinaryLiteral() {
    const digitStart = this.index += 2; // Skip 0b part

    while (isBinaryDigit(this.input.charCodeAt(this.index))) {
      ++this.index;
    }
    const digits = this.input.slice(digitStart, this.index);

    // Fraction part is optional
    let foundFraction = false;
    let fraction = '';
    if ('.' === this.input.charAt(this.index)) {
      foundFraction = true;
      const fractionStart = ++this.index;
      while (isBinaryDigit(this.input.charCodeAt(this.index))) {
        ++this.index;
      }
      if ('.' === this.input.charAt(this.index)) {
        return this.malformedWithDots(isBinaryDigit);
      }
      fraction = this.input.slice(fractionStart, this.index);
    }

    // A minimum of one binary digit is required, before or after the dot.
    if (this.index - digitStart === (foundFraction ? 1 : 0)) {
      return this.malformedNumber();
    }

    return {
      value: (digits === '' ? 0 : parseInt(digits, 2)) + (fraction === '' ? 0 : parseInt(fraction, 2) / Math.pow(2, fraction.length)),
      hasFractionPart: foundFraction,
    };
  }

  // Translate escape sequences to the actual characters.
  readEscapeSequence() {
    const sequenceStart = this.index;
    switch (this.input.charAt(this.index)) {
    // Lua allow the following escape sequences.
    case 'n': ++this.index; return '\n';
    case 'r': ++this.index; return '\r';
    case 't': ++this.index; return '\t';

      // Backslash at the end of the line. We treat all line endings as equivalent,
      // and as representing the [LF] character (code 10). Lua 5.1 through 5.3
      // have been verified to behave the same way.
    case '\r':
    case '\n':
      this.consumeEOL();
      return '\n';

    case 'x':
      // \xXX, where XX is a sequence of exactly two hexadecimal digits
      if (isHexDigit(this.input.charCodeAt(this.index + 1)) &&
          isHexDigit(this.input.charCodeAt(this.index + 2))) {
        this.index += 3;
        return this.encodingMode.encodeByte(parseInt(this.input.slice(sequenceStart + 1, this.index), 16));
      }
      this.addError(errMessages.hexadecimalDigitExpected, '\\' + this.input.slice(sequenceStart, this.index + 2));
      return this.input.charAt(this.index++);

    case '\\': case '"': case '\'':
      return this.input.charAt(this.index++);

    case '0': case '1': case '2': case '3': case '4': case '5': case '6': case '7':
    case '8': case '9': {
      const digits = /^[0-9]{1,3}/.exec(this.input.slice(this.index, this.index + 3))![0];
      if (+digits > 255) {
        this.addError(errMessages.decimalEscapeTooLarge, '\\' + digits);
      }
      return this.input.charAt(this.index++);
    }

    // P8SCII control codes to ignore, see: https://pico-8.fandom.com/wiki/P8SCII
    case '*': case '#': case '-': case '|': case '+': case '^':
    case 'a': case 'b': case 'v': case 'f':
      return this.input.charAt(this.index++);
    }

    // PICO-8 pastes a file in with two line breaks after it, and a \ that ends the file takes the first
    // (si.eff.str.short-bs-no-final).
    if (this.pasted && this.index >= this.length) {
      return '\n';
    }
    this.addError(errMessages.invalidEscape, '\\' + this.input.slice(sequenceStart, this.index + 1));
    return this.index < this.length ? this.input.charAt(this.index++) : '';
  }

  scanComment(canBeLongComment: boolean) {
    this.tokenStart = this.index;
    this.tokenStartLine = this.line;
    this.tokenStartLineIdx = this.lineStart;
    this.index += 2;

    const character = this.input.charAt(this.index);
    const commentStart = this.index;
    let content: string | false = '';
    let isLong = false;

    if (canBeLongComment && character === '[') {
      content = this.readLongString(true);
      // This wasn't a multiline comment after all.
      if (content === false) {
        content = character;
      } else {
        isLong = true;
      }
    }
    // Scan until next line as long as it's not a multiline comment.
    if (!isLong) {
      while (this.index < this.length) {
        if (isLineTerminator(this.input.charCodeAt(this.index))) {
          break;
        }
        ++this.index;
      }
      content = this.input.slice(commentStart, this.index);
    }

    const lineBefore = this.input.slice(this.tokenStartLineIdx, this.tokenStart);
    const startsLine = /^[ \t\v\f]*$/.test(lineBefore);
    // Stops at the first character that is not a blank rather than reading to the end of the line: a line of many long
    // comments would take quadratic time.
    let after = this.index;
    while (after < this.length && isWhiteSpace(this.input.charCodeAt(after))) {
      ++after;
    }
    const endsLine = after === this.length || isLineTerminator(this.input.charCodeAt(after));
    const node = AST.comment(content, this.input.slice(this.tokenStart, this.index), startsLine, lineBefore, endsLine);

    // `Marker`s depend on tokens available in the parser and as comments are
    // intercepted in the lexer all location data is set manually.
    node.loc = this.getCurrentBounds();
    this.comments.push(node);

    if (this.isCommentStart(after)) {
      this.commentsBeforeComment.push(node);
    } else {
      for (const before of this.commentsBeforeComment) {
        before.endsLine = endsLine;
      }
      this.commentsBeforeComment = [];
    }
  }

  // -- or, in PICO-8, //.
  private isCommentStart(index: number): boolean {
    const charCode = this.input.charCodeAt(index);
    return (45 === charCode || 47 === charCode) && charCode === this.input.charCodeAt(index + 1);
  }

  // Read a multiline string by calculating the depth of `=` characters and
  // then appending until an equal depth is found.

  readLongString(isComment: boolean): string | false {
    let level = 0;
    const firstLine = this.getCurrentBounds().start.line;

    ++this.index; // [

    // Calculate the depth of the comment.
    while ('=' === this.input.charAt(this.index + level)) {
      ++level;
    }
    // Exit, this is not a long string afterall.
    if ('[' !== this.input.charAt(this.index + level)) {
      return false;
    }

    this.index += level + 1;

    // If the first character is a newline, ignore it and begin on next line.
    if (isLineTerminator(this.input.charCodeAt(this.index))) {
      this.consumeEOL();
    }

    const stringStart = this.index;
    const reached = this.closeLongBracket(level);
    if (reached === 'close') {
      return this.input.slice(stringStart, this.index - level - 2);
    }
    const unfinished = errors.createErr(this.getCurrentBounds(), isComment ? errMessages.unfinishedLongComment : errMessages.unfinishedLongString,
      firstLine, '<eof>');
    if (reached === 'include') {
      this.openBracket = { level, isComment, unfinished, include: this.index };
    } else if (this.pasted) {
      this.openBracket = { level, isComment, unfinished };
    } else {
      this.errors.push(unfinished);
    }
    return this.input.slice(stringStart, this.index);
  }

  // Reads on to the close of a long bracket of the level, ]] or ]=] and so on, and past it; or to the end of the code;
  // or to the # of an #include line of includeLines.
  closeLongBracket(level: number): 'close' | 'end' | 'include' {
    while (this.index < this.length) {
      if (this.includeLines && this.index === this.lineStart) {
        let hash = this.index;
        while (this.input.charCodeAt(hash) === 32 || this.input.charCodeAt(hash) === 9) {
          hash++;
        }
        if (this.includeLines.has(hash)) {
          this.index = hash;
          return 'include';
        }
      }
      if (this.consumeEOL()) {
        continue;
      }
      if (this.input.charAt(this.index++) === ']' && this.input.startsWith('='.repeat(level) + ']', this.index)) {
        this.index += level + 1;
        return 'close';
      }
    }
    return 'end';
  }

  // ## Lex functions and helpers.

  // Where next() takes each token from: lex(), or, as the parser has it, the main file with the files it pastes in.
  read: () => Token = () => this.lex();

  // Read the next token.
  //
  // This is actually done by setting the current token to the lookahead and
  // reading in the new lookahead token.

  next() {
    this.previousToken = this.token;

    if (this.lookahead === undefined) {
      // First time calling next(), we'll read two tokens to get lookahead in
      // the right state
      this.lookahead = this.read();
    }

    if (this.newlineSignificant
        && this.token?.type !== TokenType.Newline
        && !onOneLine(this.token, this.lookahead)) {
      this.token = this.makeToken(TokenType.Newline, '\\n');
      // Create fake zero-width location right after the last real token.
      // Prevents misformatting one-line if statements.
      if (this.previousToken) {
        this.token.bounds = {
          start: { ...this.previousToken.bounds.end },
          end: { ...this.previousToken.bounds.end },
        };
      }
      // lookahead remains the same until newlineSignificant is turned off
    } else {
      this.token = this.lookahead;
      this.lookahead = this.read();
    }
  }

  // The #include line whose # is at from, on the line being read, as one token up to the end of the line.
  readIncludeLine(from: number): Token {
    this.index = this.tokenStart = from;
    this.tokenStartLine = this.line;
    this.tokenStartLineIdx = this.lineStart;
    while (this.index < this.length && !isLineTerminator(this.input.charCodeAt(this.index))) {
      this.index++;
    }
    return this.makeToken(TokenType.Raw, this.input.slice(from, this.index));
  }

  // Consume a token if its value matches. Once consumed or not, return the
  // success of the operation.

  consume(value: TokenValue) {
    if (value === this.token?.value) {
      this.next();
      return true;
    }
    return false;
  }

  // Expect the next token value to match. If not, throw an exception.

  expect(value: TokenValue) {
    if (value === this.token?.value) {
      this.next();
    } else {
      errors.raiseErrForToken(this.token!, errMessages.expected, value, tokenText(this.token!));
    }
  }
}

// Each lexer has a ResolvedFile of its own. A file the parser pastes in shares no line with the code around it: a line
// break comes before an #include line and after the file.
export function onOneLine(a: Token | undefined, b: Token): boolean {
  return a !== undefined && a.bounds.start.filename === b.bounds.start.filename && (a.line ?? a.bounds.start.line) === (b.line ?? b.bounds.start.line);
}

// Where the # of each #include line that PICO-8 reads is in the code.
// PICO-8 finds them in the cart's own text before Lua reads the code: at the start of a line, in lower case and
// followed by a space (3.after-code, 3.upper, 3.tab-after-include, 3.nested), and only outside a long string or comment
// of that text, whatever a pasted file leaves open (3.alone-str-cart-comment-level, 3.alone-code-real-comment). Its
// scan is not Lua's: it reads short strings, which \ and a line break take on to the next line, -- comments, long or
// not, and // line comments, //[[ too (3.scan-dq-string, 3.dq-cont-include, 3.scan-line-comment-space,
// 3.scan-slash-long), but a \z does not take a string past a line break (3.z-include), and it skips the rest of an
// #include line (3.scan-name-brackets). Elsewhere the # is the length operator. The scan stops at the last #include
// line.
export function includeLinesOf(input: string): Set<number> | undefined {
  let hash = input.indexOf('#include ');
  if (hash < 0) {
    return undefined;
  }
  const lines = new Set<number>();
  let at = 0;
  for (; hash >= 0; hash = input.indexOf('#include ', Math.max(at, hash + 1))) {
    let lineStart = hash;
    while (lineStart > 0 && (input.charCodeAt(lineStart - 1) === 32 || input.charCodeAt(lineStart - 1) === 9)) {
      lineStart--;
    }
    if (lineStart > 0 && input.charCodeAt(lineStart - 1) !== 10 && input.charCodeAt(lineStart - 1) !== 13) {
      continue;
    }
    at = scanCodeTo(input, at, hash);
    if (at === hash) {
      lines.add(hash);
      at = lineEnd(input, hash);
    }
  }
  return lines;
}

const OPENS = /["'[]|--|\/\//g;

// From i on in code, past each string and comment, to the place to, or past the string or comment that holds it.
function scanCodeTo(input: string, i: number, to: number): number {
  for (;;) {
    OPENS.lastIndex = i;
    const open = OPENS.exec(input);
    if (!open || open.index >= to) {
      return to;
    }
    i = open.index;
    let end: number;
    if (open[0] === '"' || open[0] === '\'') {
      end = shortStringEnd(input, i);
    } else if (open[0] === '[') {
      end = longBracketEnd(input, i) ?? i + 1;
    } else {
      end = (open[0] === '--' ? longBracketEnd(input, i + 2) : undefined) ?? lineEnd(input, i);
    }
    if (end > to) {
      return end;
    }
    i = end;
  }
}

function shortStringEnd(input: string, i: number): number {
  const quote = input.charCodeAt(i);
  for (let j = i + 1; j < input.length; j++) {
    const c = input.charCodeAt(j);
    if (c === quote) {
      return j + 1;
    }
    if (c === 10 || c === 13) {
      return j;
    }
    if (c === 92) {
      // A line break as the lexer reads one: \r\n and \n\r are one (Lexer.consumeEOL).
      const next = input.charCodeAt(j + 1);
      const after = input.charCodeAt(j + 2);
      j += (next === 10 && after === 13) || (next === 13 && after === 10) ? 2 : 1;
    }
  }
  return input.length;
}

function longBracketEnd(input: string, i: number): number | undefined {
  let j = i + 1;
  while (input.charCodeAt(j) === 61) {
    j++;
  }
  if (input.charCodeAt(i) !== 91 || input.charCodeAt(j) !== 91) {
    return undefined;
  }
  const close = ']' + '='.repeat(j - i - 1) + ']';
  const at = input.indexOf(close, j + 1);
  return at < 0 ? input.length : at + close.length;
}

export function lineEnd(input: string, i: number): number {
  while (i < input.length && input.charCodeAt(i) !== 10 && input.charCodeAt(i) !== 13) {
    i++;
  }
  return i;
}

// PICO-8 counts the tokens of a cart with its #include files pasted in before Lua reads the code, with a lexer of its
// own that reads strings and comments as its scan for #include lines does (includeLinesOf). A character that is no
// token is one, and "#include " where a token can start hides the rest of its line (5.tok.*). Each token counts one but
// for these:
const FREE_TOKENS = new Set([ ',', '.', ':', ';', '::', ')', ']', '}', 'local', 'end' ]);
// and a - or ~ right before a number after one of these, which counts with the number.
const JOINS_AFTER = new Set([ '=', '(', ',', '{', '[', '==', '~=', '!=', '<', '>', '<=', '>=', '+', '-', '*', '/', '\\', '%', '^', '&', '|',
  '^^', '~', '<<', '>>', '>>>', '<<>', '>><', 'and', 'or', 'not', 'return', 'if', 'elseif', 'while', 'until', '?', '+=', '-=', '*=', '/=',
  '\\=', '%=', '^=', '..=', '|=', '&=', '^^=', '<<=', '>>=', '>>>=', '<<>=', '>><=' ]);
// The operators by their first character, the longest first.
const COUNTED_OPERATORS = new Map<number, string[]>();
for (const operator of [ '>>>=', '<<>=', '>><=', '^^=', '>>>', '<<>', '>><', '..=', '...', '<<=', '>>=', '==', '~=', '!=', '<=', '>=', '<<', '>>',
  '^^', '..', '::', '+=', '-=', '*=', '/=', '\\=', '%=', '^=', '|=', '&=', '+', '-', '*', '/', '\\', '%', '^', '#', '&', '|', '~', '<', '>', '=',
  '(', ')', '{', '}', '[', ']', ';', ':', ',', '.', '@', '$', '?' ]) {
  const first = operator.charCodeAt(0);
  COUNTED_OPERATORS.set(first, [ ...COUNTED_OPERATORS.get(first) ?? [], operator ]);
}

// The count, and where the token that passes the limit starts and ends.
export function countTokens(code: string, limit: number): { count: number, over?: { start: number, end: number } } {
  let count = 0;
  let over: { start: number, end: number } | undefined;
  // Where the token before starts and ends, and where a - or ~ that counts with the number after it starts.
  let beforeStart = 0;
  let beforeEnd = 0;
  let joined: number | undefined;
  const length = code.length;
  for (let i = 0; i < length;) {
    const c = code.charCodeAt(i);
    if (c === 32 || c === 9 || c === 13 || c === 10) {
      i++;
      continue;
    }
    if ((c === 45 || c === 47) && code.charCodeAt(i + 1) === c) {
      i = (c === 45 ? longBracketEnd(code, i + 2) : undefined) ?? lineEnd(code, i);
      continue;
    }
    if (c === 35 && code.startsWith('include ', i + 1)) {
      i = lineEnd(code, i);
      continue;
    }
    const start = i;
    let free = false;
    const longString = c === 91 ? longBracketEnd(code, i) : undefined;
    if (c === 34 || c === 39) {
      i = shortStringEnd(code, i);
    } else if (longString !== undefined) {
      i = longString;
    } else if (isDecDigit(c) || (c === 46 && isDecDigit(code.charCodeAt(i + 1)))) {
      // A number takes its digits and every dot: 1..2 is one.
      const next = code.charCodeAt(i + 1) | 32;
      const isDigit = c === 48 && next === 120 ? isHexDigit : c === 48 && next === 98 ? isBinaryDigit : isDecDigit;
      i += isDigit === isDecDigit ? 1 : 2;
      while (isDigit(code.charCodeAt(i)) || code.charCodeAt(i) === 46) {
        i++;
      }
    } else if (isIdentifierStart(c)) {
      do {
        i++;
      } while (i < length && isIdentifierPart(code.charCodeAt(i)));
      // Of the names, only local and end are free.
      free = (i - start === 3 || i - start === 5) && FREE_TOKENS.has(code.slice(start, i));
    } else {
      const operator = COUNTED_OPERATORS.get(c)?.find(candidate => code.startsWith(candidate, i));
      i += operator?.length ?? 1;
      free = operator !== undefined && FREE_TOKENS.has(operator);
      if ((operator === '-' || operator === '~') && (isDecDigit(code.charCodeAt(i)) || (code.charCodeAt(i) === 46 && isDecDigit(code.charCodeAt(i + 1))))
        && JOINS_AFTER.has(code.slice(beforeStart, beforeEnd))) {
        joined = start;
        free = true;
      }
    }
    beforeStart = start;
    beforeEnd = i;
    if (free) {
      continue;
    }
    if (++count === limit + 1) {
      over = { start: joined ?? start, end: i };
    }
    joined = undefined;
  }
  return { count, over };
}

// ### Validation functions

function isWhiteSpace(charCode: number): boolean {
  return 9 === charCode || 32 === charCode || 0xB === charCode || 0xC === charCode;
}

function isLineTerminator(charCode: number): boolean {
  return 10 === charCode || 13 === charCode;
}

// The line breaks in the text from from to to, read as consumeEOL reads them, and where the line after the last starts.
function lineBreaks(text: string, from: number, to: number): { breaks: number, lineStart: number } {
  let breaks = 0;
  let lineStart = from;
  for (let i = from; i < to; i++) {
    const charCode = text.charCodeAt(i);
    if (isLineTerminator(charCode)) {
      const next = text.charCodeAt(i + 1);
      i += isLineTerminator(next) && next !== charCode ? 1 : 0;
      breaks++;
      lineStart = i + 1;
    }
  }
  return { breaks, lineStart };
}

// Where each line of the text starts, its line breaks read as consumeEOL reads them.
function lineStartsOf(text: string): number[] {
  const starts = [ 0 ];
  for (let i = 0; i < text.length; i++) {
    const charCode = text.charCodeAt(i);
    if (isLineTerminator(charCode)) {
      const next = text.charCodeAt(i + 1);
      i += isLineTerminator(next) && next !== charCode ? 1 : 0;
      starts.push(i + 1);
    }
  }
  return starts;
}

function isDecDigit(charCode: number): boolean {
  return charCode >= 48 && charCode <= 57;
}

function isHexDigit(charCode: number): boolean {
  return (charCode >= 48 && charCode <= 57) || (charCode >= 97 && charCode <= 102) || (charCode >= 65 && charCode <= 70);
}

function isBinaryDigit(charCode: number): boolean {
  return charCode === 48 || charCode === 49;
}

// From [Lua 5.2](http://www.lua.org/manual/5.2/manual.html#8.1) onwards
// identifiers cannot use 'locale-dependent' letters (i.e. dependent on the C
// locale). On the other hand, LuaJIT allows arbitrary octets ≥ 128 in
// identifiers.
export function isIdentifierStart(charCode: number): boolean {
  if (
    (charCode >= 65 && charCode <= 90) // A-Z
    || (charCode >= 97 && charCode <= 122) // a-z
    || 95 === charCode // _
    || charCode >= 128) { // other Unicode characters
    return true;
  }

  return false;
}

export function isIdentifierPart(charCode: number): boolean {
  if ((charCode >= 65 && charCode <= 90) // A-Z
    || (charCode >= 97 && charCode <= 122) // a-z
    || 95 === charCode // _
    || (charCode >= 48 && charCode <= 57) // 0-9
    || charCode >= 128) { // other Unicode characters
    return true;
  }

  return false;
}

// TODO should `true`, `false` and `nil` be keywords for PICO-8?
// [3.1 Lexical Conventions](http://www.lua.org/manual/5.2/manual.html#3.1)
// `true`, `false` and `nil` will not be considered keywords, but literals.
function isKeyword(id: string): boolean {
  switch (id.length) {
  case 2:
    return 'do' === id || 'if' === id || 'in' === id || 'or' === id;
  case 3:
    return 'and' === id || 'end' === id || 'for' === id || 'not' === id;
  case 4:
    return 'else' === id || 'then' === id || 'goto' === id;
  case 5:
    return 'break' === id || 'local' === id || 'until' === id || 'while' === id;
  case 6:
    return 'elseif' === id || 'repeat' === id || 'return' === id;
  case 8:
    return 'function' === id;
  }
  return false;
}

export function isP8BeginningOfCodeSection(value: string): boolean {
  return value === '__lua__';
}

export function isP8EndOfCodeSection(value: string): boolean {
  return [ '__gfx__', '__label__', '__gff__', '__map__', '__sfx__', '__music__' ].includes(value);
}
