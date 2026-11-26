import AST from './ast';
import { FlowContext, Goto } from './control-flow';
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
  Variable,
} from './expressions';
import ResolvedFile, { FileResolver, RealFileResolver, resolveIncludeFile } from './file-resolver';
import Lexer, { isWhiteSpace, LexerState } from './lexer';
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
import { ASTNode, Bounds, CodeLocation, codeLocationsEqual } from './types';
import Operators from './operators';

type UnderIndentedClose = { opener: Bounds, word: string, closer: 'end' | 'until', closedAt: number };

// What parsing a simple statement can change, to parse it again. Its flow scope only gains locals and has its
// deferred gotos reported; a function in it has a flow context of its own.
type ParserSnapshot = {
  lexer: LexerState, errors: number, locations: number, hoisted: Statement[], endBeforeHoisted: CodeLocation | null,
  underIndentedCloses: number, includes: number, includedComments: number, unresolvedIncludes: number,
  includeParses: number, reportedTooManyIncludeParses: boolean, levels: number, reportedTooManyLevels: boolean,
  reportedStop: boolean, locals: number, deferredGotos: Goto[],
};

// The circular #include check compares paths, and a link to a parent
// directory gives the same file an ever longer one (sub/a.lua, sub/sub/a.lua).
const MAX_INCLUDE_DEPTH = 32;

// A file included twice is parsed twice, so files that each include the next
// one twice take 2^depth parses, even within MAX_INCLUDE_DEPTH.
const MAX_INCLUDE_PARSES = 256;

// PICO-8's Lua, as Lua 5.2 (LUAI_MAXCCALLS), counts a level for each statement
// and each subexpression, and rejects code nested more than 200 levels deep.
const MAX_LEVELS = 200;

// Past MAX_LEVELS the parser reports once and goes on, so that a long `..`
// chain keeps its statement. It stops here so that the parser and the code
// that walks the syntax tree stay within the call stack: on a cold start they
// overflow at about 1,300 levels.
const MAX_PARSED_LEVELS = 500;

export type ParserOptions = {
  includeFileResolver?: FileResolver,
};

export default class Parser {
  includeFileResolver: FileResolver;

  // A stack of lexers representing the file and any '#include'ed files we're
  // currently working with.
  //
  // The lexer at position 0 (bottom of the stack) is the lexer for the "main"
  // file that we're working with.
  lexerStack: {
    lexer: Lexer,
    // The IncludeStatement #including the file that prompted the creation of
    // this lexer.
    includeStatement: IncludeStatement | null,
  }[];

  // Locations are stored in a stack as a `Marker` object consisting of both
  // `loc` and `range` data. Once a `Marker` is popped off the stack an end
  // location is pushed and the data is attached to a syntax node.
  locations: Marker[] = [];

  // Keep track of all errors that occurred while parsing.
  errors: errors.ParseError[] = [];

  // Statements that a block left without its `end` handed back. The parseBlock
  // parsing the statement that holds the block puts them after it.
  private hoisted: Statement[] = [];

  // Blocks closed by an `end` (or `until`) less indented than the line they
  // start on. Such a closer most likely belongs to a block around them that
  // takes the same closer, so when one of those turns out to have none, the
  // inner block is the one reported.
  private underIndentedCloses: UnderIndentedClose[] = [];

  // Where the block that handed back the statements in `hoisted` now ends.
  // Until they are put after the statement being parsed, the nodes around that
  // block end there too, instead of at the last token, which is past them.
  private endBeforeHoisted: CodeLocation | null = null;

  includes: Include[] = [];

  private includedComments: Comment_[] = [];

  private unresolvedIncludes: ResolvedFile[] = [];

  private includeParses = 0;
  private reportedTooManyIncludeParses = false;

  private levels = 0;
  // Code nested too deep is reported once, for the innermost statement within
  // MAX_LEVELS, rather than at every level past it.
  private reportedTooManyLevels = false;
  private reportedStop = false;

  // The first tokens of the values in the simple statement being parsed that start on a later line than their
  // operator, and that could start a statement there too (a name or `(`): the statement is parsed again only when it
  // fails on one of their lines. Null in a compound statement.
  private continuations: Token[] | null = null;
  // Where the value is missing in the statement being parsed again.
  private stopAt: Token | null = null;
  // The token that already has the error of a missing value or bracket.
  private reportedNear: Token | null = null;
  // How many statements have been parsed again, to tell whether one was while a statement around it was parsed.
  private reparsed = 0;

  // eslint-disable-next-line @typescript-eslint/ban-types
  constructor(filename: ResolvedFile, input: string, options: ParserOptions = {}) {
    this.includeFileResolver = options?.includeFileResolver || new RealFileResolver();

    this.lexerStack = [{
      lexer: new Lexer(input, filename),
      includeStatement: null,
    }];
  }

  isInIncludedFile(): boolean {
    return this.lexerStack.length > 1;
  }

  // The top-level file being parsed (everything else is #include-d from it)
  get mainFile(): ResolvedFile {
    return this.lexerStack[0].lexer.filename;
  }

  // Returns the top lexer on the stack
  get lexer(): Lexer {
    return this.lexerStack[this.lexerStack.length - 1].lexer;
  }

  // Returns the filename of the current lexer
  get filename(): ResolvedFile {
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
      let end = endingToken.bounds.end;
      const limit = this.endBeforeHoisted;
      // Only a node that starts before the limit can be around that block.
      if (limit && limit.filename.equals(location.loc.start.filename)
          && location.loc.start.index < limit.index && end.index > limit.index) {
        end = limit;
      }
      location.complete(end);
      location.bless(node as any as ASTNode);
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
    this.markLocation();
    const flowContext = new FlowContext(this.errors);
    flowContext.allowVararg = true;
    flowContext.pushScope();
    const body = this.parseBlock(flowContext, isEndOfFile);
    flowContext.popScope();

    if (this.token.type !== TokenType.EOF) {
      this.errors.push(this.getUnexpectedTokenErr(this.token));
    }

    this.addLexerErrors(this.lexer);
    this.sortErrors();

    const chunk = this.finishNode(AST.chunk(body, this.errors));
    chunk.includes = this.includes;
    chunk.comments = this.lexer.comments;
    chunk.includedComments = this.includedComments;
    chunk.unresolvedIncludes = this.unresolvedIncludes;

    return chunk;
  }

