import AST from './ast';
import { FlowContext, LocalVariable } from './control-flow';
import * as errors from './errors';
import { errMessages, raiseErrForToken } from './errors';
import {
  CallExpression,
  Comment_,
  Expression,
  Identifier,
  Literal,
  MemberExpression,
  StringCallExpression,
  StringLiteral,
  TableCallExpression,
  TableConstructorExpression,
  VarargLiteral,
} from './expressions';
import ResolvedFile, { FileResolver, RealFileResolver, resolveIncludeFile } from './file-resolver';
import { characterCount, Code, joined, readCode, tabsOf } from './code';
import Lexer, { countTokens, includeLinesOf, lineEnd, lineFeeds, onOneLine, OpenBracket } from './lexer';
import Marker from './marker';
import {
  AssignmentStatement,
  Block,
  BreakStatement,
  CallStatement,
  Chunk,
  DoStatement,
  ForGenericStatement,
  ForNumericStatement,
  FunctionDeclaration,
  GeneralIfClause,
  GotoStatement,
  IfStatement,
  Include,
  IncludeStatement,
  LabelStatement,
  LocalStatement,
  RepeatStatement,
  ReturnStatement,
  Statement,
  WhileStatement,
} from './statements';
import { Token, tokenText, TokenType } from './tokens';
import * as path from 'path';
import { ASTNode, Bounds, boundsClone, CodeLocation } from './types';
import Operators from './operators';

// PICO-8 takes 256 #include lines in a cart and stops at the next one with "too many #includes" (3.includes-257).
const MAX_INCLUDE_PARSES = 256;

// PICO-8's Lua, as Lua 5.2 (LUAI_MAXCCALLS), counts a level for each statement
// and each subexpression, and rejects code nested more than 200 levels deep.
// Stopping there also keeps the parser and the code that walks the syntax tree
// within the call stack.
const MAX_LEVELS = 200;

// PICO-8, as Lua 5.2, allows a function this many local variables in scope at once (lparser.c, MAXVARS), and this many
// upvalues (lfunc.h, MAXUPVAL).
const MAX_VARIABLES = 200;
const MAX_UPVALUES = 255;
// The locals PICO-8 gives the main function of a cart, before its code: these API functions, which a function that uses
// one takes as an upvalue, and one more that is not known, so the cart's code there can have 141 (2.locals-*.top,
// 2.upvalues-api).
const PICO8_MAIN_LOCALS = [ 'circ', 'ovalfill', 'circfill', 'fget', 'pget', 'color', 'rect', 'line', 'palt', 'pset', 'oval', 'fillp', 'spr',
  'sget', 'sset', 'pal', 'clip', 'mset', 'mget', 'band', 'fset', 'sub', 'rectfill', 'sin', 'memcpy', 'memset', 'flr', 'sspr', 'deli', 'peek',
  'atan2', 'min', 'lshr', 'cos', 'mid', 'tline', 'bnot', 'ceil', 'srand', 'poke', 'shl', 'add', 'rotl', 'del', 'max', 'bor', 'rotr', 'shr',
  'tonum', 'chr', 'bxor', 'ord', 'tostr', 'poke4', 'poke2', 'peek2', 'peek4', 'time', '' ];
const MAX_TOKENS = 8192;
const MAX_CHARACTERS = 65536;

export type ParserOptions = {
  includeFileResolver?: FileResolver,
};

export default class Parser {
  includeFileResolver: FileResolver;

  // The main file's lexer. Every token is read through it, those of the files that its #include lines paste in too
  // (pull).
  readonly lexer: Lexer;

  private readonly code: Code;

  // The first token of the main file's code, the # of an #include line among them.
  private first?: Token;

  // The lexers being read from: the main file's, and above it the one of the file that an #include line pastes in.
  private readonly lexerStack: Lexer[];

  // The files pasted in, in the order of their #include lines, by the ResolvedFile of each, which its lexer alone has:
  // the lexer, the #include line in the main file, and where the file's code starts.
  private readonly pasted = new Map<ResolvedFile, { lexer: Lexer, line: Bounds, start: CodeLocation }>();

  private readonly pasteLines: number[] = [];

  // Each #include line whose file is pasted in, in order: where its # is in the main file's code and where the line
  // ends, the file's lexer, and what PICO-8 counts for the file besides its code's characters, when known
  // (includedCode).
  private readonly pastes: { hash: number, end: number, lexer: Lexer, more?: number }[] = [];

  // The #include lines not yet placed in a block, each with the token that came after it (placeIncludes).
  private unplaced: { statement: IncludeStatement, next?: Token }[] = [];

  // A long string or comment, or a short string after a \z, that runs past the end of a pasted file or past an #include
  // line (Lexer.openBracket), still being read (goOnInBracket), with the token lex() gave then, the string's when it is
  // a string.
  private open?: OpenBracket & { token: Token };

  private readonly ends = new Map<ResolvedFile, Token>();

  private readonly spanning: ASTNode[] = [];

  locations: Marker[] = [];

  // Keep track of all errors that occurred while parsing.
  errors: errors.ParseError[] = [];

  // The error of a goto, a label or a break, kept apart from the others until the end: only one, the first that Lua
  // finds, and only when Lua finds no other error before it (stoppedBefore).
  private gotoErrors: errors.ParseError[] = [];

  includes: Include[] = [];

  private includedComments: Comment_[] = [];

  private unresolvedIncludes: ResolvedFile[] = [];

  private includeParses = 0;
  private reportedTooManyIncludeParses = false;

  private levels = 0;

  // The text of a file, read as PICO-8 reads it (readCode), or code, such as a text read as code of its own (textCode).
  constructor(filename: ResolvedFile, input: string | Code, options: ParserOptions = {}) {
    this.includeFileResolver = options?.includeFileResolver || new RealFileResolver();

    this.code = typeof input === 'string' ? readCode(input) : input;
    this.lexer = new Lexer(this.code, filename);
    this.lexer.read = () => this.pull();
    this.lexer.includeLines = includeLinesOf(this.lexer.input);
    this.lexerStack = [ this.lexer ];
  }

  isCart(): boolean {
    return /\.p8$/i.test(this.mainFile.path);
  }

  isInIncludedFile(): boolean {
    return this.lexerStack.length > 1;
  }

  // The top-level file being parsed (everything else is #include-d from it)
  get mainFile(): ResolvedFile {
    return this.lexer.filename;
  }

  get token(): Token {
    return this.lexer.token!;
  }

  get previousToken(): Token {
    return this.lexer.previousToken!;
  }

  lexerNext(): void {
    this.lexer.next();
  }

  parse(): Chunk {
    return this.parseChunk();
  }

  // Utility functions
  // -----------------

  // Wrap up the node object.
  finishNode<T extends ASTNode>(node: T, greedy?: boolean): T {
    // Pop a `Marker` off the location-array and attach its location data.
    const location = this.popLocation();

    let endingToken = greedy ? this.token : this.previousToken;
    if (greedy && !endingToken) {
      // If there's no next token, take the previous one instead
      endingToken = this.previousToken;
    }

    if (location && endingToken) {
      location.complete(endingToken.bounds.end);
      location.bless(node as any as ASTNode);
      if (this.pasteLines.length > 0 && this.spans(location.loc)) {
        this.spanning.push(node);
      }
    }

    node.included = location ?
      !this.mainFile.equals(location.loc.start.filename) :
      this.isInIncludedFile();

    return node;
  }

  getUnexpectedTokenErr(found: Token): errors.ParseError {
    let type;
    switch (found.type) {
    case TokenType.StringLiteral:   type = 'string';      break;
    case TokenType.Keyword:         type = 'keyword';     break;
    case TokenType.Identifier:      type = 'identifier';  break;
    case TokenType.NumericLiteral:  type = 'number';      break;
    case TokenType.Punctuator:
    case TokenType.NilLiteral:
    case TokenType.VarargLiteral:   type = 'symbol';      break;
    case TokenType.BooleanLiteral:  type = 'boolean';     break;
    case TokenType.Newline:         type = 'newline';     break;
    case TokenType.EOF:
      return errors.createErrForToken(found, errMessages.unexpectedEOF);
    }

    return errors.createErrForToken(found, errMessages.unexpected, type, tokenText(found), tokenText(this.lexer.lookahead!));
  }

  unexpectedToken(found: Token): never {
    throw this.getUnexpectedTokenErr(found);
  }

  // Location tracking
  // -----------------

  createLocationMarker(): Marker {
    return new Marker(this.token);
  }

  // Create a new `Marker` and add it to the FILO-array.
  markLocation() {
    this.locations.push(this.createLocationMarker());
  }

  // Push an arbitrary `Marker` object onto the FILO-array.
  pushLocation(marker: Marker) {
    // If we're using pushLocation rather than markLocation, there's a good
    // chance a marker is being re-used. In that case it's useful to clone the
    // marker to make sure we're not mutating a location that's already in the
    // AST.
    this.locations.push(marker.clone());
  }

  popLocation() {
    return this.locations.pop();
  }

  // Parse functions
  // ---------------

  // Chunk is the main program object. Syntactically it's the same as a block.
  //
  //     chunk ::= block

