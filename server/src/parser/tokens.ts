import { Bounds } from './types';

export enum TokenType {
  EOF = 'EOF',
  StringLiteral = 'StringLiteral',
  Keyword = 'Keyword',
  Identifier = 'Identifier',
  NumericLiteral = 'NumericLiteral',
  Punctuator = 'Punctuator',
  BooleanLiteral = 'BooleanLiteral',
  NilLiteral = 'NilLiteral',
  VarargLiteral = 'VarargLiteral',
  Newline = 'Newline',
  Raw = 'Raw',
}

export type TokenValue = string | boolean | number | null;

export type Token = {
  type: TokenType,
  value: TokenValue,
  bounds: Bounds,
  // A number's text in the code, which messages quote.
  raw?: string,
  // The line of the code that the token starts on, when the code is not one run of the text from the start of a line
  // (Code): the code can join the tabs of a file with nothing between them, or leave out a lone CR, so its lines can be
  // other than the text's.
  line?: number,
};

// How messages quote a token: a number as it is written, as PICO-8 quotes it.
export function tokenText(token: Token): string {
  if (token.raw !== undefined) {
    return token.raw;
  }
  return token.type === TokenType.NilLiteral ? 'nil' : String(token.value);
}