  addLexerErrors(lexer: Lexer) {
    // One by one, since spreading a long list as arguments overflows the stack.
    for (const error of lexer.errors) {
      this.errors.push(error);
    }
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
    this.pushLocation(this.createLocationMarker());

    const block: Statement[] = [];

    while (!endingFunction(this.token)) {
      const startToken = this.token;
      const locationDepth = this.locations.length;
      const flowDepth = flowContext.scopes.length;
      const levels = this.levels;

      try {
        if (this.enterStatementLevel()) {
          this.skipTooDeep(true);
          this.levels--;
          continue;
        }
        const statement = this.parseStatementOrBacktrack(flowContext);
        this.levels--;

        if (statement?.type === 'IncludeStatement') {
          const resolvedInclude = resolveIncludeFile(this.filename, statement.filename, this.includeFileResolver);
          statement.resolvedFile = resolvedInclude;

          // Check for circular dependencies
          if (this.lexerStack.some(l => l.lexer.filename.equals(resolvedInclude))) {
            this.errors.push(this.getIncludeStatementError(statement, 'Circular #includes detected!'));
          } else {
            // Pushed on its own so the #include stays when its file throws, and
            // the file's statements one by one, since spreading a huge file's
            // statements as arguments overflows the stack.
            block.push(statement);
            for (const includedStatement of this.parseIncludedFile(statement, resolvedInclude, flowContext)) {
              block.push(includedStatement);
            }
          }
        } else {
          // optional semicolon ending the statement
          this.lexer.consume(';');

          // Statements are only added if they are returned, this allows us to
          // ignore some statements, such as EmptyStatement.
          if (statement) {
            block.push(statement);
          }
        }

        this.appendHoisted(block);
      } catch (e) {
        if (errors.isParseError(e)) {
          // A statement that throws part-way through leaves its location
          // markers, nesting levels and flow scopes behind: the nodes around it
          // would get the wrong start, later statements would count as nested
          // in it, and later breaks and labels would count as inside it.
          // Its flow scopes are popped, not dropped, so the gotos in them are
          // still checked.
          this.locations.length = locationDepth;
          this.levels = levels;
          while (flowContext.scopes.length > flowDepth) {
            flowContext.popScope();
          }

          // Caught a parse error. Add it to errors and synchronize. A statement
          // that fails at the token where a bracket in it was closed, or a value
          // in it found missing, has its error there already. An error near its
          // first token belongs to the statement before it.
          if (!(this.token !== startToken && this.token === this.reportedNear
              && codeLocationsEqual(e.bounds.start, this.token.bounds.start))) {
            this.report(this.token === startToken ? e : this.atEndOfPreviousLine(e));
          }
          this.appendHoisted(block);

          // `x =` stops at the `function` that starts the next line, which
          // would be lost by skipping to the end of its line.
          if (this.token !== startToken
              && this.token.bounds.start.line > startToken.bounds.start.line
              && this.isFirstOnLine(this.token.bounds.start)
              && canStartStatement(this.token)) {
            continue;
          }

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
    }

    return this.finishNode(AST.block(block), true);
  }

  // An #included file is parsed to its own end of file, so a statement or
  // block left open in it can't run on into the file that includes it.
  parseIncludedFile(statement: IncludeStatement, resolvedInclude: ResolvedFile, flowContext: FlowContext): Statement[] {
    if (this.includeParses >= MAX_INCLUDE_PARSES) {
      if (!this.reportedTooManyIncludeParses) {
        this.reportedTooManyIncludeParses = true;
        this.errors.push(this.getIncludeStatementError(statement, `Too many #include parses (more than ${MAX_INCLUDE_PARSES})`));
      }
      return [];
    }

    if (this.lexerStack.length > MAX_INCLUDE_DEPTH) {
      this.errors.push(this.getIncludeStatementError(statement, `#includes are nested more than ${MAX_INCLUDE_DEPTH} levels deep`));
      return [];
    }

    if (!this.includeFileResolver.doesFileExist(resolvedInclude.path)) {
      // PICO-8's handling of a comment on an #include line is not documented and the tools that copy it disagree,
      // so when the filename looks like it has a comment in it, say why the lookup may have failed.
      const reason = /--|\/\//.test(statement.filename)
        ? 'File does not exist (the rest of the line is the file name: put a comment on the line above)'
        : 'File does not exist';
      return this.unresolvedInclude(statement, resolvedInclude, reason);
    }

    let fileContents: string;
    try {
      if (!this.includeFileResolver.isFile(resolvedInclude.path)) {
        return this.unresolvedInclude(statement, resolvedInclude, 'File cannot be read (is it a directory?)');
      }
      fileContents = this.includeFileResolver.loadFileContents(resolvedInclude.path);
    } catch (e) {
      // The file can be locked, lose its permissions or go away after it was
      // found; that is an error in this file, not a reason to lose the parse.
      const reason = (e as NodeJS.ErrnoException | null)?.code ?? (e instanceof Error ? e.message : String(e));
      return this.unresolvedInclude(statement, resolvedInclude, `File cannot be read (${reason})`);
    }

    if (!this.isInIncludedFile()) {
      this.includes.push({ stmt: statement, resolvedFile: resolvedInclude });
    }

    this.includeParses++;
    const newLexer = new Lexer(fileContents, resolvedInclude);
    this.lexerStack.push({
      lexer: newLexer,
      includeStatement: statement,
    });

    // A statement that throws part-way through leaves its location marker
    // behind; restoring it keeps that out of the including file.
    const locationDepth = this.locations.length;

    try {
      newLexer.next();
      return this.parseBlock(flowContext, isEndOfFile).body;
    } finally {
      this.lexerStack.pop();
      this.locations.length = locationDepth;
      this.addLexerErrors(newLexer);
      for (const comment of newLexer.comments) {
        this.includedComments.push(comment);
      }
    }
  }

  private unresolvedInclude(statement: IncludeStatement, resolvedInclude: ResolvedFile, reason: string): Statement[] {
    this.errors.push(this.getIncludeStatementError(statement, reason));
    this.unresolvedIncludes.push(resolvedInclude);
    return [];
  }

  private appendHoisted(block: Statement[]) {
    // One by one, since spreading a long list as arguments overflows the stack.
    for (const statement of this.hoisted) {
      block.push(statement);
    }
    this.hoisted.length = 0;
    this.endBeforeHoisted = null;
  }

  // `x =` with `player.x = 3` on the line below reads as `x = player.x` and then fails at `= 3`, which takes the next
  // statement into this one. So a simple statement that fails on a line where one of its values starts is parsed
  // again with that value missing, and that line is left for a statement of its own. Code that parses is never
  // parsed again. A statement in a function value two levels down can hold an #include, so the snapshot holds the
  // include fields too.
  private parseStatementOrBacktrack(flowContext: FlowContext): Statement | null {
    if (!mayParseAgain(this.token)) {
      return this.parseStatement(flowContext);
    }
    const start = this.snapshot(flowContext);
    const reparsedBefore = this.reparsed;
    const outer = this.continuations;
    const continuations: Token[] = [];
    this.continuations = continuations;
    let statement: Statement | null = null;
    let thrown: errors.ParseError | null = null;
    let failedAt: CodeLocation;
    try {
      statement = this.parseStatement(flowContext);
      if (this.continuations === null || continuations.length === 0 || canFollowStatement(this.token)) {
        return statement;
      }
      failedAt = this.token.bounds.start;
    } catch (e) {
      if (!errors.isParseError(e) || this.continuations === null || continuations.length === 0) {
        throw e;
      }
      thrown = e;
      failedAt = e.bounds.start;
    } finally {
      this.continuations = outer;
    }

    // A statement in this one's value that was parsed again keeps its recovery, and this one is left as it is: parsing
    // it again would parse the inner one twice more, which doubles at each level of nesting.
    const value = this.reparsed === reparsedBefore
      ? continuations.find(token => token.bounds.start.line === failedAt.line && token.bounds.start.filename.equals(failedAt.filename))
      : undefined;
    if (!value) {
      if (thrown) {
        throw thrown;
      }
      return statement;
    }

    this.restore(start, flowContext);
    this.reparsed++;
    const outerStop = this.stopAt;
    this.stopAt = value;
    this.continuations = null;
    try {
      return this.parseStatement(flowContext);
    } finally {
      this.stopAt = outerStop;
      this.continuations = outer;
    }
  }

  private snapshot(flowContext: FlowContext): ParserSnapshot {
    const scope = flowContext.currentScope();
    return {
      lexer: this.lexer.save(),
      errors: this.errors.length,
      locations: this.locations.length,
      hoisted: this.hoisted.slice(),
      endBeforeHoisted: this.endBeforeHoisted,
      underIndentedCloses: this.underIndentedCloses.length,
      includes: this.includes.length,
      includedComments: this.includedComments.length,
      unresolvedIncludes: this.unresolvedIncludes.length,
      includeParses: this.includeParses,
      reportedTooManyIncludeParses: this.reportedTooManyIncludeParses,
      levels: this.levels,
      reportedTooManyLevels: this.reportedTooManyLevels,
      reportedStop: this.reportedStop,
      locals: scope.locals.length,
      deferredGotos: scope.deferredGotos,
    };
  }

  // The lists are cut back rather than copied: from the snapshot they only grow, except that a block closed without
  // its closer drops under-indented closes from inside it, all of which came after. The deferred gotos are the array
  // itself, which raiseDeferredErrors replaces, so that the statement parsed again reports them again.
  private restore(snapshot: ParserSnapshot, flowContext: FlowContext) {
    this.lexer.restore(snapshot.lexer);
    this.errors.length = snapshot.errors;
    this.locations.length = snapshot.locations;
    this.hoisted = snapshot.hoisted.slice();
    this.endBeforeHoisted = snapshot.endBeforeHoisted;
    this.underIndentedCloses.length = snapshot.underIndentedCloses;
    this.includes.length = snapshot.includes;
    this.includedComments.length = snapshot.includedComments;
    this.unresolvedIncludes.length = snapshot.unresolvedIncludes;
    this.includeParses = snapshot.includeParses;
    this.reportedTooManyIncludeParses = snapshot.reportedTooManyIncludeParses;
    this.levels = snapshot.levels;
    this.reportedTooManyLevels = snapshot.reportedTooManyLevels;
    this.reportedStop = snapshot.reportedStop;
    const scope = flowContext.currentScope();
    scope.locals.length = snapshot.locals;
    scope.deferredGotos = snapshot.deferredGotos;
  }

  // Whether the value after operator is missing. A value that starts on a later line with a token that cannot start
  // one, or at the end of the file, is missing, and so is the one where a statement parsed again stops; the error
  // then goes at the end of the operator, where the code is being typed. A bare return is valid, so after one only
  // the stop counts.
  private valueMissing(operator: Token, afterReturn = false): boolean {
    const token = this.token;
    if (token.type !== TokenType.EOF
        && (token.bounds.start.line === operator.bounds.end.line || !token.bounds.start.filename.equals(operator.bounds.end.filename))) {
      return false;
    }
    const stop = this.stopAt !== null && this.stopAt.bounds.start.index === token.bounds.start.index
      && this.stopAt.bounds.start.filename.equals(token.bounds.start.filename);
    if (stop || (!afterReturn && !canStartExpression(token, this.lexer.lookahead!))) {
      const near = token.type === TokenType.EOF ? '<eof>' : token.value;
      this.report(errors.createErr({ start: operator.bounds.end, end: operator.bounds.end }, errMessages.expectedToken, '<expression>', near), token);
      return true;
    }
    if (token.type === TokenType.Identifier || (token.type === TokenType.Punctuator && token.value === '(')) {
      this.continuations?.push(token);
    }
    return false;
  }

  // A token that only starts statements, or end, else, elseif or until, cannot be in a table, an argument list or an
  // index, so one first on a line no more indented than the bracket's is the code after a bracket left open:
  // indentation tells, as for a missing end. The end of the file closes none: a bracket left open there is most likely
  // the one being typed, so its error stays at the end.
  private closesUnfinished(opener: Token): boolean {
    const token = this.token;
    return (isStatementOnly(token, this.lexer.lookahead!) || (isBlockFollow(token) && token.type !== TokenType.EOF))
      && token.bounds.start.filename.equals(opener.bounds.start.filename)
      && this.isFirstOnLine(token.bounds.start)
      && this.indentOf(token.bounds.start) <= this.indentOf(opener.bounds.start);
  }

  private expectCloser(closer: '}' | ')' | ']', opener: Token) {
    if (this.closesUnfinished(opener)) {
      this.report(errors.createErrForToken(opener, errMessages.expectedToClose, closer, opener.value, opener.bounds.start.line, this.token.value), this.token);
      return;
    }
    this.lexer.expect(closer);
  }

  // One error for each place: none when near already has a missing value's or bracket's error, or when the last error
  // starts where this one does.
  private report(error: errors.ParseError, near?: Token) {
    const last = this.errors[this.errors.length - 1];
    const at = error.bounds.start;
    if ((near && near === this.reportedNear)
        || (last && last.bounds.start.index === at.index && last.bounds.start.filename.equals(at.filename))) {
      return;
    }
    if (near) {
      this.reportedNear = near;
    }
    this.errors.push(error);
  }

  // Code being typed is usually unfinished at the end of a line, and the error
  // shows up at the first token of the next one; it's reported where the
  // unfinished line ends instead.
  private atEndOfPreviousLine(error: errors.ParseError): errors.ParseError {
    const token = this.token;
    const previous = this.previousToken;
    if (previous
        && codeLocationsEqual(error.bounds.start, token.bounds.start)
        && previous.bounds.end.filename.equals(token.bounds.start.filename)
        && token.bounds.start.line > previous.bounds.end.line) {
      error.bounds = { start: previous.bounds.end, end: previous.bounds.end };
    }
    return error;
  }

  // A block without its `end` (or `until`) has taken in all the code after it.
  // It's kept, the error goes at its first token, and the statements from the
  // first one no more indented than that token's line are handed back to the
  // enclosing block. Returns null when the closer is there, and otherwise where
  // the block's node should now end.
  private expectBlockEnd(closer: 'end' | 'until', opener: Bounds, word: string, body: Block, headerEnd: CodeLocation): CodeLocation | null {
    const file = opener.start.filename;
    const openerIndent = this.indentOf(opener.start);

    if (this.token.type === TokenType.Keyword && this.token.value === closer) {
      const closedAt = this.token.bounds.start;
      if (this.isFirstOnLine(closedAt) && this.indentOf(closedAt) < openerIndent) {
        this.underIndentedCloses.push({ opener, word, closer, closedAt: closedAt.index });
      }
      this.lexerNext();
      return null;
    }

    const inside = this.underIndentedCloses.filter(close => close.closer === closer
      && close.opener.start.filename.equals(file) && close.opener.start.index > opener.start.index);
    this.underIndentedCloses = this.underIndentedCloses.filter(close => !inside.includes(close));
    const blamed = inside.sort((a, b) => a.closedAt - b.closedAt)[0] ?? { opener, word };
    const near = this.token.type === TokenType.EOF ? '<eof>' : this.token.value;
    this.errors.push(errors.createErr(blamed.opener, errMessages.expectedToClose, closer, blamed.word, blamed.opener.start.line, near));

    const statements = body.body;
    const cut = statements.findIndex(statement => statement.loc
      && statement.loc.start.filename.equals(file)
      && this.isFirstOnLine(statement.loc.start)
      && this.indentOf(statement.loc.start) <= openerIndent);
    if (cut !== -1) {
      this.hoisted = statements.splice(cut).concat(this.hoisted);
    }

    // The statements of an #included file in the block end in that file.
    let end = headerEnd;
    for (let i = statements.length - 1; i >= 0; i--) {
      const statementEnd = statements[i].loc?.end;
      if (statementEnd?.filename.equals(file)) {
        end = statementEnd;
        break;
      }
    }

    if (cut !== -1) {
      this.endBeforeHoisted = end;
      // The body was finished before the cut, so it still reaches over the
      // statements; with none left, it's empty where the header ends.
      if (body.loc) {
        body.loc = { start: body.loc.start.index < end.index ? body.loc.start : end, end };
      }
    }
    return end;
  }

  // The whitespace that starts the line `location` is on, in the file being
  // parsed. A tab counts as one character like a space, so where tabs and
  // spaces are mixed, blocks may be split in the wrong place.
  private indentOf(location: CodeLocation): number {
    const lineStart = location.index - location.column;
    let i = lineStart;
    while (i < location.index && isWhiteSpace(this.lexer.input.charCodeAt(i))) {
      i++;
    }
    return i - lineStart;
  }

  private isFirstOnLine(location: CodeLocation): boolean {
    return this.indentOf(location) === location.column;
  }

  // There are two types of statements, simple and compound.
  //
  //     statement ::= break | goto | do | while | repeat | return
  //          | if | for | | local | label | assignment
  //          | functioncall | ';'

  parseStatement(flowContext: FlowContext): Statement | null {
    this.markLocation();
    if (!mayParseAgain(this.token)) {
      this.continuations = null;
    }

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

    flowContext.raiseDeferredErrors();

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
        if (!flowContext.isInLoop()) {
          this.errors.push(errors.createErrForToken(this.token, errMessages.noLoopToBreak, 'break'));
        }
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

        // #include filename.lua
      case '#':
        const currTokenIdx = this.token.bounds.start.index;
        this.lexer.consumeRestOfLine(currTokenIdx);
        return this.parseIncludeStatement();
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

    this.lexer.expect('::');

    flowContext.addLabel(nameToken.value as string, nameToken);
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
    const headerEnd = this.previousToken.bounds.end;
    flowContext.pushScope();
    const body = this.parseBlock(flowContext);
    flowContext.popScope();
    const truncatedEnd = this.expectBlockEnd('end', opener, 'do', body, headerEnd);
    return endAt(this.finishNode(AST.doStatement(body)), truncatedEnd);
  }

  //     while ::= 'while' exp 'do' block 'end'

  parseWhileStatement(flowContext: FlowContext): WhileStatement {
    const opener = this.locations[this.locations.length - 1].loc;
    let body: Block | undefined;
    let truncatedEnd: CodeLocation | null = null;

    const canBeOneLiner = this.lexer.token?.value === '(';
    const condition = this.parseExpectedExpression(flowContext);

    if (this.lexer.consume('do')) {
      // regular while statement with `do` ... `end`
      // (we already consumed the `do`)
      const headerEnd = this.previousToken.bounds.end;
      body = this.parseWhileStatementBody(flowContext);
      truncatedEnd = this.expectBlockEnd('end', opener, 'while', body, headerEnd);
    } else if (canBeOneLiner) {
      // Handle special one-line while statement
      // (the body is every statement until the end of the line)
      this.lexer.withSignificantNewline(() => {
        body = this.parseWhileStatementBody(flowContext, isEndOfLine);
      });
    } else {
      errors.raiseErrForToken(this.token, errMessages.expected, 'do', this.token.value);
    }

    return endAt(this.finishNode(AST.whileStatement(condition, body!)), truncatedEnd);
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
    const headerEnd = this.previousToken.bounds.end;
    flowContext.pushScope(true);
    const body = this.parseBlock(flowContext);
    const truncatedEnd = this.expectBlockEnd('until', opener, 'repeat', body, headerEnd);
    let condition: Expression;
    if (truncatedEnd === null) {
      flowContext.raiseDeferredErrors();
      condition = this.parseExpectedExpression(flowContext);
    } else {
      condition = AST.literal(TokenType.NilLiteral, null, 'nil');
    }
    flowContext.popScope();
    return endAt(this.finishNode(AST.repeatStatement(condition, body)), truncatedEnd);
  }

  //     retstat ::= 'return' [exp {',' exp}] [';']

  parseReturnStatement(flowContext: FlowContext): ReturnStatement {
    const expressions = [];

    if ('end' !== this.token.value && !this.valueMissing(this.previousToken, true)) {
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
  // PICO-8 one-line if statement:
  //     if ::= 'if' '(' exp ')' statement ['else' statement] '\n'

  parseIfStatement(flowContext: FlowContext): IfStatement {
    const opener = this.locations[this.locations.length - 1].loc;
    const clauses: GeneralIfClause[] = [];
    let condition: Expression;
    let body;

    // IfClauses begin at the same location as the parent IfStatement.
    // It ends at the start of `end`, `else`, or `elseif`.
    let marker = this.locations[this.locations.length - 1];
    this.pushLocation(marker);

    const canBeOneLiner = this.lexer.token?.value === '(';

    condition = this.parseExpectedExpression(flowContext);

    if (!this.lexer.consume('then') && !this.lexer.consume('do')) {
      if (canBeOneLiner) {

        // Tell formatter not to use outer parens on the condition expression, since they'll
        // be added anyway for a one-line if statement
        condition.parens = false;

        // Handle special PICO-8 one-line if statement. Each clause contains
        // every statement up to the end of the line (or the `else`).
        let truncatedEnd: CodeLocation | null = null;
        this.lexer.withSignificantNewline((cancelSignificantNewline) => {
          flowContext.pushScope();
          const block = this.parseBlock(flowContext, isEndOfLine);
          if (block.body.length === 0) {
            errors.raiseUnexpectedToken('statement', this.token);
          }
          flowContext.popScope();
          clauses.push(this.finishNode(AST.ifClause(condition, block)));

          if (this.lexer.consume('else')) {
            // Include the `else` in the location of ElseClause.
            this.pushLocation(new Marker(this.previousToken));

            let multilineElse = false;
            if (this.lexer.consumeTokenType(TokenType.Newline)) {
              // Weird escape hatch here into multi-line `else` block.
              // Example:
              //
              //   if(v.x<-130) del(b,v) else
              //     v.x-=2
              //   end
              cancelSignificantNewline();
              multilineElse = true;
            }
            const headerEnd = this.previousToken.bounds.end;

            flowContext.pushScope();
            // For a multi-line `else`, it's a regular block ending with an `end`.
            // Otherwise it ends at the end of the line.
            const elseBlock = this.parseBlock(flowContext, multilineElse ? isBlockFollow : isEndOfLine);
            if (multilineElse) {
              truncatedEnd = this.expectBlockEnd('end', opener, 'if', elseBlock, headerEnd);
            } else if (elseBlock.body.length === 0) {
              errors.raiseUnexpectedToken('statement', this.token);
            }
            flowContext.popScope();
            clauses.push(endAt(this.finishNode(AST.elseClause(elseBlock), true), truncatedEnd));
          }
        });

        return endAt(this.finishNode(AST.ifStatement(clauses, true)), truncatedEnd);
      } else {
        errors.raiseErrForToken(this.token, errMessages.expected, 'then', this.token.value);
      }
    }

    let headerEnd = this.previousToken.bounds.end;
    flowContext.pushScope();
    body = this.parseBlock(flowContext);
    flowContext.popScope();
    clauses.push(this.finishNode(AST.ifClause(condition, body), true));
    marker = this.createLocationMarker();

    while (this.lexer.consume('elseif')) {
      this.pushLocation(marker);
      condition = this.parseExpectedExpression(flowContext);

      if (!this.lexer.consume('then') && !this.lexer.consume('do')) {
        this.errors.push(this.atEndOfPreviousLine(errors.createErrForToken(this.token, errMessages.expected, 'then', this.token.value)));
      }

      headerEnd = this.previousToken.bounds.end;
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
      headerEnd = this.previousToken.bounds.end;
      flowContext.pushScope();
      body = this.parseBlock(flowContext);
      flowContext.popScope();
      clauses.push(this.finishNode(AST.elseClause(body), true));
    }

    const truncatedEnd = this.expectBlockEnd('end', opener, 'if', body, headerEnd);
    endAt(clauses[clauses.length - 1], truncatedEnd);
    return endAt(this.finishNode(AST.ifStatement(clauses, false)), truncatedEnd);
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
      const headerEnd = this.previousToken.bounds.end;
      flowContext.pushScope(true);
      body = this.parseBlock(flowContext);
      flowContext.popScope();
      const truncatedEnd = this.expectBlockEnd('end', opener, 'for', body, headerEnd);

      return endAt(this.finishNode(AST.forNumericStatement(variable, start, end, step, body)), truncatedEnd);
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
      const headerEnd = this.previousToken.bounds.end;
      flowContext.pushScope(true);
      body = this.parseBlock(flowContext);
      flowContext.popScope();
      const truncatedEnd = this.expectBlockEnd('end', opener, 'for', body, headerEnd);

      return endAt(this.finishNode(AST.forGenericStatement(variables, iterators, body)), truncatedEnd);
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
      if (isAssignmentOperator(this.token)) {
        operator = this.token.value as string;
        const operatorToken = this.token;
        this.lexerNext();

        if (!this.valueMissing(operatorToken)) {
          do {
            const expression = this.parseExpectedExpression(flowContext);
            init.push(expression);
          } while (this.lexer.consume(','));
        }
      }

      return this.finishNode(AST.localStatement(variables, operator, init));
    }
    if (this.lexer.consume('function')) {
      this.continuations = null;
      name = this.parseIdentifier();
      flowContext.addLocal(name.name, declToken);

      // MemberExpressions are not allowed in local statements.
      return this.parseFunctionDeclaration(name, true);
    } else {
      errors.raiseUnexpectedToken('<name>', this.token);
    }
  }

  //     assignment ::= letlist '=' explist
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

    const targets = [];

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

      targets.push(base);
      // PICO-8, as Lua 5.2, counts each target after the first as a level (lparser.c, assignment).
      if (!this.reportedTooManyLevels && targets.length - 1 + this.levels > MAX_LEVELS) {
        this.reportedTooManyLevels = true;
        this.errors.push(errors.createErrForToken(this.token, errMessages.tooManyLevels, MAX_LEVELS, this.token.value));
      }

      if (',' !== this.token.value) {
        break;
      }

      if (!lvalue) {
        this.unexpectedToken(this.token);
      }

      this.lexerNext();
    } while (true);

    if (targets.length === 1 && lvalue === null) {
      this.pushLocation(marker);
      return this.finishNode(AST.callStatement(targets[0]));
    } else if (!lvalue) {
      this.unexpectedToken(this.token);
    }

    if (!isAssignmentOperator(this.token)) {
      errors.raiseUnexpectedToken('assignment operator', this.token);
    }
    const operator = this.token.value as string;
    const operatorToken = this.token;
    this.lexerNext();

    const values = [];
    if (!this.valueMissing(operatorToken)) {
      do {
        values.push(this.parseExpectedExpression(flowContext));
      }
      while (this.lexer.consume(','));
    }

    this.pushLocation(startMarker);
    return this.finishNode(AST.assignmentStatement(targets as Variable[], operator, values));
  }

  // Special PICO-8 print statement: ? expression '\n'
  parseSpecialPrint(flowContext: FlowContext): CallStatement {
    const startMarker = this.createLocationMarker();

    const args: Expression[] = [];
    this.lexer.withSignificantNewline(() => {
      let expression = this.parseExpectedExpression(flowContext);
      args.push(expression);

      // look for more args
      while (this.token.type === TokenType.Punctuator && this.token.value === ',') {
        this.lexerNext();
        expression = this.parseExpectedExpression(flowContext);
        args.push(expression);
      }
    });

    // Each part uses the same start marker. One instance of it was already
    // pushed above. finishNode will consume the top location on the stack so we
    // have to push 2 more times.
    const base = this.finishNode(AST.identifier('?'));
    this.pushLocation(startMarker);
    const callExpression = this.finishNode(AST.callExpression(base, args));
    this.pushLocation(startMarker);
    return this.finishNode(AST.callStatement(callExpression));
  }

  // Special PICO-8 include statement: '#include' filename
  parseIncludeStatement(): IncludeStatement {
    const line = this.token.value as string;

    const includeRegexp = /#include\s+(.*)$/;
    const match = includeRegexp.exec(line);
    if (!match) {
      errors.raiseUnexpectedToken('#include <filename>', this.token);
    }

    // skip over the rest of the line for the next statement to be parsed
    this.lexerNext();

    return this.finishNode({
      type: 'IncludeStatement',
      filename: match[1],
    });
  }

  getIncludeStatementError(statement: IncludeStatement, errorMessage: string) {
    const baseIncludeStatement = this.lexerStack.length >= 2 ? this.lexerStack[1].includeStatement! : statement;

    const fromPath: string = [ ...this.lexerStack ].reverse().map(l => path.basename(l.lexer.filename.path)).join(', which is #included from ');

    return new errors.ParseError(`Can't #include ${statement.filename} from ${fromPath}: ${errorMessage}`, baseIncludeStatement.loc!);
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
    const flowContext = new FlowContext(this.errors);
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
          this.errors.push(this.atEndOfPreviousLine(errors.createErrForToken(this.token, errMessages.expectedToken, '<name> or \'...\'', this.token.value)));

          // Discard tokens until we get a ')' or ','
          while (this.token.value !== ')' && this.token.value !== ',' && !endsParameterList(this.token)) {
            this.lexerNext();
          }

        }
      } while (this.lexer.consume(','));