  parseChunk(): Chunk {
    this.lexerNext();
    const flowContext = new FlowContext(this.gotoErrors, found => this.stoppedBefore(found));
    flowContext.allowVararg = true;
    flowContext.pushScope();
    if (this.code.cart) {
      this.addVariables(flowContext, PICO8_MAIN_LOCALS);
    }
    const body = this.parseBlock(flowContext, isEndOfFile);
    if (this.token.type !== TokenType.EOF) {
      this.errors.push(errors.createErrForToken(this.token, errMessages.expected, '<eof>', tokenText(this.token)));
    } else if (this.isCart()) {
      // PICO-8 rejects a return in a cart's outermost block, also as its last statement (4.return.end-bare), and a
      // goto there past a local to a label at the end, which Lua allows at the end of a block
      // (4.goto.end-of-chunk-local).
      const last = lastCodeStatement(body.body);
      if (last?.type === 'ReturnStatement') {
        this.errors.push(errors.createErr(last.loc!, errMessages.returnInCart));
      }
      flowContext.raiseDeferredErrors(this.token);
    }
    flowContext.endFunction(this.token);

    // Lua reads a token before it parses it, so an error in reading one comes before the parser's error at it, as the
    // stable sort keeps them (4.numtext.dot-in-name).
    const lexers = [ this.lexer, ...[ ...this.pasted.values() ].map(({ lexer }) => lexer) ];
    this.errors = lexers.flatMap(lexer => lexer.errors).concat(this.errors);
    // The parse can stop in a file pasted in.
    for (const lexer of this.lexerStack.slice(1)) {
      this.takeComments(lexer);
    }
    for (const error of this.gotoErrors) {
      this.errors.push(error);
    }
    // PICO-8 checks these before Lua reads the code, so they come after the errors that stoppedBefore looks at.
    if (this.code.cart) {
      this.checkCharacters();
      this.checkTokens();
    } else if (this.isCart() && !/\.lua/i.test(this.mainFile.path)) {
      // PICO-8 does not load such a file, whatever it holds, so this error comes before any other; it reads one whose
      // path has .lua in it as Lua (5.load.*).
      const start = { index: 0, line: 1, column: 0, filename: this.mainFile };
      const firstLineEnd = /[\r\n]|$/.exec(this.code.text)!.index;
      this.errors.unshift(errors.createErr({ start, end: { ...start, index: firstLineEnd, column: firstLineEnd } }, errMessages.notACart));
    }
    this.sortErrors();

    this.pushLocation(new Marker(body.loc!));
    const chunk = this.finishNode(AST.chunk(body, this.errors));
    chunk.includes = this.includes;
    chunk.comments = this.lexer.comments;
    chunk.includedComments = this.includedComments;
    chunk.unresolvedIncludes = this.unresolvedIncludes;

    // The outline, folding and the analysis take a node that runs from one file into another to end where its first
    // file stops being read: at the #include line of the file it runs into, or at the end of the pasted file it starts
    // in, which has been read to its end by then. Its text in the files after that one is kept apart, for the analysis.
    for (const node of this.spanning) {
      const loc = node.loc!;
      const elsewhere = this.partsAfter(loc.start, loc.end);
      if (elsewhere.length > 0) {
        node.elsewhere = elsewhere;
      }
      if (loc.end.filename !== loc.start.filename) {
        loc.end = loc.start.filename === this.lexer.filename
          ? this.pasted.get(loc.end.filename)!.line.end
          : this.ends.get(loc.start.filename)!.bounds.end;
      }
    }

    return chunk;
  }

