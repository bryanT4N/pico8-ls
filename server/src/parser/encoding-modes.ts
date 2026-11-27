import { errMessages, raiseErr } from './errors';
import { CodeLocation } from './types';

export type EncodingMode = {
  discardStrings: boolean;
  fixup: (loc: CodeLocation, s: string) => string;
};

function toHex(num: number, digits: number): string {
  let result = num.toString(16);
  while (result.length < digits) {
    result = '0' + result;
  }
  return result;
}

function checkChars(loc: CodeLocation, s: string, rx: RegExp) {
  const m = rx.exec(s);
  if (!m) {
    return s;
  }
  raiseErr({ start: loc, end: loc }, errMessages.invalidCodeUnit, toHex(m[0].charCodeAt(0), 4).toUpperCase());
}

// TODO fix this up so it converts PICO-8 special characters into the right "ascii" characters or whatever

// `pseudo-latin1` encoding mode: assume the input was decoded with the latin1 encoding
// WARNING: latin1 does **NOT** mean cp1252 here like in the
// bone-headed WHATWG standard; it means true ISO/IEC 8859-1 identity-mapped
// to Basic Latin and Latin-1 Supplement blocks
class PseudoLatin1 implements EncodingMode {
  discardStrings = false;

  fixup(loc: CodeLocation, s: string): string {
    return checkChars(loc, s, /[^\x00-\xff]/);
  }
}

// `x-user-defined` encoding mode: assume the input was decoded with the
// WHATWG `x-user-defined` encoding
class XUserDefined implements EncodingMode {
  discardStrings = false;

  fixup(loc: CodeLocation, s: string): string {
    return s;
  }
}

// `none` encoding mode: disregard intrepretation of string literals, leave
// identifiers as-is
class NoEncodingMode implements EncodingMode {
  discardStrings = true;

  fixup(s: any): any {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return s;
  }
}

export enum EncodingModeType {
  PseudoLatin1 = 'pseudo-latin1',
  XUserDefined = 'x-user-defined',
  None = 'none',
}

export const encodingModes: { [key in EncodingModeType]: EncodingMode } = {
  'pseudo-latin1': new PseudoLatin1(),
  'x-user-defined': new XUserDefined(),
  'none': new NoEncodingMode(),
};