      if (!this.lexer.consume(')')) {
        this.errors.push(this.atEndOfPreviousLine(errors.createErrForToken(this.token, errMessages.expected, ')', this.token.value)));

        // Discard tokens until we get a ')'
        while (this.token.value !== ')' && !endsParameterList(this.token)) {
          this.lexerNext();
        }
        this.lexer.consume(')');
      }
    }

    const headerEnd = this.previousToken.bounds.end;
    const body = this.parseBlock(flowContext);
    flowContext.popScope();
    const truncatedEnd = this.expectBlockEnd('end', opener, 'function', body, headerEnd);

    isLocal = isLocal || false;
    return endAt(this.finishNode(AST.functionStatement(name, parameters, isLocal, body)), truncatedEnd);
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
    const opener = this.previousToken;
    const fields = [];
    let key, value;

    while (true) {
      if (this.closesUnfinished(opener)) {
        break;
      }
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
          if (this.closesUnfinished(opener)) {
            this.popLocation();
            break;
          }
          value = this.parseExpectedExpression(flowContext);
          fields.push(this.finishNode(AST.tableKeyString(key, value)));
        } else {
          value = this.parseExpectedExpression(flowContext);
          fields.push(this.finishNode(AST.tableValue(value)));
        }
      } else {
        if (null == (value = this.parseExpression(flowContext))) {
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
    this.expectCloser('}', opener);
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
  //          | functiondef | tableconstructor
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
    if (++this.levels > MAX_LEVELS && canStartExpression(this.token, this.lexer.lookahead!)) {
      this.tooManyLevels();
      if (this.levels > MAX_PARSED_LEVELS) {
        this.markLocation();
        this.skipTooDeep(false);
        this.levels--;
        return this.finishNode(AST.literal(TokenType.NilLiteral, null, 'nil'));
      }
    }
    const expression = this.parseSubExpressionInLevel(minPrecedence, flowContext);
    this.levels--;
    return expression;
  }

  private enterStatementLevel(): boolean {
    if (++this.levels > MAX_LEVELS) {
      this.tooManyLevels();
      return this.levels > MAX_PARSED_LEVELS;
    }
    // A statement within the limit gets its own report of what is nested in
    // it too deep.
    this.reportedTooManyLevels = false;
    this.reportedStop = false;
    return false;
  }

  private tooManyLevels() {
    if (!this.reportedTooManyLevels) {
      this.reportedTooManyLevels = true;
      this.errors.push(errors.createErrForToken(this.token, errMessages.tooManyLevels, MAX_LEVELS, this.token.value));
    }
    if (this.levels > MAX_PARSED_LEVELS && !this.reportedStop) {
      this.reportedStop = true;
      this.errors.push(errors.createErrForToken(this.token, errMessages.tooManyLevels, MAX_LEVELS, this.token.value));
    }
  }

  // Past MAX_PARSED_LEVELS the code is skipped up to where what encloses it closes, so that its closers do not each
  // end a block of their own and get reported.
  private skipTooDeep(statement: boolean) {
    let depth = 0;
    let operand = true;
    while (this.token.type !== TokenType.EOF) {
      const token = this.token;
      if (depth === 0 && !operand) {
        const ends = statement
          ? token.type === TokenType.Newline || (token.type === TokenType.Punctuator && token.value === ';')
            || (this.isFirstOnLine(token.bounds.start) && canStartStatement(token))
          : !continuesExpression(token);
        if (ends) {
          break;
        }
      }
      // A bracket that closes nothing cannot end the block around a statement, and a skip stopped at it would never
      // move past it.
      if (closesNesting(token)) {
        if (depth > 0) {
          depth--;
        } else if (!statement || token.type === TokenType.Keyword) {
          break;
        }
      } else if (opensNesting(token)) {
        depth++;
      } else if (depth === 0 && token.type === TokenType.Keyword && (token.value === 'else' || token.value === 'elseif')) {
        break;
      }
      operand = isBinaryOperator(token) || isUnary(token)
        || (token.type === TokenType.Punctuator && (token.value === '.' || token.value === ':'));
      this.lexerNext();
    }
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
      const operatorToken = this.token;
      this.lexerNext();
      if (this.valueMissing(operatorToken)) {
        break;
      }
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
      case '[': {
        const opener = this.token;
        this.pushLocation(marker);
        this.lexerNext();
        // An index needs a key, so one closed before it is left out and the value is what it was indexing.
        if (this.closesUnfinished(opener)) {
          this.expectCloser(']', opener);
          this.popLocation();
          return base;
        }
        expression = this.parseExpectedExpression(flowContext);
        this.expectCloser(']', opener);
        return this.finishNode(AST.indexExpression(base, expression));
      }
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
        const opener = this.token;
        this.lexerNext();

        // List of expressions
        const expressions = [];
        let expression = this.closesUnfinished(opener) ? null : this.parseExpression(flowContext);
        if (null != expression) {
          expressions.push(expression);
        }
        while (this.lexer.consume(',')) {
          if (this.closesUnfinished(opener)) {
            break;
          }
          expression = this.parseExpectedExpression(flowContext);
          expressions.push(expression);
        }

        this.expectCloser(')', opener);
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
  //          | functiondef | tableconstructor | '...'

  parsePrimaryExpression(flowContext: FlowContext): Literal | FunctionDeclaration | TableConstructorExpression | null {
    const literals = [ TokenType.StringLiteral, TokenType.NumericLiteral, TokenType.BooleanLiteral, TokenType.NilLiteral, TokenType.VarargLiteral ];
    const value = this.token.value;
    const type = this.token.type;

    const marker = this.createLocationMarker();

    if (type === TokenType.VarargLiteral && !flowContext.allowVararg) {
      raiseErrForToken(this.token, errMessages.cannotUseVararg, this.token.value);
    }

    if (literals.includes(type)) {
      this.pushLocation(marker);
      const raw = this.lexer.input.slice(this.token.bounds.start.index, this.token.bounds.end.index);
      this.lexerNext();
      return this.finishNode(AST.literal(type, value, raw));
    } else if (type === TokenType.Keyword && 'function' === value) {
      // A named function can't be part of an expression: this is the next
      // statement after an unfinished one, so it's left for parseBlock.
      if (this.lexer.lookahead!.type === TokenType.Identifier) {
        errors.raiseUnexpectedToken('<expression>', this.token);
      }
      this.pushLocation(marker);
      this.lexerNext();
      return this.parseFunctionDeclaration(null, false);
    } else if (this.lexer.consume('{')) {
      this.pushLocation(marker);
      return this.parseTableConstructor(flowContext);
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

function canStartStatement(token: Token): boolean {
  switch (token.type) {
  case TokenType.Identifier:
    return true;
  case TokenType.Keyword:
    return [ 'function', 'local', 'if', 'for', 'while', 'repeat', 'do', 'return', 'goto', 'break' ].includes(token.value as string);
  case TokenType.Punctuator:
    return [ '::', '(', '?', '#', ';' ].includes(token.value as string);
  default:
    return false;
  }
}

// The start of a simple statement (an assignment, a call, a local or a return), the only kind parsed again: parsing a
// compound one again would take its blocks and their goto scopes along. A local function turns out to be compound at
// its `function`.
function mayParseAgain(token: Token): boolean {
  return token.type === TokenType.Identifier
    || (token.type === TokenType.Punctuator && token.value === '(')
    || (token.type === TokenType.Keyword && (token.value === 'local' || token.value === 'return'));
}

// A statement that stops anywhere else has failed.
function canFollowStatement(token: Token): boolean {
  return canStartStatement(token) || isBlockFollow(token) || token.type === TokenType.Newline;
}

function isStatementOnly(token: Token, lookahead: Token): boolean {
  if (token.type !== TokenType.Keyword) {
    return false;
  }
  if (token.value === 'function') {
    return lookahead.type === TokenType.Identifier;
  }
  return [ 'local', 'if', 'for', 'while', 'repeat', 'return', 'goto', 'break' ].includes(token.value as string);
}

// A `function` followed by a name is not a value: it starts the next statement.
function canStartExpression(token: Token, lookahead: Token): boolean {
  switch (token.type) {
  case TokenType.Identifier:
  case TokenType.StringLiteral:
  case TokenType.NumericLiteral:
  case TokenType.BooleanLiteral:
  case TokenType.NilLiteral:
  case TokenType.VarargLiteral:
    return true;
  case TokenType.Keyword:
    return token.value === 'not' || (token.value === 'function' && lookahead.type !== TokenType.Identifier);
  case TokenType.Punctuator:
    return [ '(', '{', '-', '#', '~', '@', '%', '$' ].includes(token.value as string);
  default:
    return false;
  }
}

// A keyword or the end of the file can't be in a parameter list, so skipping a
// broken one stops there, and the function body starts there.
function endsParameterList(token: Token): boolean {
  return token.type === TokenType.EOF || token.type === TokenType.Keyword;
}

// end: what expectBlockEnd returned, so every block whose closer is missing comes through here.
function endAt<T extends ASTNode>(node: T, end: CodeLocation | null): T {
  if (end && node.loc) {
    node.loc = { start: node.loc.start, end };
  }
  if (end) {
    Object.defineProperty(node, 'unclosed', { value: true });
  }
  return node;
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

function opensNesting(token: Token): boolean {
  return (token.type === TokenType.Punctuator && [ '(', '{', '[' ].includes(token.value as string))
    || (token.type === TokenType.Keyword && [ 'function', 'do', 'if', 'repeat' ].includes(token.value as string));
}

function closesNesting(token: Token): boolean {
  return (token.type === TokenType.Punctuator && [ ')', '}', ']' ].includes(token.value as string))
    || (token.type === TokenType.Keyword && (token.value === 'end' || token.value === 'until'));
}

function isBinaryOperator(token: Token): boolean {
  return (token.type === TokenType.Punctuator || token.type === TokenType.Keyword)
    && Operators.binaryPrecedenceOf(token.value as string) !== Operators.minPrecedenceValue;
}

function continuesExpression(token: Token): boolean {
  return isBinaryOperator(token) || token.type === TokenType.StringLiteral
    || (token.type === TokenType.Punctuator && [ '.', ':', '[', '(', '{' ].includes(token.value as string));
}