  // Whether a node ends in another file than it starts in, or holds the #include line of a file pasted in.
  private spans(loc: Bounds): boolean {
    if (loc.end.filename !== loc.start.filename) {
      return true;
    }
    if (loc.start.filename !== this.lexer.filename) {
      return false;
    }
    let low = 0;
    let high = this.pasteLines.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.pasteLines[middle] <= loc.start.index) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low < this.pasteLines.length && this.pasteLines[low] < loc.end.index;
  }

  // The text from start to end in the files after the one start is in: the main file's, from the #include line of the
  // file start is in, and the files pasted in after that, whole or up to end.
  private partsAfter(start: CodeLocation, end: CodeLocation): Bounds[] {
    const main = this.lexer.filename;
    const inMain = (at: CodeLocation) => at.filename === main ? at.index : this.pasted.get(at.filename)!.line.start.index + 0.5;
    const from = inMain(start);
    const to = inMain(end);
    const parts: Bounds[] = [];
    if (start.filename !== main) {
      parts.push({ start: this.pasted.get(start.filename)!.line.end, end: end.filename === main ? end : this.pasted.get(end.filename)!.line.start });
    }
    for (const [ file, { line, start: code }] of this.pasted) {
      if (from < line.start.index && line.start.index < to) {
        parts.push({ start: code, end: file === end.filename ? end : this.ends.get(file)!.bounds.end });
      }
    }
    return parts;
  }

  private lexerOf(file: ResolvedFile): Lexer {
    return file === this.lexer.filename ? this.lexer : this.pasted.get(file)!.lexer;
  }

  private takeComments(lexer: Lexer): void {
    for (const comment of lexer.comments) {
      this.includedComments.push(comment);
    }
  }

  // The next token of the main file with the files that its #include lines paste in, as PICO-8 pastes them: a file's
  // tokens come in place of its #include line, and the main file's go on after the file's last.
  private pull(): Token {
    for (;;) {
      const lexer = this.lexerStack[this.lexerStack.length - 1];
      const token = this.open ? this.goOnInBracket(lexer) : lexer.lex();
      if (!token) {
        continue;
      }
      this.first ??= token;
      if (lexer.openBracket) {
        const { include, ...open } = lexer.openBracket;
        this.open = { ...open, token };
        lexer.openBracket = undefined;
        if (include !== undefined) {
          this.paste(lexer.readIncludeLine(include));
          continue;
        }
        if (token.type !== TokenType.EOF) {
          continue;
        }
      }
      if (token.type === TokenType.EOF) {
        this.ends.set(lexer.filename, token);
        if (lexer !== this.lexer) {
          this.lexerStack.pop();
          this.takeComments(lexer);
          continue;
        }
      } else if (token.type === TokenType.Punctuator && token.value === '#' && lexer.includeLines?.has(lexer.tokenStart)) {
        this.paste(lexer.readIncludeLine(lexer.tokenStart));
        continue;
      }
      for (let i = this.unplaced.length - 1; i >= 0 && !this.unplaced[i].next; i--) {
        this.unplaced[i].next = token;
      }
      return token;
    }
  }

  // An #include line: the tokens of its file are read next. Wherever the line is, the file is listed in includes, and
  // where a statement can start, the line is a statement too (placeIncludes).
  private paste(line: Token): void {
    // PICO-8 finds the file with every byte up to a space, and every byte of a character that is not ASCII, left out at
    // both ends of the name (3.trailing-spaces, si.line.form.none.sp.vt, si.pin.trim.lead-e-acute), and names it in its
    // error as it is written (si.line.missing.none.sp2.none).
    const written = (line.value as string).slice('#include '.length);
    const filename = written.replace(/^[\0-\x20\x80-\uffff]+|[\0-\x20\x80-\uffff]+$/g, '');
    const statement: IncludeStatement = { type: 'IncludeStatement', filename, loc: boundsClone(line.bounds), included: false };
    this.unplaced.push({ statement });
    // PICO-8 takes the name up to its first colon as the file's, whatever the file is, and the rest as a tab
    // (3.colon-two-p8, 3.colon-before, 3.colon-lua-p8).
    const colon = filename.indexOf(':');
    const name = colon < 0 ? filename : filename.slice(0, colon);
    const resolvedInclude = resolveIncludeFile(this.mainFile, name, this.includeFileResolver);
    statement.resolvedFile = resolvedInclude;
    const pasted = this.codeToPaste(statement, written, name, resolvedInclude, colon < 0 ? undefined : filename.slice(colon + 1));
    if (pasted !== undefined) {
      const lexer = new Lexer(pasted.code, resolvedInclude);
      lexer.pasted = true;
      this.lexerStack.push(lexer);
      this.pasted.set(resolvedInclude, { lexer, line: line.bounds, start: lexer.getCurrentBounds().end });
      this.pasteLines.push(line.bounds.start.index);
      // The main file's lexer has read the line, from its #.
      this.pastes.push({ hash: this.lexer.tokenStart, end: this.lexer.index, lexer, more: pasted.more });
    }
  }

  // PICO-8 pastes a file's text in with two line breaks after it, and a long string or comment, or a short string in
  // the blanks after a \z, goes on through the text so pasted together to its close: one that a pasted file leaves open
  // goes on after its #include line, and one that reaches an #include line that PICO-8 reads (includeLinesOf) goes on
  // in that file (3.open-long-string, 3.open-long-string-codes, 3.open-long-comment-include-closes,
  // 3.alone-code-real-comment, 3.z-include-file). Undefined when there is no token yet: a comment, or an #include line
  // read; the end of a pasted file is its end-of-file token, for pull to go on after it.
  private goOnInBracket(lexer: Lexer): Token | undefined {
    const open = this.open!;
    let reached: 'close' | 'unfinished' | 'end' | 'include';
    let read: string | null = null;
    let close: string;
    if ('quote' in open) {
      ({ reached, value: read } = lexer.readShortString(open.quote, true));
      close = String.fromCharCode(open.quote);
    } else {
      const from = lexer.index;
      reached = lexer.closeLongBracket(open.level);
      close = ']' + '='.repeat(open.level) + ']';
      if (!open.isComment) {
        const breaks = reached === 'end' && lexer !== this.lexer ? '\n\n' : '';
        read = lineFeeds(lexer.input.slice(from, reached === 'close' ? lexer.index - open.level - 2 : lexer.index)) + breaks;
      }
    }
    if (read !== null) {
      open.token.value = (open.token.value as string) + read;
      open.token.quoted = open.token.quoted + read + (reached === 'close' ? close : '');
    }
    if (reached === 'include') {
      this.paste(lexer.readIncludeLine(lexer.index));
      return undefined;
    }
    if (reached === 'end' && lexer !== this.lexer) {
      return lexer.lex();
    }
    this.open = undefined;
    if (reached !== 'close') {
      // One of the main file's own stopped at an #include line, but ends unfinished in it, as Lua reports it.
      if (open.unfinished.bounds.start.filename === lexer.filename) {
        open.unfinished.bounds.end = lexer.getCurrentBounds().end;
      }
      // A short string is quoted as far as it is read, in each file it runs through.
      this.errors.push('quote' in open && open.token.quoted !== undefined
        ? errors.createErr(open.unfinished.bounds, errMessages.unfinishedString, tokenText(open.token)) : open.unfinished);
    }
    if ('isComment' in open && open.isComment) {
      return undefined;
    }
    open.token.bounds = { start: open.token.bounds.start, end: lexer.getCurrentBounds().end };
    return open.token;
  }

  // The #include lines that come right before this.token, at the start of a statement or the end of a block, are
  // statements of the block. One read in the middle of a statement, as for the value after an =, is not.
  private placeIncludes(block: Statement[]): void {
    while (this.unplaced.length > 0 && this.unplaced[0].next !== this.lexer.lookahead) {
      const { statement, next } = this.unplaced.shift()!;
      if (next === this.token) {
        block.push(statement);
      }
    }
  }

  // Whether Lua stops at an error before it is done reading found: one found so far, or one that a lexer has found
  // before there. The main file is read up to found, or up to the #include line of the file that found is in, and each
  // file pasted in before that whole.
  private stoppedBefore(found: Token): boolean {
    if (this.errors.length > 0 || this.gotoErrors.length > 0) {
      return true;
    }
    const errorBefore = (lexer: Lexer, index: number) => lexer.errors.some(error => error.bounds.start.index < index);
    const foundIn = this.pasted.get(found.bounds.start.filename);
    const mainReadTo = foundIn ? foundIn.line.start.index : found.bounds.end.index;
    if (errorBefore(this.lexer, mainReadTo) || (foundIn && errorBefore(foundIn.lexer, found.bounds.end.index))) {
      return true;
    }
    return [ ...this.pasted.values() ].some(({ lexer, line }) => line.start.index < mainReadTo && lexer.errors.length > 0);
  }

  sortErrors() {
    const mainPath = this.mainFile.path;
    // The sort is stable, so errors at the same position keep the order they
    // were found in.
    this.errors.sort((a, b) => {
      const aPath = a.bounds.start.filename.path;
      const bPath = b.bounds.start.filename.path;
      if (aPath !== bPath) {
        if (aPath === mainPath || bPath === mainPath) {
          return aPath === mainPath ? -1 : 1;
        }
        return aPath < bPath ? -1 : 1;
      }
      return a.bounds.start.index - b.bounds.start.index;
    });
  }

  // A block contains a list of statements with an optional return statement
  // as its last statement.
  //
  //     block ::= {stat} [retstat]

  parseBlock(flowContext: FlowContext, endingFunction: (token: Token) => boolean = isBlockFollow): Block {
    const block: Statement[] = [];
    this.placeIncludes(block);
    this.pushLocation(block.length > 0 ? new Marker(block[0].loc!) : this.createLocationMarker());

    // A newline is a token only in a one-line statement, whose line ends every block in it, as in PICO-8.
    const ends = (token: Token) => endingFunction(token) || token.type === TokenType.Newline;
    while (!ends(this.token)) {
      const locationDepth = this.locations.length;
      const levels = this.levels;

      try {
        if (++this.levels > MAX_LEVELS) {
          this.tooManyLevels();
        }
        const statement = this.parseStatement(flowContext);
        this.levels--;

        // Statements are only added if they are returned, this allows us to
        // ignore some statements, such as EmptyStatement.
        if (statement) {
          block.push(statement);
        }
        // A return is the last statement of its block, and has taken its own ;: what follows it is for the block's
        // closer to report.
        if (statement?.type === 'ReturnStatement') {
          if (!endingFunction(this.token)) {
            break;
          }
        } else {
          // optional semicolon ending the statement
          this.lexer.consume(';');
        }
      } catch (e) {
        if (errors.isParseError(e)) {
          // A statement that throws part-way through leaves its location
          // markers and nesting levels behind: the nodes around it would get
          // the wrong start, and later statements would count as nested in it.
          this.locations.length = locationDepth;
          this.levels = levels;

          // Caught a parse error. Add it to errors and synchronize.
          this.errors.push(e);

          // Discard tokens until we get to the end of the line or end of the block
          const prevNewlineSignificant = this.lexer.newlineSignificant;
          this.lexer.newlineSignificant = true;
          while (this.token.type !== TokenType.Newline && !endingFunction(this.token)) {
            this.lexerNext();
          }

          this.lexer.newlineSignificant = prevNewlineSignificant;

          if (this.token.type === TokenType.Newline && !endingFunction(this.token)) {
            // If we got to a newline, consume the newline token and continue parsing.
            this.lexerNext();
          } else {
          // Otherwise we got to the end of the block so we should stop.
            break;
          }

        } else {
          // whoops, it was some other error, shouldn't have caught it
          throw e;
        }
      }
      this.placeIncludes(block);
    }
    this.placeIncludes(block);

    // A label right before `until` is not at the end of its block for Lua, which checks the gotos to it there.
    if (this.token.type === TokenType.Keyword && this.token.value === 'until') {
      flowContext.raiseDeferredErrors(this.token);
    }

    return this.finishNode(AST.block(block), true);
  }

  private codeToPaste(statement: IncludeStatement, written: string, name: string, resolvedInclude: ResolvedFile, tabSuffix?: string)
    : { code: Code, more?: number } | undefined {
    if (this.includeParses >= MAX_INCLUDE_PARSES) {
      if (!this.reportedTooManyIncludeParses) {
        this.reportedTooManyIncludeParses = true;
        this.errors.push(new errors.ParseError(`too many #includes (limit is ${MAX_INCLUDE_PARSES})`, statement.loc!));
      }
      return undefined;
    }

    // PICO-8 does not open these names, whatever is on the disk (si.line.name.leading-slash,
    // si.line.name.trailing-slash, si.line.name.char.e-acute).
    const unopened = name.startsWith('/') ? 'PICO-8 does not open a name that starts with / from the cart\'s folder'
      : /[\\/]$/.test(name) ? 'PICO-8 does not open a name that ends with / or \\'
        : /[^\0-\x7f]/.test(name) ? 'PICO-8 does not open a name with a character that is not ASCII' : undefined;
    if (unopened !== undefined) {
      this.errors.push(this.getIncludeStatementError(statement, written, unopened));
      return undefined;
    }

    if (!this.includeFileResolver.doesFileExist(resolvedInclude.path)) {
      return this.unresolvedInclude(statement, written, resolvedInclude, 'File does not exist');
    }

    let fileContents: string;
    try {
      if (!this.includeFileResolver.isFile(resolvedInclude.path)) {
        return this.unresolvedInclude(statement, written, resolvedInclude, 'File cannot be read (is it a directory?)');
      }
      fileContents = this.includeFileResolver.loadFileContents(resolvedInclude.path);
    } catch (e) {
      // The file can be locked, lose its permissions or go away after it was
      // found; that is an error in this file, not a reason to lose the parse.
      const reason = (e as NodeJS.ErrnoException | null)?.code ?? (e instanceof Error ? e.message : String(e));
      return this.unresolvedInclude(statement, written, resolvedInclude, `File cannot be read (${reason})`);
    }

    this.includes.push({ stmt: statement, resolvedFile: resolvedInclude });
    const included = includedCode(readCode(fileContents), resolvedInclude.path, tabSuffix !== undefined ? tabIndex(tabSuffix) : undefined);
    if (typeof included === 'number') {
      this.errors.push(this.getIncludeStatementError(statement, written, `${path.basename(resolvedInclude.path)} has no tab ${included}`));
      return undefined;
    }
    this.includeParses++;
    return included;
  }

  private unresolvedInclude(statement: IncludeStatement, written: string, resolvedInclude: ResolvedFile, reason: string): undefined {
    this.errors.push(this.getIncludeStatementError(statement, written, reason));
    this.unresolvedIncludes.push(resolvedInclude);
    return undefined;
  }

  // A block still open at the end of the file keeps what it read, and its node reaches the end of the file, where the
  // code is being typed. Its error is the one Lua gives there.
  private expectBlockEnd(closer: 'end' | 'until', opener: Bounds, word: string): boolean {
    if (this.token.type === TokenType.EOF) {
      this.errors.push(this.blockEndError(closer, opener, word));
      return false;
    }
    if (this.token.type !== TokenType.Keyword || this.token.value !== closer) {
      throw this.blockEndError(closer, opener, word);
    }
    this.lexerNext();
    return true;
  }

  // The opener's line is given with its file when the end is missing in another file, where it would read as a line of
  // that one.
  private blockEndError(closer: 'end' | 'until', opener: Bounds, word: string): errors.ParseError {
    const { line, filename } = opener.start;
    return filename.equals(this.token.bounds.start.filename)
      ? errors.createErrForToken(this.token, errMessages.expectedToClose, closer, word, line, tokenText(this.token))
      : errors.createErrForToken(this.token, errMessages.expectedToCloseInFile, closer, word, line, path.basename(filename.path), tokenText(this.token));
  }

  // There are two types of statements, simple and compound.
  //
  //     statement ::= break | goto | do | while | repeat | return
  //          | if | for | | local | label | assignment
  //          | functioncall | ';'

  parseStatement(flowContext: FlowContext): Statement | null {
    this.markLocation();

    if (this.token.type === TokenType.Punctuator) {
      if (this.lexer.consume('::')) {
        return this.parseLabelStatement(flowContext);
      }
    }

    // When a `;` is encounted, simply eat it without storing it.
    if (this.lexer.consume(';')) {
      this.popLocation();
      return null;
    }

    flowContext.raiseDeferredErrors(this.token);

    if (this.token.type === TokenType.Keyword) {
      switch (this.token.value) {
      case 'local':    this.lexerNext(); return this.parseLocalStatement(flowContext);
      case 'if':       this.lexerNext(); return this.parseIfStatement(flowContext);
      case 'return':   this.lexerNext(); return this.parseReturnStatement(flowContext);
      case 'function': this.lexerNext();
        const name = this.parseFunctionName(flowContext);
        return this.parseFunctionDeclaration(name, false, flowContext);
      case 'while':    this.lexerNext(); return this.parseWhileStatement(flowContext);
      case 'for':      this.lexerNext(); return this.parseForStatement(flowContext);
      case 'repeat':   this.lexerNext(); return this.parseRepeatStatement(flowContext);
      case 'break':
        flowContext.addBreak(this.token);
        this.lexerNext();
        return this.parseBreakStatement();
      case 'do':       this.lexerNext(); return this.parseDoStatement(flowContext);
      case 'goto':     this.lexerNext(); return this.parseGotoStatement(flowContext);
      }
    }

    if (this.token.type === TokenType.Punctuator) {
      switch (this.token.value) {
      // special ? print function
      case '?':
        this.lexerNext();
        return this.finishNode(AST.callStatement(this.parsePrint(new Marker(this.previousToken), flowContext)));
      }
    }

    // Assignments memorizes the location and pushes it manually for wrapper nodes.
    this.popLocation();

    return this.parseAssignmentOrCallStatement(flowContext);
  }

  // ## Statements

  //     label ::= '::' Name '::'

  parseLabelStatement(flowContext: FlowContext): LabelStatement {
    const nameToken = this.token;
    const label = this.parseIdentifier();

    // Before the `::`, as Lua finds the name taken before it reads on.
    flowContext.addLabel(nameToken.value as string, nameToken, this.token);
    this.lexer.expect('::');

    return this.finishNode(AST.labelStatement(label));
  }

  //     break ::= 'break'

  parseBreakStatement(): BreakStatement {
    this.lexer.consume(';');
    return this.finishNode(AST.breakStatement());
  }

  //     goto ::= 'goto' Name

  parseGotoStatement(flowContext: FlowContext): GotoStatement {
    const name = this.token.value as string;
    const gotoToken = this.previousToken;
    const label = this.parseIdentifier();

    flowContext.addGoto(name, gotoToken);
    return this.finishNode(AST.gotoStatement(label));
  }

  //     do ::= 'do' block 'end'

  parseDoStatement(flowContext: FlowContext): DoStatement {
    const opener = this.locations[this.locations.length - 1].loc;
    flowContext.pushScope();
    const body = this.parseBlock(flowContext);
    flowContext.popScope();
    const closed = this.expectBlockEnd('end', opener, 'do');
    return this.finishNode(AST.doStatement(body), !closed);
  }

  //     while ::= 'while' exp 'do' block 'end'

  parseWhileStatement(flowContext: FlowContext): WhileStatement {
    const opener = this.locations[this.locations.length - 1].loc;
    const keyword = this.previousToken;
    let body: Block | undefined;
    let closed = true;

    const startsWithParen = this.token.value === '(';
    const condition = this.parseExpectedExpression(flowContext);

    if (this.lexer.consume('do')) {
      // regular while statement with `do` ... `end`
      // (we already consumed the `do`)
      body = this.parseWhileStatementBody(flowContext);
      closed = this.expectBlockEnd('end', opener, 'while');
    } else if (startsWithParen && this.isOneLineBody(condition, keyword)) {
      this.lexer.withSignificantNewline(() => {
        body = this.parseWhileStatementBody(flowContext, isEndOfLine);
        this.expectEndOfLine();
      });
    } else {
      errors.raiseErrForToken(this.token, errMessages.expected, 'do', tokenText(this.token));
    }

    return this.finishNode(AST.whileStatement(condition, body!), !closed);
  }

  // PICO-8 reads if (c) and while (c) as one-line forms when what follows the condition starts on the line of the if or
  // while, unless the condition ends with a ) that is not the one after c: (a)(f)() and (a) or f() need their then
  // (4.if.paren-body, 4.if.paren-or-call), (a).x and (f)"s" do not (4.if.paren-field, 4.if.paren-string-call).
  private isOneLineBody(condition: Expression, keyword: Token): boolean {
    const endsWithParen = this.previousToken.type === TokenType.Punctuator && this.previousToken.value === ')';
    return this.token.type !== TokenType.EOF && this.token.type !== TokenType.Newline && onOneLine(keyword, this.token)
      && (!endsWithParen || !!condition.parens);
  }

  // A one-line body stops at the end of its line or at a word that ends a block; a return that is not last stops it
  // anywhere.
  private expectEndOfLine(): void {
    if (!isEndOfLine(this.token)) {
      errors.raiseErrForToken(this.token, errMessages.endOfLineExpected, tokenText(this.token));
    }
  }

  parseWhileStatementBody(flowContext: FlowContext, endingFunction?: (token: Token) => boolean) {
    flowContext.pushScope(true);
    const body = this.parseBlock(flowContext, endingFunction);
    flowContext.popScope();

    return body;
  }

  //     repeat ::= 'repeat' block 'until' exp

  parseRepeatStatement(flowContext: FlowContext): RepeatStatement {
    const opener = this.locations[this.locations.length - 1].loc;
    flowContext.pushScope(true);
    const body = this.parseBlock(flowContext);
    const closed = this.expectBlockEnd('until', opener, 'repeat');
    let condition: Expression;
    if (closed) {
      condition = this.parseExpectedExpression(flowContext);
    } else {
      condition = AST.literal(TokenType.NilLiteral, null, 'nil');
    }
    flowContext.popScope();
    return this.finishNode(AST.repeatStatement(condition, body), !closed);
  }

  //     retstat ::= 'return' [exp {',' exp}] [';']

  parseReturnStatement(flowContext: FlowContext): ReturnStatement {
    const expressions = [];

    if ('end' !== this.token.value) {
      let expression = this.parseExpression(flowContext);
      if (null != expression) {
        expressions.push(expression);
      }
      while (this.lexer.consume(',')) {
        expression = this.parseExpectedExpression(flowContext);
        expressions.push(expression);
      }
      this.lexer.consume(';'); // grammar tells us ; is optional here.
    }
    return this.finishNode(AST.returnStatement(expressions));
  }

  //     if ::= 'if' exp 'then' block {elif} ['else' block] 'end'
  //     elif ::= 'elseif' exp 'then' block
  //
  // PICO-8 one-line if statement (see isOneLineBody), whose blocks end at the end of the line or at a word that ends a
  // block:
  //     if ::= 'if' exp block {elif} ['else' block]

  parseIfStatement(flowContext: FlowContext): IfStatement {
    const opener = this.locations[this.locations.length - 1].loc;
    const keyword = this.previousToken;
    const clauses: GeneralIfClause[] = [];
    let condition: Expression;
    let body;

    let marker = this.locations[this.locations.length - 1];
    this.pushLocation(marker);

    const startsWithParen = this.token.value === '(';

    condition = this.parseExpectedExpression(flowContext);

    if (!this.lexer.consume('then') && !this.lexer.consume('do')) {
      if (startsWithParen && this.isOneLineBody(condition, keyword)) {

        // Tell formatter not to use outer parens on the condition expression, since they'll
        // be added anyway for a one-line if statement
        condition.parens = false;

        // In PICO-8 any clause can be empty, an else at the end of the line too.
        this.lexer.withSignificantNewline(() => {
          flowContext.pushScope();
          const block = this.parseBlock(flowContext, isEndOfLine);
          flowContext.popScope();
          clauses.push(this.finishNode(AST.ifClause(condition, block)));
          this.expectEndOfLine();

          while (this.token.value === 'elseif') {
            this.pushLocation(this.createLocationMarker());
            this.lexerNext();
            const elseifCondition = this.parseExpectedExpression(flowContext);
            if (!this.lexer.consume('then') && !this.lexer.consume('do')) {
              errors.raiseErrForToken(this.token, errMessages.expected, 'then', tokenText(this.token));
            }
            flowContext.pushScope();
            const elseifBlock = this.parseBlock(flowContext, isEndOfLine);
            flowContext.popScope();
            clauses.push(this.finishNode(AST.elseifClause(elseifCondition, elseifBlock), true));
            this.expectEndOfLine();
          }

          if (this.lexer.consume('else')) {
            // Include the `else` in the location of ElseClause.
            this.pushLocation(new Marker(this.previousToken));
            flowContext.pushScope();
            const elseBlock = this.parseBlock(flowContext, isEndOfLine);
            flowContext.popScope();
            clauses.push(this.finishNode(AST.elseClause(elseBlock), true));
            this.expectEndOfLine();
          }
        });

        return this.finishNode(AST.ifStatement(clauses, true));
      } else {
        errors.raiseErrForToken(this.token, errMessages.expected, 'then', tokenText(this.token));
      }
    }

    flowContext.pushScope();
    body = this.parseBlock(flowContext);
    flowContext.popScope();
    clauses.push(this.finishNode(AST.ifClause(condition, body), true));
    marker = this.createLocationMarker();

    while (this.lexer.consume('elseif')) {
      this.pushLocation(marker);
      condition = this.parseExpectedExpression(flowContext);

      if (!this.lexer.consume('then') && !this.lexer.consume('do')) {
        errors.raiseErrForToken(this.token, errMessages.expected, 'then', tokenText(this.token));
      }

      flowContext.pushScope();
      body = this.parseBlock(flowContext);
      flowContext.popScope();
      clauses.push(this.finishNode(AST.elseifClause(condition, body), true));
      marker = this.createLocationMarker();
    }

    if (this.lexer.consume('else')) {
      // Include the `else` in the location of ElseClause.
      marker = new Marker(this.previousToken);
      this.pushLocation(marker);
      flowContext.pushScope();
      body = this.parseBlock(flowContext);
      flowContext.popScope();
      clauses.push(this.finishNode(AST.elseClause(body), true));
    }

    const closed = this.expectBlockEnd('end', opener, 'if');
    return this.finishNode(AST.ifStatement(clauses, false), !closed);
  }

  // There are two types of for statements, generic and numeric.
  //
  //     for ::= Name '=' exp ',' exp [',' exp] 'do' block 'end'
  //     for ::= namelist 'in' explist 'do' block 'end'
  //     namelist ::= Name {',' Name}
  //     explist ::= exp {',' exp}

  parseForStatement(flowContext: FlowContext): ForGenericStatement | ForNumericStatement {
    const opener = this.locations[this.locations.length - 1].loc;
    let variable = this.parseIdentifier();
    let body;

    // Lua declares the 3 hidden variables of either loop and its first name here.
    if ([ '=', ',', 'in' ].includes(this.token.value as string)) {
      this.checkVariables(flowContext, 4);
    }

    // If the first expression is followed by a `=` punctuator, this is a
    // Numeric For Statement.
    if (this.lexer.consume('=')) {
      // Start expression
      const start = this.parseExpectedExpression(flowContext);
      this.lexer.expect(',');
      // End expression
      const end = this.parseExpectedExpression(flowContext);
      // Optional step expression
      const step = this.lexer.consume(',') ? this.parseExpectedExpression(flowContext) : null;

      this.lexer.expect('do');
      flowContext.pushScope(true);
      this.addVariables(flowContext, [ '(for index)', '(for limit)', '(for step)', variable.name ]);
      body = this.parseBlock(flowContext);
      flowContext.popScope();
      const closed = this.expectBlockEnd('end', opener, 'for');

      return this.finishNode(AST.forNumericStatement(variable, start, end, step, body), !closed);
    // If not, it's a Generic For Statement
    } else {
      // The namelist can contain one or more identifiers.
      const variables = [ variable ];
      while (this.lexer.consume(',')) {
        variable = this.parseIdentifier();
        variables.push(variable);
        this.checkVariables(flowContext, 3 + variables.length);
      }
      this.lexer.expect('in');
      const iterators: Expression[] = [];

      // One or more expressions in the explist.
      do {
        const expression = this.parseExpectedExpression(flowContext);
        iterators.push(expression);
      } while (this.lexer.consume(','));

      this.lexer.expect('do');
      flowContext.pushScope(true);
      this.addVariables(flowContext, [ '(for generator)', '(for state)', '(for control)', ...variables.map(v => v.name) ]);
      body = this.parseBlock(flowContext);
      flowContext.popScope();
      const closed = this.expectBlockEnd('end', opener, 'for');

      return this.finishNode(AST.forGenericStatement(variables, iterators, body), !closed);
    }
  }

  // Local statements can either be variable assignments or function
  // definitions. If a definition is found, it will be delegated to
  // `parseFunctionDeclaration()` with the isLocal flag.
  //
  // This AST structure might change into a local assignment with a function
  // child.
  //
  //     local ::= 'local' 'function' Name funcdecl
  //        | 'local' Name {',' Name} ['=' exp {',' exp}]

  parseLocalStatement(flowContext: FlowContext): LocalStatement | FunctionDeclaration {
    let name: Identifier;
    const declToken = this.previousToken;

    if (this.token.type === TokenType.Identifier) {
      const variables = [],
        init = [];

      do {
        name = this.parseIdentifier();

        variables.push(name);
        flowContext.addLocal(name.name, declToken);
        this.checkVariables(flowContext, variables.length);
      } while (this.lexer.consume(','));

      let operator: string | undefined = undefined;
      if (this.lexer.consume('=')) {
        operator = '=';

        do {
          const expression = this.parseExpectedExpression(flowContext);
          init.push(expression);
        } while (this.lexer.consume(','));
      }

      this.addVariables(flowContext, variables.map(variable => variable.name));
      return this.finishNode(AST.localStatement(variables, operator, init));
    }
    if (this.lexer.consume('function')) {
      name = this.parseIdentifier();
      flowContext.addLocal(name.name, declToken);
      this.checkVariables(flowContext, 1);
      this.addVariables(flowContext, [ name.name ]);

      // MemberExpressions are not allowed in local statements.
      return this.parseFunctionDeclaration(name, true, flowContext);
    } else {
      errors.raiseUnexpectedToken('<name>', this.token);
    }
  }

  //     assignment ::= letlist '=' explist | prefixexp compoundop explist
  //     compoundop ::= '+=' | '-=' | '*=' | '/=' | '\=' | '%=' | '^=' | '..=' | '|=' | '&=' | '^^='
  //          | '<<=' | '>>=' | '>>>=' | '<<>=' | '>><='
  //     let ::= Name | prefixexp '[' exp ']' | prefixexp '.' Name
  //     letlist ::= let {',' let}
  //     explist ::= exp {',' exp}
  //
  //     call ::= callexp
  //     callexp ::= prefixexp args | prefixexp ':' Name args

  parseAssignmentOrCallStatement(flowContext: FlowContext): AssignmentStatement | CallStatement {
    let marker: Marker;
    let lvalue, base;

    const targets: Expression[] = [];

    const startMarker = this.createLocationMarker();

    do {
      marker = this.createLocationMarker();

      if (this.token.type === TokenType.Identifier) {
        base = this.parseIdentifier();
        this.useName(flowContext, base.name);
        lvalue = true;
      } else if ('(' === this.token.value) {
        this.lexerNext();
        base = this.parseExpectedExpression(flowContext);
        this.lexer.expect(')');
        lvalue = false;
      } else {
        this.unexpectedToken(this.token);
      }

      both: while (true) {
        switch (this.token.type === TokenType.StringLiteral ? '"' : this.token.value) {
        case '.':
        case '[':
          lvalue = true;
          break;
        case ':':
        case '(':
        case '{':
        case '"':
          lvalue = null;
          break;
        default:
          break both;
        }

        base = this.parsePrefixExpressionPart(base as Identifier, marker, flowContext);
      }

      targets.push(base!);
      // PICO-8, as Lua 5.2, counts each target after the first as a level (lparser.c, assignment).
      if (targets.length - 1 + this.levels > MAX_LEVELS) {
        this.tooManyLevels();
      }

      if (',' !== this.token.value) {
        break;
      }

      if (!lvalue) {
        this.unexpectedToken(this.token);
      }

      this.lexerNext();
    } while (true);

    // PICO-8 takes a compound operator, such as +=, after one target of any kind, a call too.
    const compound = isAssignmentOperator(this.token) && this.token.value !== '=';
    let hidden = 0;
    if (compound && targets.length === 1) {
      // The brackets are kept because PICO-8 assigns to nothing then: (a)+=1 leaves a as it is.
      if (lvalue === false) {
        targets[0].parens = true;
      }
      hidden = this.compoundVariables(flowContext, targets[0]);
      this.checkVariables(flowContext, hidden, this.token);
    } else if (targets.length === 1 && lvalue === null) {
      this.pushLocation(marker);
      return this.finishNode(AST.callStatement(targets[0]));
    } else if (!lvalue) {
      this.unexpectedToken(this.token);
    } else if (compound) {
      errors.raiseErrForToken(this.token, errMessages.expected, '=', tokenText(this.token));
    }

    if (!isAssignmentOperator(this.token)) {
      errors.raiseUnexpectedToken('assignment operator', this.token);
    }
    const operator = this.token.value as string;
    this.lexerNext();

    const values = [];
    do {
      values.push(this.parseExpectedExpression(flowContext));
    }
    while (this.lexer.consume(','));

    this.addVariables(flowContext, Array.from({ length: hidden }, () => ''));
    this.pushLocation(startMarker);
    return this.finishNode(AST.assignmentStatement(targets, operator, values));
  }

  // The ? just read, which the marker is at, as a call of its arguments.
  private parsePrint(marker: Marker, flowContext: FlowContext): CallExpression {
    this.pushLocation(marker);
    const base = this.finishNode(AST.identifier('?'));
    this.pushLocation(marker);
    return this.finishNode(AST.callExpression(base, this.parsePrintArguments(flowContext)));
  }

  // PICO-8's ? takes the rest of its line, as a statement or as a value, and the rest can be empty
  // (si.pin.print.alone-eof, si.pin.print.alone-next-value).
  private parsePrintArguments(flowContext: FlowContext): Expression[] {
    const args: Expression[] = [];
    if (this.printsNothing()) {
      return args;
    }
    this.lexer.withSignificantNewline(() => {
      do {
        args.push(this.parseExpectedExpression(flowContext));
      } while (this.lexer.consume(','));
      if (this.token.type !== TokenType.Newline && this.token.type !== TokenType.EOF) {
        errors.raiseErrForToken(this.token, errMessages.endOfLineExpected, tokenText(this.token));
      }
    });
    return args;
  }

  // Whether nothing comes after the ? just read on its line; the token read after it can be on a later line.
  private printsNothing(): boolean {
    return this.token.type === TokenType.Newline || this.token.type === TokenType.EOF || !onOneLine(this.previousToken, this.token);
  }

  getIncludeStatementError(statement: IncludeStatement, written: string, errorMessage: string) {
    return new errors.ParseError(`Can't #include "${written}" from ${path.basename(this.mainFile.path)}: ${errorMessage}`, statement.loc!);
  }

  // ### Non-statements

  //     Identifier ::= Name

  parseIdentifier(): Identifier {
    this.markLocation();
    const identifier = this.token.value as string;
    if (this.token.type !== TokenType.Identifier) {
      errors.raiseUnexpectedToken('<name>', this.token);
    }
    this.lexerNext();
    return this.finishNode(AST.identifier(identifier));
  }

  // Parse the functions parameters and body block. The name should already
  // have been parsed and passed to this declaration function. By separating
  // this we allow for anonymous functions in expressions.
  //
  // For local functions there's a boolean parameter which needs to be set
  // when parsing the declaration.
  //
  //     funcdecl ::= '(' [parlist] ')' block 'end'
  //     parlist ::= Name {',' Name} | [',' '...'] | '...'

  parseFunctionDeclaration(name: Identifier | MemberExpression | null, isLocal: boolean, outer: FlowContext): FunctionDeclaration {
    const opener = this.locations[this.locations.length - 1].loc;
    const flowContext = new FlowContext(this.gotoErrors, found => this.stoppedBefore(found), outer, opener.start, MAX_UPVALUES);
    flowContext.pushScope();

    const parameters = [];
    if (name?.type === 'MemberExpression' && name.indexer === ':') {
      this.addVariables(flowContext, [ 'self' ]);
    }
    this.lexer.expect('(');

    // The declaration has arguments
    if (!this.lexer.consume(')')) {
      // Arguments are a comma separated list of identifiers, optionally ending
      // with a Vararg.
      do {
        if (this.token.type === TokenType.Identifier) {
          const parameter = this.parseIdentifier();
          parameters.push(parameter);
          this.checkVariables(flowContext, 1);
          this.addVariables(flowContext, [ parameter.name ]);
        } else if (this.token.type === TokenType.VarargLiteral) {
          flowContext.allowVararg = true;
          parameters.push(this.parsePrimaryExpression(flowContext) as VarargLiteral);
          // No arguments are allowed after a Vararg.
          break;
        } else if (endsParameterList(this.token)) {
          // Reported as a missing ')' below.
          break;
        } else {
          this.errors.push(errors.createErrForToken(this.token, errMessages.expectedToken, '<name> or \'...\'', tokenText(this.token)));

          // Discard tokens until we get a ')' or ','
          while (this.token.value !== ')' && this.token.value !== ',' && !endsParameterList(this.token)) {
            this.lexerNext();
          }

        }
      } while (this.lexer.consume(','));

      if (!this.lexer.consume(')')) {
        this.errors.push(errors.createErrForToken(this.token, errMessages.expected, ')', tokenText(this.token)));

        // Discard tokens until we get a ')'
        while (this.token.value !== ')' && !endsParameterList(this.token)) {
          this.lexerNext();
        }
        this.lexer.consume(')');
      }
    }

    const body = this.parseBlock(flowContext);
    const closed = this.expectBlockEnd('end', opener, 'function');
    flowContext.endFunction(this.token);

    isLocal = isLocal || false;
    return this.finishNode(AST.functionStatement(name, parameters, isLocal, body), !closed);
  }

  // Parse the name as identifiers and member expressions.
  //
  //     Name {'.' Name} [':' Name]

  parseFunctionName(flowContext: FlowContext) {
    let base, name;

    const marker = this.createLocationMarker();
    base = this.parseIdentifier();
    this.useName(flowContext, base.name);

    while (this.lexer.consume('.')) {
      this.pushLocation(marker);
      name = this.parseIdentifier();
      base = this.finishNode(AST.memberExpression(base, '.', name));
    }

    if (this.lexer.consume(':')) {
      this.pushLocation(marker);
      name = this.parseIdentifier();
      base = this.finishNode(AST.memberExpression(base, ':', name));
    }

    return base;
  }

  //     tableconstructor ::= '{' [fieldlist] '}'
  //     fieldlist ::= field {fieldsep field} fieldsep
  //     field ::= '[' exp ']' '=' exp | Name = 'exp' | exp
  //
  //     fieldsep ::= ',' | ';'

  parseTableConstructor(flowContext: FlowContext): TableConstructorExpression {
    const fields = [];
    let key, value;

    while (true) {
      this.markLocation();
      if (this.token.type === TokenType.Punctuator && this.lexer.consume('[')) {
        key = this.parseExpectedExpression(flowContext);
        this.lexer.expect(']');
        this.lexer.expect('=');
        value = this.parseExpectedExpression(flowContext);
        fields.push(this.finishNode(AST.tableKey(key, value)));
      } else if (this.token.type === TokenType.Identifier) {
        if ('=' === this.lexer.lookahead!.value) {
          key = this.parseIdentifier();
          this.lexerNext();
          value = this.parseExpectedExpression(flowContext);
          fields.push(this.finishNode(AST.tableKeyString(key, value)));
        } else {
          value = this.parseExpectedExpression(flowContext);
          fields.push(this.finishNode(AST.tableValue(value)));
        }
      } else {
        if (null == (value = this.parseExpression(flowContext))) {
          if (this.token.type === TokenType.Punctuator && (this.token.value === ',' || this.token.value === ';')) {
            errors.raiseUnexpectedToken('<expression>', this.token);
          }
          this.popLocation();
          break;
        }
        fields.push(this.finishNode(AST.tableValue(value)));
      }
      if (',;'.indexOf(this.token.value as string) >= 0) {
        this.lexerNext();
        continue;
      }
      break;
    }
    this.lexer.expect('}');
    return this.finishNode(AST.tableConstructorExpression(fields));
  }

  // Expression parser
  // -----------------
  //
  //     exp ::= (unop exp | primary | prefixexp ) { binop exp }
  //
  //     primary ::= nil | false | true | Number | String | '...'
  //          | functiondef | tableconstructor | '?' explist
  //
  //     prefixexp ::= (Name | '(' exp ')' ) { '[' exp ']'
  //          | '.' Name | ':' Name args | args }
  //

  parseExpression(flowContext: FlowContext): Expression | null {
    return this.parseSubExpression(0, flowContext);
  }

  // Parse an expression expecting it to be valid.

  parseExpectedExpression(flowContext: FlowContext): Expression {
    const expression = this.parseExpression(flowContext);
    if (null == expression) {
      errors.raiseUnexpectedToken('<expression>', this.token);
    } else {
      return expression;
    }
  }

  // The level is counted around the whole parse so that every return leaves
  // it. A throw does not: the parseBlock that catches it restores the count.
  // This runs for every expression, so the check is inline and tooManyLevels
  // is only called past the limit.
  // Some callers try for an expression that may not be there (`f()`, `{}`, a
  // bare `return`). Lua 5.2 looks for `)`, `}` or the end of the block first
  // and enters no level, so a level with no expression in it is not reported.
  parseSubExpression(minPrecedence: number, flowContext: FlowContext): Expression | null {
    if (++this.levels > MAX_LEVELS && canStartExpression(this.token)) {
      this.tooManyLevels();
    }
    const expression = this.parseSubExpressionInLevel(minPrecedence, flowContext);
    this.levels--;
    return expression;
  }

  // declared: how many variables the statement has declared so far, this one among them; Lua counts them from where
  // they are declared, though they are in scope only after it (lparser.c, new_localvar).
  private checkVariables(flowContext: FlowContext, declared: number, at = this.previousToken): void {
    if (!flowContext.reportedTooManyVariables && flowContext.activeVariables() + declared > MAX_VARIABLES) {
      flowContext.reportedTooManyVariables = true;
      this.errors.push(errors.createErrForToken(at, errMessages.tooManyVariables, MAX_VARIABLES, functionNamed(flowContext, at), tokenText(this.token)));
    }
  }

  private addVariables(flowContext: FlowContext, names: string[]): void {
    const variables = flowContext.currentScope().variables;
    for (const name of names) {
      variables.push({ name });
    }
  }

  // A name that is not a local of this function is an upvalue of it and of each function between it and the one that
  // declares the name. A global is found through the name _ENV in the same way: a local _ENV, or else the main
  // function's _ENV, which holds the globals (lparser.c, singlevar). Lua makes the outermost upvalue first, and stops
  // there when it is one too many. Only counted in a function nested in others with enough locals to take it past the
  // limit.
  private useName(flowContext: FlowContext, name: string): void {
    if (flowContext.upvalues === null) {
      return;
    }
    let { variable, below } = declaration(flowContext, name);
    if (!variable && name !== '_ENV') {
      ({ variable, below } = declaration(flowContext, '_ENV'));
    }
    const upvalue: LocalVariable | 'ENV' = variable ?? 'ENV';
    let reported = false;
    for (let i = below.length - 1; i >= 0; i--) {
      const context = below[i];
      if (context.upvalues === null) {
        continue;
      }
      context.upvalues.add(upvalue);
      if (context.upvalues.size > MAX_UPVALUES && !context.reportedTooManyUpvalues) {
        context.reportedTooManyUpvalues = true;
        if (!reported) {
          reported = true;
          this.errors.push(errors.createErrForToken(this.previousToken, errMessages.tooManyUpvalues, MAX_UPVALUES, functionNamed(context, this.previousToken),
            tokenText(this.token)));
        }
      }
    }
  }

  // The hidden locals PICO-8 holds to the end of the block for a compound assignment such as t[k] += 1: one for a call,
  // one for the table of a field when it is a global, a call, a field or an index, and one for a key that is not a
  // local and cannot be a constant (2.compound.*). _ENV is a local or the main function's upvalue. Not measured, and
  // counted none: a table of another kind, as a table constructor; a key of only literals and operators, which can be
  // a constant, as 1+1 is folded and ~1 is not; a target in brackets.
  private compoundVariables(flowContext: FlowContext, target: Expression): number {
    if (target.parens) {
      return 0;
    }
    const table = (base: Expression) => (base.type === 'Identifier' ? base.name !== '_ENV' && !declaration(flowContext, base.name).variable
      : [ 'MemberExpression', 'IndexExpression', 'CallExpression', 'StringCallExpression', 'TableCallExpression' ].includes(base.type)) ? 1 : 0;
    switch (target.type) {
    case 'CallExpression': case 'StringCallExpression': case 'TableCallExpression':
      return 1;
    case 'MemberExpression':
      return table(target.base);
    case 'IndexExpression': {
      const key = target.index;
      const local = key.type === 'Identifier' && !!flowContext.variableNamed(key.name);
      return table(target.base) + (local || mayBeConstant(key) ? 0 : 1);
    }
    default:
      return 0;
    }
  }

  // A cart whose code has more characters than PICO-8 loads, or, when it loads, whose code with its #include files
  // pasted in has more than PICO-8 runs. PICO-8 names no place in the code: the error is on its first token.
  private checkCharacters(): void {
    const { code: main, end, lostLineBreak } = this.code;
    const own = characterCount(main);
    if (own === undefined) {
      return;
    }
    const first = this.first!;
    // PICO-8 counts the line break that the code is read without, before a section or a CR that ends the file, and 2
    // more when the code ends without one (5.chars.gfx, 5.chars.cr-end-*, 5.chars.no-final-newline).
    const loaded = own + (end !== undefined || lostLineBreak ? 1 : main.endsWith('\n') ? 0 : 2);
    if (loaded > MAX_CHARACTERS) {
      this.errors.push(errors.createErrForToken(first, errMessages.codeTooLong, loaded, MAX_CHARACTERS));
      return;
    }
    const includeLines = this.lexer.includeLines;
    if (!includeLines) {
      return;
    }
    // PICO-8 counts the lines of the code with a line break between each two, each #include line replaced by the
    // characters it counts for the file, and one more when the last line is an #include line (5.chars.include-*). The
    // count is left out when that of a file is not known, or a file is not pasted in.
    const files = new Map(this.pastes.map(({ hash, lexer, more }) => {
      const code = more === undefined ? undefined : characterCount(lexer.input);
      return [ hash, code === undefined || more === undefined ? undefined : code + more ];
    }));
    const lastBreak = end === undefined && main.endsWith('\n');
    let lastLine = lastBreak ? main.length - (main.endsWith('\r\n') ? 2 : 1) : main.length;
    while (lastLine > 0 && main.charCodeAt(lastLine - 1) !== 10 && main.charCodeAt(lastLine - 1) !== 13) {
      lastLine--;
    }
    let characters = own - (lastBreak ? 1 : 0);
    for (const hash of includeLines) {
      const file = files.get(hash);
      if (file === undefined) {
        return;
      }
      let lineStart = hash;
      while (lineStart > 0 && (main.charCodeAt(lineStart - 1) === 32 || main.charCodeAt(lineStart - 1) === 9)) {
        lineStart--;
      }
      characters += file - characterCount(main.slice(lineStart, lineEnd(main, hash)))! + (lineStart === lastLine ? 1 : 0);
    }
    if (characters > MAX_CHARACTERS) {
      this.errors.push(errors.createErrForToken(first, errMessages.programTooLong, characters, MAX_CHARACTERS));
    }
  }

  // PICO-8 counts the tokens of a cart with its #include files pasted in, each in place of its line with two line
  // breaks after it, and reports the count when it is over the limit; the error is on the token one too many.
  private checkTokens(): void {
    const parts: { at: number, lexer: Lexer, from: number, length: number }[] = [];
    let code = '';
    const add = (lexer: Lexer, from: number, to: number) => {
      parts.push({ at: code.length, lexer, from, length: to - from });
      code += lexer.input.slice(from, to);
    };
    let from = 0;
    for (const { hash, end, lexer } of this.pastes) {
      add(this.lexer, from, hash);
      add(lexer, 0, lexer.input.length);
      code += '\n\n';
      from = end;
    }
    add(this.lexer, from, this.lexer.input.length);
    const { count, over } = countTokens(code, MAX_TOKENS);
    if (over) {
      let k = parts.length - 1;
      while (parts[k].at > over.start) {
        k--;
      }
      const { at, lexer, from: offset, length } = parts[k];
      const bounds = { start: lexer.locationAt(offset + over.start - at, false), end: lexer.locationAt(offset + Math.min(over.end - at, length), true) };
      this.errors.push(errors.createErr(bounds, errMessages.programTooLarge, count, MAX_TOKENS));
    }
  }

  private tooManyLevels(): never {
    errors.raiseErrForToken(this.token, errMessages.tooManyLevels, MAX_LEVELS, tokenText(this.token));
  }

  // Implement an operator-precedence parser to handle binary operator
  // precedence.
  //
  // We use this algorithm because it's compact, it's fast and Lua core uses
  // the same so we can be sure our expressions are parsed in the same manner
  // without excessive amounts of tests.
  //
  //     exp ::= (unop exp | primary | prefixexp ) { binop exp }

  private parseSubExpressionInLevel(minPrecedence: number, flowContext: FlowContext): Expression | null {
    let operator = this.token.value as string;
    // The left-hand side in binary operations.
    let expression: Expression | null = null;

    const marker = this.createLocationMarker();

    // UnaryExpression
    if (isUnary(this.token)) {
      this.markLocation();
      this.lexerNext();
      const argument = this.parseSubExpression(10, flowContext);
      if (argument == null) {
        errors.raiseUnexpectedToken('<expression>', this.token);
      }
      expression = this.finishNode(AST.unaryExpression(operator, argument));
    }

    if (null == expression) {
      // PrimaryExpression
      expression = this.parsePrimaryExpression(flowContext);

      // PrefixExpression
      if (null == expression) {
        expression = this.parsePrefixExpression(flowContext);
      }

    }
    // This is not a valid left hand expression.
    if (null == expression) {
      return null;
    }

    let precedence;
    while (true) {
      operator = this.token.value as string;

      precedence = (this.token.type === TokenType.Punctuator || this.token.type === TokenType.Keyword) ?
        Operators.binaryPrecedenceOf(operator) : Operators.minPrecedenceValue;

      if (precedence === Operators.minPrecedenceValue || precedence <= minPrecedence) {
        break;
      }
      // Right-hand precedence operators
      if ('^' === operator || '..' === operator) {
        --precedence;
      }
      this.lexerNext();
      const right = this.parseSubExpression(precedence, flowContext);
      if (null == right) {
        errors.raiseUnexpectedToken('<expression>', this.token);
      }
      // Push in the marker created before the loop to wrap its entirety.
      this.pushLocation(marker);
      expression = this.finishNode(AST.binaryExpression(operator, expression, right));
    }
    return expression;
  }

  //     prefixexp ::= prefix {suffix}
  //     prefix ::= Name | '(' exp ')'
  //     suffix ::= '[' exp ']' | '.' Name | ':' Name args | args
  //
  //     args ::= '(' [explist] ')' | tableconstructor | String

  parsePrefixExpressionPart(base: Expression, marker: Marker, flowContext: FlowContext) {
    let expression, identifier;

    if (this.token.type === TokenType.Punctuator) {
      switch (this.token.value) {
      case '[':
        this.pushLocation(marker);
        this.lexerNext();
        expression = this.parseExpectedExpression(flowContext);
        this.lexer.expect(']');
        return this.finishNode(AST.indexExpression(base, expression));
      case '.':
        this.pushLocation(marker);
        this.lexerNext();
        identifier = this.parseIdentifier();
        return this.finishNode(AST.memberExpression(base, '.', identifier));
      case ':':
        this.pushLocation(marker);
        this.lexerNext();
        identifier = this.parseIdentifier();
        base = this.finishNode(AST.memberExpression(base, ':', identifier));
        // Once a : is found, this has to be a CallExpression, otherwise
        // throw an error.
        this.pushLocation(marker);
        return this.parseCallExpression(base, flowContext);
      case '(': case '{': // args
        this.pushLocation(marker);
        return this.parseCallExpression(base, flowContext);
      }
    } else if (this.token.type === TokenType.StringLiteral) {
      this.pushLocation(marker);
      return this.parseCallExpression(base, flowContext);
    }

    return null;
  }

  parsePrefixExpression(flowContext: FlowContext): Expression | null {
    let base : Expression;

    const marker = this.createLocationMarker();

    // The prefix
    if (TokenType.Identifier === this.token.type) {
      base = this.parseIdentifier();
      this.useName(flowContext, base.name);
    } else if (this.lexer.consume('(')) {
      // Parentheses surrounding a new expression.
      base = this.parseExpectedExpression(flowContext);
      this.lexer.expect(')');
      base.parens = true;
    } else {
      return null;
    }

    // The suffix
    for (;;) {
      const newBase = this.parsePrefixExpressionPart(base, marker, flowContext);
      if (newBase === null) {
        break;
      }
      base = newBase;
    }

    return base;
  }

  //     args ::= '(' [explist] ')' | tableconstructor | String

  parseCallExpression(base: Expression, flowContext: FlowContext):
      CallExpression | TableCallExpression | StringCallExpression {
    if (TokenType.Punctuator === this.token.type) {
      switch (this.token.value) {
      case '(':
        this.lexerNext();

        // List of expressions
        const expressions = [];
        let expression = this.parseExpression(flowContext);
        if (null != expression) {
          expressions.push(expression);
        } else if (',' === this.token.value as string) {
          errors.raiseUnexpectedToken('<expression>', this.token);
        }
        while (this.lexer.consume(',')) {
          expression = this.parseExpectedExpression(flowContext);
          expressions.push(expression);
        }

        this.lexer.expect(')');
        return this.finishNode(AST.callExpression(base, expressions));

      case '{':
        this.markLocation();
        this.lexerNext();
        const table = this.parseTableConstructor(flowContext);
        return this.finishNode(AST.tableCallExpression(base, table));
      }
    } else if (TokenType.StringLiteral === this.token.type) {
      return this.finishNode(AST.stringCallExpression(base, this.parsePrimaryExpression(flowContext) as StringLiteral));
    }

    errors.raiseUnexpectedToken('arguments', this.token);
  }

  //     primary ::= String | Numeric | nil | true | false
  //          | functiondef | tableconstructor | '...' | '?' explist

  parsePrimaryExpression(flowContext: FlowContext): Literal | FunctionDeclaration | TableConstructorExpression | CallExpression | null {
    const literals = [ TokenType.StringLiteral, TokenType.NumericLiteral, TokenType.BooleanLiteral, TokenType.NilLiteral, TokenType.VarargLiteral ];
    const value = this.token.value;
    const type = this.token.type;

    const marker = this.createLocationMarker();

    if (type === TokenType.VarargLiteral && !flowContext.allowVararg) {
      raiseErrForToken(this.token, errMessages.cannotUseVararg, tokenText(this.token));
    }

    if (literals.includes(type)) {
      this.pushLocation(marker);
      // A long string that a pasted file leaves open ends in another file: its text is the part in its own file.
      const { start, end } = this.token.bounds;
      const raw = this.lexerOf(start.filename).text.slice(start.index, end.filename === start.filename ? end.index : undefined);
      this.lexerNext();
      return this.finishNode(AST.literal(type, value, raw));
    } else if (type === TokenType.Keyword && 'function' === value) {
      this.pushLocation(marker);
      this.lexerNext();
      return this.parseFunctionDeclaration(null, false, flowContext);
    } else if (this.lexer.consume('{')) {
      this.pushLocation(marker);
      return this.parseTableConstructor(flowContext);
    } else if (this.lexer.consume('?')) {
      return this.parsePrint(marker, flowContext);
    }

    return null;
  }
}

