import { pico8Text } from './p8scii';
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
  // A number or a string as PICO-8 quotes it in a message: a number as it is written, a string as the text of the bytes
  // it holds, in its quotes or long brackets (4.strtext.*).
  quoted?: string,
  // The line of the code that the token starts on, when the code is not one run of the text from the start of a line
  // (Code): the code can join the tabs of a file with nothing between them, or leave out a lone CR, so its lines can be
  // other than the text's.
  line?: number,
};

// Whether the token is the punctuator or keyword value: a string is neither, whatever text it holds.
export function isSymbol(token: Token, value: string): boolean {
  return (token.type === TokenType.Punctuator || token.type === TokenType.Keyword) && token.value === value;
}

// How messages quote a token, as PICO-8 does: a string up to its first byte 0 (4.strtext.dec-0), and a name as the text
// of the bytes PICO-8 holds for it (4.strtext.name-e).
export function tokenText(token: Token): string {
  if (token.quoted !== undefined) {
    return token.quoted.split('\0')[0];
  }
  if (token.type === TokenType.Identifier) {
    return pico8Text(token.value as string);
  }
  return token.type === TokenType.NilLiteral ? 'nil' : String(token.value);
}
