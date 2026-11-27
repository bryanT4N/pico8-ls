import AST from './ast';
import { FlowContext } from './control-flow';
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
import { Code, joined, readCode, tabsOf } from './code';
import Lexer, { onOneLine, OpenBracket } from './lexer';
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
import { Token, TokenType } from './tokens';
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

export type ParserOptions = {
  includeFileResolver?: FileResolver,
};

export default class Parser {
  includeFileResolver: FileResolver;

  // The main file's lexer. Every token is read through it, those of the files that its #include lines paste in too
  // (pull).
  readonly lexer: Lexer;

  // The lexers being read from: the main file's, and above it the one of the file that an #include line pastes in.
  private readonly lexerStack: Lexer[];

  // The files pasted in, in the order of their #include lines, by the ResolvedFile of each, which its lexer alone has:
  // the lexer, the #include line in the main file, and where the file's code starts.
  private readonly pasted = new Map<ResolvedFile, { lexer: Lexer, line: Bounds, start: CodeLocation }>();

  // Where the #include line of each file pasted in starts, in order.
  private readonly pasteLines: number[] = [];

  // The #include lines not yet placed in a block, each with the token that came after it (placeIncludes).
  private unplaced: { statement: IncludeStatement, next?: Token }[] = [];

  // A long string or comment, or a short string after a \z, that runs past the end of a pasted file or past an #include
  // line (Lexer.openBracket), still being read (goOnInBracket), with the token lex() gave then, the string's when it is
  // a string.
  private open?: OpenBracket & { token: Token };

  // The end-of-file token of each lexer that has read to its end.
  private readonly ends = new Map<ResolvedFile, Token>();

  // The nodes that end in another file than they start in, or hold the #include line of a file pasted in (finishNode).
  private readonly spanning: ASTNode[] = [];

  // Locations are stored in a stack as a `Marker` object consisting of both
  // `loc` and `range` data. Once a `Marker` is popped off the stack an end
  // location is pushed and the data is attached to a syntax node.
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

  // eslint-disable-next-line @typescript-eslint/ban-types
  constructor(filename: ResolvedFile, input: string, options: ParserOptions = {}) {
    this.includeFileResolver = options?.includeFileResolver || new RealFileResolver();

    this.lexer = new Lexer(input, filename);
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

    // For "greedy" nodes we take the next token, instead of the previous one
    // (this is just block nodes atm)
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

    // A node belongs to an included file if it *started* in one.
    node.included = location ?
      !this.mainFile.equals(location.loc.start.filename) :
      this.isInIncludedFile();

    return node;
  }

  getUnexpectedTokenErr(found: Token): errors.ParseError {
    const near = this.lexer.lookahead!.value;

    let type;
    switch (found.type) {
    case TokenType.StringLiteral:   type = 'string';      break;
    case TokenType.Keyword:         type = 'keyword';     break;
    case TokenType.Identifier:      type = 'identifier';  break;
    case TokenType.NumericLiteral:  type = 'number';      break;
    case TokenType.Punctuator:      type = 'symbol';      break;
    case TokenType.BooleanLiteral:  type = 'boolean';     break;
    case TokenType.Newline:         type = 'newline';     break;
    case TokenType.NilLiteral:
      return errors.createErrForToken(found, errMessages.unexpected, 'symbol', 'nil', near);
    case TokenType.EOF:
      return errors.createErrForToken(found, errMessages.unexpectedEOF);
    }

    return errors.createErrForToken(found, errMessages.unexpected, type, found.value, near);
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
    const body = this.parseBlock(flowContext, isEndOfFile);
    if (this.token.type !== TokenType.EOF) {
      this.errors.push(errors.createErrForToken(this.token, errMessages.expected, '<eof>', this.token.value));
    } else if (this.isCart()) {
      // PICO-8 rejects a return in a cart's outermost block, also as its last statement (4.return.end-bare), and a
      // goto there past a local to a label at the end, which Lua allows at the end of a block (4.goto.end-of-chunk-local).
      const last = lastCodeStatement(body.body);
      if (last?.type === 'ReturnStatement') {
        this.errors.push(errors.createErr(last.loc!, errMessages.returnInCart));
      }
      flowContext.raiseDeferredErrors(this.token);
    }
    flowContext.endFunction(this.token);

    this.addLexerErrors(this.lexer);
    for (const { lexer } of this.pasted.values()) {
      this.addLexerErrors(lexer);
    }
    // The parse can stop in a file pasted in.
    for (const lexer of this.lexerStack.slice(1)) {
      this.takeComments(lexer);
    }
    for (const error of this.gotoErrors) {
      this.errors.push(error);
    }
    this.sortErrors();

    this.pushLocation(new Marker(body.loc!));
    const chunk = this.finishNode(AST.chunk(body, this.errors));
    chunk.includes = this.includes;
    chunk.comments = this.lexer.comments;
    chunk.includedComments = this.includedComments;
    chunk.unresolvedIncludes = this.unresolvedIncludes;

    // The outline, folding and the analysis take a node that runs from one file into another to end where its first file
    // stops being read: at the #include line of the file it runs into, or at the end of the pasted file it starts in,
    // which has been read to its end by then. Its text in the files after that one is kept apart, for the analysis.
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
    const code = this.codeToPaste(statement, written, name, resolvedInclude, colon < 0 ? undefined : filename.slice(colon + 1));
    if (code !== undefined) {
      const lexer = new Lexer(code, resolvedInclude);
      lexer.pasted = true;
      this.lexerStack.push(lexer);
      this.pasted.set(resolvedInclude, { lexer, line: line.bounds, start: lexer.getCurrentBounds().end });
      this.pasteLines.push(line.bounds.start.index);
    }
  }