function isUnary(token: Token): boolean {
  // PICO-8 uses @a (peek), %a (peek2), $a (peek4) as unary operators
  // (see: https://pico-8.fandom.com/wiki/Lua#Operator_priorities)
  // ~ is bitwise NOT
  if (token.type === TokenType.Punctuator) {
    return [ '#', '-', '~', '@', '%', '$' ].includes(token.value as string);
  }
  if (token.type === TokenType.Keyword) {
    return 'not' === token.value;
  }
  return false;
}

function isAssignmentOperator(token: Token): boolean {
  return token.type === TokenType.Punctuator &&
    [ '=', '+=', '-=', '*=', '/=', '\\=', '%=', '^=', '..=', '|=',
      '&=', '^^=', '<<=', '>>=', '>>>=', '<<>=', '>><=' ].includes(token.value as string);
}

function canStartExpression(token: Token): boolean {
  switch (token.type) {
  case TokenType.Identifier:
  case TokenType.StringLiteral:
  case TokenType.NumericLiteral:
  case TokenType.BooleanLiteral:
  case TokenType.NilLiteral:
  case TokenType.VarargLiteral:
    return true;
  case TokenType.Keyword:
    return token.value === 'not' || token.value === 'function';
  case TokenType.Punctuator:
    return [ '(', '{', '-', '#', '~', '@', '%', '$', '?' ].includes(token.value as string);
  default:
    return false;
  }
}

// A keyword or the end of the file can't be in a parameter list, so skipping a
// broken one stops there, and the function body starts there.
function endsParameterList(token: Token): boolean {
  return token.type === TokenType.EOF || token.type === TokenType.Keyword;
}

// Check if the token closes a block that ends at the end of the line (e.g. a
// PICO-8 one-line while statement).
function isEndOfLine(token: Token) {
  return token.type === TokenType.Newline || isBlockFollow(token);
}

// Check if the token syntactically closes a block.
function isBlockFollow(token: Token) {
  if (token.type === TokenType.EOF) {
    return true;
  }
  if (token.type !== TokenType.Keyword) {
    return false;
  }
  switch (token.value) {
  case 'else': case 'elseif':
  case 'end': case 'until':
    return true;
  default:
    return false;
  }
}

function isEndOfFile(token: Token) {
  return token.type === TokenType.EOF;
}

// Lua names the function in its errors by the line it starts on; the file is named when the error is in another.
function functionNamed(flowContext: FlowContext, at: Token): string {
  const start = flowContext.start;
  if (!start) {
    return 'main function';
  }
  return start.filename.equals(at.bounds.start.filename) ? `function at line ${start.line}`
    : `function at line ${start.line} in ${path.basename(start.filename.path)}`;
}

function mayBeConstant(expression: Expression): boolean {
  switch (expression.type) {
  case 'NumericLiteral': case 'StringLiteral': case 'BooleanLiteral': case 'NilLiteral':
    return true;
  case 'UnaryExpression':
    return mayBeConstant(expression.argument);
  case 'BinaryExpression': case 'LogicalExpression':
    return mayBeConstant(expression.left) && mayBeConstant(expression.right);
  default:
    return false;
  }
}