  // PICO-8 pastes a file's text in with two line breaks after it, and a long string or comment, or a short string in the
  // blanks after a \z, goes on through the text so pasted together to its close: one that a pasted file leaves open goes
  // on after its #include line, and one that reaches an #include line that PICO-8 reads (includeLinesOf) goes on in
  // that file (3.open-long-string, 3.open-long-string-codes, 3.open-long-comment-include-closes,
  // 3.alone-code-real-comment, 3.z-include-file). Undefined when there is no token yet: a comment, or an #include line
  // read; the end of a pasted file is its end-of-file token, for pull to go on after it.
  private goOnInBracket(lexer: Lexer): Token | undefined {
    const open = this.open!;
    let reached: 'close' | 'unfinished' | 'end' | 'include';
    if ('quote' in open) {
      const read = lexer.readShortString(open.quote, true);
      reached = read.reached;
      if (read.value !== null && open.token.value !== null) {
        open.token.value = open.token.value + read.value;
      }
    } else {
      const from = lexer.index;
      reached = lexer.closeLongBracket(open.level);
      if (!open.isComment && open.token.value !== null) {
        const read = lexer.input.slice(from, reached === 'close' ? lexer.index - open.level - 2 : lexer.index);
        const breaks = reached === 'end' && lexer !== this.lexer ? '\n\n' : '';
        open.token.value = open.token.value + lexer.encodingMode.fixup(lexer.getLocation(), read + breaks);
      }
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
      this.errors.push(open.unfinished);
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

  addLexerErrors(lexer: Lexer) {
    // One by one, since spreading a long list as arguments overflows the stack.
    for (const error of lexer.errors) {
      this.errors.push(error);
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

  // The code that an #include pastes in, or undefined when there is none, with the error saying why.
  private codeToPaste(statement: IncludeStatement, written: string, name: string, resolvedInclude: ResolvedFile, tabSuffix?: string): Code | undefined {
    if (this.includeParses >= MAX_INCLUDE_PARSES) {
      if (!this.reportedTooManyIncludeParses) {
        this.reportedTooManyIncludeParses = true;
        this.errors.push(new errors.ParseError(`too many #includes (limit is ${MAX_INCLUDE_PARSES})`, statement.loc!));
      }
      return undefined;
    }

    // PICO-8 does not open these names, whatever is on the disk (si.line.name.leading-slash, si.line.name.trailing-slash,
    // si.line.name.char.e-acute).
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
    const code = includedCode(readCode(fileContents), resolvedInclude.path, tabSuffix);
    if (typeof code === 'number') {
      this.errors.push(this.getIncludeStatementError(statement, written, `${path.basename(resolvedInclude.path)} has no tab ${code}`));
      return undefined;
    }
    this.includeParses++;
    return code;
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
      ? errors.createErrForToken(this.token, errMessages.expectedToClose, closer, word, line, this.token.value)
      : errors.createErrForToken(this.token, errMessages.expectedToCloseInFile, closer, word, line, path.basename(filename.path), this.token.value);
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
        const name = this.parseFunctionName();
        return this.parseFunctionDeclaration(name, false);
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
        return this.parseSpecialPrint(flowContext);
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
      // Handle special one-line while statement
      // (the body is every statement until the end of the line)
      this.lexer.withSignificantNewline(() => {
        body = this.parseWhileStatementBody(flowContext, isEndOfLine);
        this.expectEndOfLine();
      });
    } else {
      errors.raiseErrForToken(this.token, errMessages.expected, 'do', this.token.value);
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
      errors.raiseErrForToken(this.token, errMessages.endOfLineExpected, this.token.value);
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

    // IfClauses begin at the same location as the parent IfStatement.
    // It ends at the start of `end`, `else`, or `elseif`.
    let marker = this.locations[this.locations.length - 1];
    this.pushLocation(marker);

    const startsWithParen = this.token.value === '(';

    condition = this.parseExpectedExpression(flowContext);

    if (!this.lexer.consume('then') && !this.lexer.consume('do')) {
      if (startsWithParen && this.isOneLineBody(condition, keyword)) {

        // Tell formatter not to use outer parens on the condition expression, since they'll
        // be added anyway for a one-line if statement
        condition.parens = false;

        // Handle special PICO-8 one-line if statement. Each clause contains every statement up to the end of the line
        // or the next clause; any of them can be empty, an else at the end of the line too.
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
              errors.raiseErrForToken(this.token, errMessages.expected, 'then', this.token.value);
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
        errors.raiseErrForToken(this.token, errMessages.expected, 'then', this.token.value);
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
        errors.raiseErrForToken(this.token, errMessages.expected, 'then', this.token.value);
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
      } while (this.lexer.consume(','));

      let operator: string | undefined = undefined;
      if (this.lexer.consume('=')) {
        operator = '=';

        do {
          const expression = this.parseExpectedExpression(flowContext);
          init.push(expression);
        } while (this.lexer.consume(','));
      }

      return this.finishNode(AST.localStatement(variables, operator, init));
    }
    if (this.lexer.consume('function')) {
      name = this.parseIdentifier();
      flowContext.addLocal(name.name, declToken);

      // MemberExpressions are not allowed in local statements.
      return this.parseFunctionDeclaration(name, true);
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
    // Keep a reference to the previous this.token for better error messages in case
    // of invalid statement
    let marker: Marker;
    let lvalue, base;

    const targets: Expression[] = [];

    const startMarker = this.createLocationMarker();

    do {
      marker = this.createLocationMarker();

      if (this.token.type === TokenType.Identifier) {
        base = this.parseIdentifier();
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
    if (compound && targets.length === 1) {
      // The brackets are kept because PICO-8 assigns to nothing then: (a)+=1 leaves a as it is.
      if (lvalue === false) {
        targets[0].parens = true;
      }
    } else if (targets.length === 1 && lvalue === null) {
      this.pushLocation(marker);
      return this.finishNode(AST.callStatement(targets[0]));
    } else if (!lvalue) {
      this.unexpectedToken(this.token);
    } else if (compound) {
      errors.raiseErrForToken(this.token, errMessages.expected, '=', this.token.value);
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

    this.pushLocation(startMarker);
    return this.finishNode(AST.assignmentStatement(targets, operator, values));
  }

  // Special PICO-8 print statement: ? expression '\n'
  parseSpecialPrint(flowContext: FlowContext): CallStatement {
    const startMarker = this.printsNothing() ? new Marker(this.previousToken) : this.createLocationMarker();

    const args = this.parsePrintArguments(flowContext);

    // Each part uses the same start marker. One instance of it was already
    // pushed above. finishNode will consume the top location on the stack so we
    // have to push 2 more times.
    const base = this.finishNode(AST.identifier('?'));
    this.pushLocation(startMarker);
    const callExpression = this.finishNode(AST.callExpression(base, args));
    this.pushLocation(startMarker);
    return this.finishNode(AST.callStatement(callExpression));
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
        errors.raiseErrForToken(this.token, errMessages.endOfLineExpected, this.token.value);
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

  parseFunctionDeclaration(name: Identifier | MemberExpression | null, isLocal: boolean): FunctionDeclaration {
    const opener = this.locations[this.locations.length - 1].loc;
    const flowContext = new FlowContext(this.gotoErrors, found => this.stoppedBefore(found));
    flowContext.pushScope();

    const parameters = [];
    this.lexer.expect('(');

    // The declaration has arguments
    if (!this.lexer.consume(')')) {
      // Arguments are a comma separated list of identifiers, optionally ending
      // with a Vararg.
      do {
        if (this.token.type === TokenType.Identifier) {
          const parameter = this.parseIdentifier();
          parameters.push(parameter);
        } else if (this.token.type === TokenType.VarargLiteral) {
          flowContext.allowVararg = true;
          parameters.push(this.parsePrimaryExpression(flowContext) as VarargLiteral);
          // No arguments are allowed after a Vararg.
          break;
        } else if (endsParameterList(this.token)) {
          // Reported as a missing ')' below.
          break;
        } else {
          this.errors.push(errors.createErrForToken(this.token, errMessages.expectedToken, '<name> or \'...\'', this.token.value));

          // Discard tokens until we get a ')' or ','
          while (this.token.value !== ')' && this.token.value !== ',' && !endsParameterList(this.token)) {
            this.lexerNext();
          }

        }
      } while (this.lexer.consume(','));

      if (!this.lexer.consume(')')) {
        this.errors.push(errors.createErrForToken(this.token, errMessages.expected, ')', this.token.value));

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

  parseFunctionName() {
    let base, name;

    const marker = this.createLocationMarker();
    base = this.parseIdentifier();

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
  // Expressions are evaluated and always return a value. If nothing is
  // matched null will be returned.
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

  private tooManyLevels(): never {
    errors.raiseErrForToken(this.token, errMessages.tooManyLevels, MAX_LEVELS, this.token.value);
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
      raiseErrForToken(this.token, errMessages.cannotUseVararg, this.token.value);
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
      return this.parseFunctionDeclaration(null, false);
    } else if (this.lexer.consume('{')) {
      this.pushLocation(marker);
      return this.parseTableConstructor(flowContext);
    } else if (this.lexer.consume('?')) {
      this.pushLocation(marker);
      const base = this.finishNode(AST.identifier('?'));
      this.pushLocation(marker);
      return this.finishNode(AST.callExpression(base, this.parsePrintArguments(flowContext)));
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

// Where the # of each #include line that PICO-8 reads is in the code, or undefined for none.
// PICO-8 finds them in the cart's own text before Lua reads the code: at the start of a line, in lower case and followed
// by a space (3.after-code, 3.upper, 3.tab-after-include, 3.nested), and only outside a long string or comment of that
// text, whatever a pasted file leaves open (3.alone-str-cart-comment-level, 3.alone-code-real-comment). Its scan is not
// Lua's: it reads short strings, which \ and a line break take on to the next line, -- comments, long or not, and //
// line comments, //[[ too (3.scan-dq-string, 3.dq-cont-include, 3.scan-line-comment-space, 3.scan-slash-long), but a
// \z does not take a string past a line break (3.z-include), and it skips the rest of an #include line
// (3.scan-name-brackets). Elsewhere the # is the length operator. The scan stops at the last #include line.
function includeLinesOf(input: string): Set<number> | undefined {
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

// After a long bracket that opens at i, or undefined when none opens there.
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

function lineEnd(input: string, i: number): number {
  while (i < input.length && input.charCodeAt(i) !== 10 && input.charCodeAt(i) !== 13) {
    i++;
  }
  return i;
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

// What an #include pastes from a file, or the number of the tab that the file does not have. PICO-8 takes tabs of a
// cart, and of a file whose path has .lua in it in any case, and any other file whole (3.colon-txt, si.t28.ext-folder,
// si.t28.ext-alua). Whole, a file of tabs is its first 16 tabs with nothing between them (si.tab.t18.whole,
// si.t28.join.tabs-fuse); a number that is not one of the 16 tabs a cart can have gives nothing (3.p8-tab-11,
// 3.p8-tab-minus-2).
function includedCode(code: Code, filePath: string, tabSuffix: string | undefined): Code | number {
  if (!code.cart && !/\.lua/i.test(filePath)) {
    return code;
  }
  const tabs = tabsOf(code);
  const tab = tabSuffix !== undefined ? tabIndex(tabSuffix) : undefined;
  if (tab === undefined) {
    return joined(tabs.slice(0, 16));
  }
  if (tab < 0 || tab >= 16) {
    return readCode('');
  }
  return tab < tabs.length ? tabs[tab] : tab;
}