// The local a name refers to, and the functions it is an upvalue of: from this one out to the one that declares it, or
// to the main function when none does.
function declaration(flowContext: FlowContext, name: string): { variable?: LocalVariable, below: FlowContext[] } {
  const below: FlowContext[] = [];
  for (let context: FlowContext | null = flowContext; context; context = context.parent) {
    const variable = context.variableNamed(name);
    if (variable) {
      return { variable, below };
    }
    below.push(context);
  }
  return { below };
}

// An #include line is no statement to Lua, which reads the file's code in its place.
function lastCodeStatement(statements: Statement[]): Statement | undefined {
  for (let i = statements.length - 1; i >= 0; i--) {
    if (statements[i].type !== 'IncludeStatement') {
      return statements[i];
    }
  }
  return undefined;
}

// PICO-8 reads the tab after the colon as a hexadecimal number that the text starts with, after white space and a sign,
// with a 0x before its digits only when a digit follows the 0x. It keeps the number in 32 bits and then applies the
// sign. No such number, or -1, gives the whole file, undefined here; 0 to 15 give that tab; any other number gives
// nothing (3.p8-tab-g, 3.p8-tab-0x, 3.p8-tab-minus, 3.p8-tab-ffffffff, 3.p8-tab-100000001, 3.p8-tab-minus-ffffffff).
function tabIndex(suffix: string): number | undefined {
  const number = /^[ \t\n\v\f\r]*([+-]?)(?:0x([0-9a-f]+)|(?!0x)([0-9a-f]+))/i.exec(suffix);
  if (!number) {
    return undefined;
  }
  let tab = 0;
  for (const digit of number[2] ?? number[3]) {
    tab = (tab * 16 + parseInt(digit, 16)) | 0;
  }
  tab = number[1] === '-' ? -tab | 0 : tab;
  return tab === -1 ? undefined : tab;
}

// What an #include pastes from a file, with how many characters PICO-8 counts for it besides those of that code when
// this is known, or the number of the tab that the file does not have. PICO-8 takes tabs of a cart, and of a file
// whose path has .lua in it in any case, and any other file whole (3.colon-txt, si.t28.ext-folder, si.t28.ext-alua).
// Whole, a file of tabs is its first 16 tabs with nothing between them (si.tab.t18.whole, si.t28.join.tabs-fuse); a
// number that is not one of the 16 tabs a cart can have gives nothing (3.p8-tab-11, 3.p8-tab-minus-2). It counts 2
// more for the last tab of a .lua that is not a cart, and 1 more for any other file (5.chars.include-*). Not known: its
// count of more than 16 tabs, of a number that is not a tab, and of any other file that has a line -->8.
function includedCode(code: Code, filePath: string, tab: number | undefined): { code: Code, more?: number } | number {
  if (!code.cart && !/\.lua/i.test(filePath)) {
    return { code, more: /(?:^|\n)-->8/.test(code.code) ? undefined : 1 };
  }
  const tabs = tabsOf(code);
  const last = code.cart ? 0 : 2;
  if (tab === undefined) {
    return { code: joined(tabs.slice(0, 16)), more: tabs.length > 16 ? undefined : last };
  }
  if (tab < 0 || tab >= 16) {
    return { code: readCode('') };
  }
  return tab < tabs.length ? { code: tabs[tab], more: tab === tabs.length - 1 ? last : 0 } : tab;
}
