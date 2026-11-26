import { Expression, Identifier, IndexExpression, Indexer, MemberExpression, TableConstructorExpression, Variable } from '../expressions';
import { AnonymousFunctionName, AssignmentStatement, Block, Chunk, ForGenericStatement, ForNumericStatement,
  FunctionDeclaration, GotoStatement, IncludeStatement, isStatementWithBody, LabelStatement, LocalStatement, Statement } from '../statements';
import { resolveIncludeFile } from '../file-resolver';
import { ASTNode, Bounds, boundsContain, CodeLocation } from '../types';
import { ASTVisitor, VisitableASTNode } from '../visitor';
import { addEntry, CodeSymbolType, isColonMethod, moveEntry, OutlineBlock, OutlineEntry, Owner, signatureOf } from '../outline/model';
import { defineMember, pathMember, receiveTable, tableTypeOf, unwrapValue } from '../outline/members';
import { findBoundaryLines, groupMethodRuns, StatementInfo } from '../outline/method-runs';
import { Analysis, LuaSymbol, Reference, Scope } from './model';

type Decl = {
  kind: 'local' | 'param' | 'loopvar',
  symbol: LuaSymbol,
  entry?: OutlineEntry,
  // Set for locals declared by a LocalStatement; absent for local function and params/loopvars.
  // While this stmt is on the nodeStack (its initializers are being visited), the decl is hidden.
  stmt?: Statement,
  // The decl shadowed by this one in the same scope, if any.
  previous?: Decl,
  // A local declared without a value, or with nil.
  forward?: boolean,
};

// What a name refers to at some point: its innermost declaration, or else the global.
type Binding = Decl | { kind: 'global', symbol: LuaSymbol, entry?: OutlineEntry };

// For a deeper method path (e.g. T.a:m), the last intermediate table may not exist yet;
// selfPath holds the info to create it on the first self.k = v that needs it, and stays after that, since the keys
// of self's fields count on top of its segments. loc: the range of the method's target.
type SelfPath = { root: OutlineEntry, segments: Identifier[], loc: Bounds };

// selfSymbol is the table self means in a method, as far as names tell. A flat target's symbol is the member a
// function defines, or the variable that holds a table. natural: the function or file a function is in, when
// callbackOwner put it under an entry there instead.
type ValueTarget =
  | { kind: 'entry', entry: OutlineEntry, selfTable?: OutlineEntry | null, selfPath?: SelfPath, selfSymbol?: LuaSymbol }
  | { kind: 'flat', owner: Owner, natural?: Owner, name: string, loc?: Bounds, selectionLoc?: Bounds, symbol?: LuaSymbol } // rule 7, unnamed table
  | { kind: 'anonymous', owner: Owner, natural?: Owner };

// order: taken where the goto is, though the label it goes to may come later.
type PendingGoto = { label: Identifier, blocks: BinderScope[], order: number };

// An #include whose content the analysis is in. file and included are ResolvedFile paths; end is where it ends in file.
type OpenInclude = { file: string, included: string, end: number };

// The outline leaves out a member path with more keys than this. It nests an entry per key and Ctrl+T names each
// entry with its whole path, so a longer path would give names whose total length grows with the square of its keys,
// and nesting that can overflow the stack where the outline is walked recursively.
const MAX_OUTLINE_KEYS = 200;

class BinderScope {
  decls = new Map<string, Decl>();
  // undefined = inherit from enclosing scope; null = this function binds self but its table is unknown
  selfTable?: OutlineEntry | null;
  selfPath?: SelfPath;
  // In a function that binds no self, self is a variable of that function whose table is unknown.
  implicitSelf?: Decl;
  readonly labels = new Map<string, LuaSymbol>();
  // A goto may jump to a label further down, so a function, or the file, resolves its gotos when it ends.
  readonly gotos: PendingGoto[] = [];
  outlineBlock?: OutlineBlock;
  // The block whose condition or iterators are being visited in this scope: the visitor enters a block's scope only
  // after its header.
  header?: OutlineBlock;
  // analysisScope: the scope the analysis keeps, which a table constructor shares with the scope around it.
  constructor(public owner: Owner, public kind: 'file' | 'function' | 'block', readonly analysisScope: Scope, public block?: Block) {}
}

class Binder extends ASTVisitor<BinderScope> {
  readonly root: Owner = { children: [] };
  readonly globals = new Map<string, LuaSymbol>();
  readonly references: Reference[] = [];
  readonly fileScope: Scope = { kind: 'file', children: [], declarations: [] };
  readonly includeScopes = new Map<string, Scope>();
  readonly includeStarts = new Map<string, number>();
  readonly includeCheckpoints = new Map<string, Array<{ index: number, order: number }>>();
  readonly codeStarts = new Map<string, number>();
  readonly blocks: OutlineBlock[] = [];
  private order = 0;
  // The chain of #includes whose content the analysis is in, outermost first.
  private readonly openIncludes: OpenInclude[] = [];
  // The first entry each global name got in each file: by name, then by ResolvedFile.path.
  private readonly globalEntries = new Map<string, Map<string, OutlineEntry>>();
  // For each expression value, where to attach it in the outline. The statement hooks fill this in before the
  // visitor reaches the values (so do function and table constructor hooks for the values inside them); the
  // whole design relies on that order.
  private readonly targets = new Map<Expression, ValueTarget>();
  private readonly statementInfo = new Map<Statement, StatementInfo>();
  // Names and member expressions that a statement hook recorded before the visitor reaches them.
  private readonly recorded = new Set<ASTNode>();
  // The entry each value was listed with, recorded by the statement and constructor hooks: the callbacks in a value
  // can go under it.
  private readonly valueEntries = new Map<ASTNode, OutlineEntry>();
  // The function entries that callbackOwner put under an entry, with the function or file they are in.
  private readonly nestedCallbacks: Array<{ entry: OutlineEntry, natural: Owner }> = [];
  // The node of the first definition that assigns each function, where its doc is read, so that its parameters take
  // their @param from there even when the function starts on a later line, as with `t.on_hit =` on one line and
  // `function(a)` on the next. The statement and table constructor hooks define a function before the visitor reaches
  // its parameters.
  private readonly functionDocNodes = new Map<FunctionDeclaration, ASTNode>();
  // The symbol of each member path that pathSymbol has gone down. The visitor reaches a chain's links from the
  // outside in and each asks for the symbol of its base, so going down every path again would take time that grows
  // with the square of its length.
  private readonly paths = new Map<MemberExpression, LuaSymbol | undefined>();

  constructor(private readonly boundaryLines: Map<string, number[]>) {
    super();
  }

  override visit(chunk: Chunk): void {
    super.visit(chunk);
    this.closeIncludes();
    this.resolveGotos(this.scopeStack[0]);
    groupMethodRuns(chunk.block.body, this.statementInfo, this.boundaryLines);
    this.noteCodeStarts(chunk.block.body);
    this.liftUnreachableCallbacks();
  }

  override onExitScope(scope: BinderScope): void {
    if (scope.kind === 'function') {
      this.resolveGotos(scope);
    }
    if (scope.block) {
      groupMethodRuns(scope.block.body, this.statementInfo, this.boundaryLines);
      this.noteCodeStarts(scope.block.body);
    }
  }

  // An #include splices the statements of its file into the body it is in.
  private noteCodeStarts(statements: Statement[]): void {
    for (const { loc } of statements) {
      const { filename, index } = loc!.start;
      const start = this.codeStarts.get(filename.path);
      if (start === undefined || index < start) {
        this.codeStarts.set(filename.path, index);
      }
    }
  }

  override startingScope(): BinderScope {
    return new BinderScope(this.root, 'file', this.fileScope);
  }

  createDefaultScope(scopeNode: VisitableASTNode | null): BinderScope {
    const loc = scopeNode?.loc;
    const scope = new BinderScope(this.topScope().owner, 'block', { kind: 'block', loc, children: [], declarations: [] },
      isStatementWithBody(scopeNode) ? scopeNode.block : undefined);
    const outlineBlock = scopeNode ? this.outlineBlockOf(scopeNode) : undefined;
    if (outlineBlock) {
      scope.outlineBlock = outlineBlock;
      this.blocks.push(outlineBlock);
      this.topScope().header = outlineBlock;
    }
    return scope;
  }

  private outlineBlockOf(node: VisitableASTNode): OutlineBlock | undefined {
    const header = blockHeader(node);
    const { loc } = node;
    if (!header || !loc) {
      return undefined;
    }
    const { keyword, headerEnd } = header;
    const { start } = loc;
    const owner = this.topScope().owner;
    // An #include in a block of another file puts this file's blocks inside it, and a block's name is read from the
    // text of its own file.
    let parent = this.innermostBlock();
    while (parent && !parent.loc.start.filename.equals(start.filename)) {
      parent = parent.parent;
    }
    return {
      keyword,
      loc: this.branchRange(node, loc),
      selectionLoc: { start, end: { ...start, column: start.column + keyword.length, index: start.index + keyword.length } },
      headerEnd,
      owner: owner === this.root ? undefined : owner as OutlineEntry,
      parent,
      variables: [],
    };
  }

  // The parser's range of a branch runs over the keyword of the next one, where breadcrumbs would then show this one.
  private branchRange(node: VisitableASTNode, loc: Bounds): Bounds {
    const ifStatement = this.topNode()?.node;
    if ((node.type !== 'IfClause' && node.type !== 'ElseifClause') || ifStatement?.type !== 'IfStatement') {
      return loc;
    }
    const next = ifStatement.clauses[ifStatement.clauses.indexOf(node) + 1];
    return next?.loc ? { start: loc.start, end: next.loc.start } : loc;
  }

  // Stops at the function or file being analysed: a block around a function holds the function, not what its body
  // defines. A table constructor's scope has no block and is passed through.
  private innermostBlock(): OutlineBlock | undefined {
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      const { header, kind, outlineBlock } = this.scopeStack[i];
      if (header) {
        return header;
      }
      if (kind !== 'block') {
        return undefined;
      }
      if (outlineBlock) {
        return outlineBlock;
      }
    }
    return undefined;
  }

  // The block an entry is created in decides which block node it goes under when the outline shows blocks. members.ts
  // does not come here: a member stays under its table.
  private addEntry(parent: Owner, name: string, type: CodeSymbolType, loc: Bounds, selectionLoc: Bounds, detail?: string): OutlineEntry {
    const entry = addEntry(parent, name, type, loc, selectionLoc, detail);
    entry.block = this.innermostBlock();
    return entry;
  }

  // A scope joins the tree when it is entered. A function in a loop header or a condition is entered before the
  // loop or clause, whose range contains it too, so visibleAt's descent, which takes the first child that contains
  // the cursor, finds the function.
  override onEnterScope(scope: BinderScope): void {
    if (scope.outlineBlock) {
      this.topScope(1).header = undefined;
    }
    const parent = this.topScope(1).analysisScope;
    if (scope.analysisScope !== parent) {
      scope.analysisScope.parent = parent;
      parent.children.push(scope.analysisScope);
    }
  }

  override visitIncludeStatement(node: IncludeStatement): void {
    const file = node.loc!.start.filename;
    this.closeIncludes(file.path);
    const included = (node.resolvedFile ?? resolveIncludeFile(file, node.filename)).path;
    if (!this.includeScopes.has(included)) {
      this.includeScopes.set(included, this.topScope().analysisScope);
      this.includeStarts.set(included, this.order);
    }
    this.openIncludes.push({ file: file.path, included, end: node.loc!.end.index });
  }

  // The content of an #include ends where the analysis next comes to something in a file outside it: the includer,
  // or a file further up the chain. Its checkpoint gets the order reached by then.
  private closeIncludes(file?: string): void {
    while (this.openIncludes.length > 0 && this.openIncludes[this.openIncludes.length - 1].included !== file) {
      const { file: includer, end } = this.openIncludes.pop()!;
      listIn(this.includeCheckpoints, includer).push({ index: end, order: this.order });
    }
  }

  private nextOrder(file: string): number {
    this.closeIncludes(file);
    return this.order++;
  }

  override visitFunctionDeclaration(node: FunctionDeclaration): BinderScope {
    if (node.identifier?.type === 'Identifier' && node.isLocal) {
      // local function name() end — declare in the enclosing scope before entering body
      const outer = this.topScope();
      const symbol = new LuaSymbol('local', node.identifier.name);
      this.define(symbol, node.identifier, node.loc!, node, node);
      const entry = this.link(this.addEntry(outer.owner, node.identifier.name, CodeSymbolType.Function,
        node.loc!, node.identifier.loc!), symbol);
      this.targets.set(node, { kind: 'entry', entry });
      outer.decls.set(node.identifier.name, { kind: 'local', symbol, entry });
      this.declare(outer, symbol, node.identifier.loc!.end);
      this.statementInfo.set(node, { about: entry, defines: entry });
    } else if (node.identifier) {
      // function f() end and function t.f() end — same as f = function() end and t.f = function() end
      this.recordStatement(node, [ this.assign(node.identifier, node, node, node.loc!, false) ]);
    }

    // A function value that nothing gave a target, such as a callback, is listed as anonymous.
    const target: ValueTarget | undefined = this.targets.get(node)
      ?? (node.identifier ? undefined : { kind: 'anonymous', ...this.callbackOwner() });
    let entry: OutlineEntry | undefined;
    if (target?.kind === 'entry') {
      target.entry.detail = signatureOf(node);
      entry = target.entry;
    } else if (target) {
      entry = target.kind === 'flat'
        ? this.link(this.addEntry(target.owner, target.name, CodeSymbolType.Method, target.loc ?? node.loc!, target.selectionLoc ?? node.loc!,
          signatureOf(node)), target.symbol)
        : this.addEntry(target.owner, AnonymousFunctionName, CodeSymbolType.Function, node.loc!, node.loc!, signatureOf(node));
      if (target.natural) {
        this.nestedCallbacks.push({ entry, natural: target.natural });
      }
    }
    if (entry) {
      entry.parameters = node.parameters.flatMap(parameter => parameter.type === 'Identifier' ? [{ name: parameter.name, loc: parameter.loc! }] : []);
    }
    const owner: Owner = entry ?? this.topScope().owner;

    const scope = new BinderScope(owner, 'function', { kind: 'function', loc: node.loc, children: [], declarations: [] }, node.block);

    const firstParam = node.parameters[0];
    const firstParamIsSelf = firstParam?.type === 'Identifier' && firstParam.name === 'self';
    const colonMethod = isColonMethod(node);
    let selfSymbol: LuaSymbol | undefined;
    if (colonMethod || firstParamIsSelf) {
      if (target?.kind === 'entry' && target.selfTable !== undefined) {
        scope.selfTable = target.selfTable;
      } else if (target?.kind === 'entry' && target.selfPath) {
        scope.selfPath = target.selfPath;
      } else {
        scope.selfTable = null;
      }
      selfSymbol = target?.kind === 'entry' ? target.selfSymbol : undefined;
    } else if (node.parameters.some(p => p.type === 'Identifier' && p.name === 'self')) {
      scope.selfTable = null;
    }

    // The syntax tree has no place for the closing parenthesis, so the parameters count from the end of the last one,
    // or of the name.
    const parametersEnd = (node.parameters[node.parameters.length - 1] ?? node.identifier)?.loc!.end ?? node.loc!.start;
    if (colonMethod) {
      const self = new LuaSymbol('self', 'self');
      self.table = selfSymbol;
      scope.decls.set('self', { kind: 'param', symbol: self });
      this.declare(scope, self, parametersEnd);
    }
    for (const param of node.parameters) {
      if (param.type === 'Identifier') {
        const isSelf = param.name === 'self';
        const symbol = new LuaSymbol(isSelf ? 'self' : 'param', param.name);
        if (isSelf && param === firstParam) {
          symbol.table = selfSymbol;
        }
        this.define(symbol, param, param.loc!, this.functionDocNodes.get(node) ?? node);
        scope.decls.set(param.name, { kind: 'param', symbol });
        this.declare(scope, symbol, parametersEnd);
      }
    }
    return scope;
  }

  override visitAssignmentStatement(node: AssignmentStatement): void {
    const compound = node.operator !== '=';
    this.recordStatement(node, node.variables.map((variable, i) =>
      this.assign(variable, node.init[i], node, targetRange(node, i), compound)));
  }

  override visitLocalStatement(node: LocalStatement): void {
    this.recordStatement(node, node.variables.map((variable, i) => {
      if (variable.type !== 'Identifier') {
        return undefined;
      }
      const value = node.init[i];
      const loc = targetRange(node, i);
      const previous = this.topScope().decls.get(variable.name);
      const unwrapped = unwrapValue(value);
      const symbol = new LuaSymbol('local', variable.name);
      this.define(symbol, variable, node.loc!, node, value);
      let entry: OutlineEntry;
      if (value?.type === 'FunctionDeclaration') {
        entry = this.addEntry(this.topScope().owner, variable.name, CodeSymbolType.Function, loc, variable.loc!);
        this.targets.set(value, { kind: 'entry', entry });
      } else if (unwrapped?.type === 'TableConstructorExpression') {
        entry = this.addEntry(this.topScope().owner, variable.name, tableTypeOf(unwrapped), loc, variable.loc!);
        this.targets.set(unwrapped, { kind: 'entry', entry });
      } else {
        entry = this.addEntry(this.topScope().owner, variable.name, CodeSymbolType.Variable, loc, variable.loc!);
      }
      this.link(entry, symbol);
      this.recordValue(entry, value);
      const forward = !value || value.type === 'NilLiteral';
      this.topScope().decls.set(variable.name, { kind: 'local', symbol, entry, stmt: node, previous, forward });
      // At the end of the statement the cursor is still on its value, as in local a = pl.
      this.declare(this.topScope(), symbol, node.loc!.end, true);
      return { about: entry, defines: entry };
    }));
  }

  override visitForNumericStatement(node: ForNumericStatement): BinderScope {
    const scope = this.createDefaultScope(node);
    this.declareLoopVariable(scope, node.variable, node);
    return scope;
  }

  override visitForGenericStatement(node: ForGenericStatement): BinderScope {
    const scope = this.createDefaultScope(node);
    for (const variable of node.variables) {
      this.declareLoopVariable(scope, variable, node);
    }
    return scope;
  }

  private declareLoopVariable(scope: BinderScope, variable: Identifier, node: ForNumericStatement | ForGenericStatement): void {
    const symbol = new LuaSymbol('loopvar', variable.name);
    this.define(symbol, variable, variable.loc!, node);
    scope.decls.set(variable.name, { kind: 'loopvar', symbol });
    scope.outlineBlock?.variables.push({ name: variable.name, loc: variable.loc! });
    const lastInHeader = node.type === 'ForNumericStatement' ? (node.step ?? node.end) : node.iterators[node.iterators.length - 1];
    this.declare(scope, symbol, lastInHeader.loc!.end);
  }

  override visitLabelStatement(node: LabelStatement): void {
    const scope = this.topScope();
    const symbol = new LuaSymbol('label', node.label.name);
    this.define(symbol, node.label, node.loc!, node);
    scope.labels.set(node.label.name, symbol);
    this.link(this.addEntry(scope.owner, node.label.name, CodeSymbolType.Label, node.loc!, node.label.loc!), symbol);
  }

  override visitGotoStatement(node: GotoStatement): void {
    this.recorded.add(node.label);
    const order = this.nextOrder(node.label.loc!.start.filename.path);
    const blocks: BinderScope[] = [];
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      const scope = this.scopeStack[i];
      blocks.push(scope);
      if (scope.kind !== 'block') {
        scope.gotos.push({ label: node.label, blocks, order });
        return;
      }
    }
  }

  // A goto with no label to go to gets no reference: the parser reports it.
  private resolveGotos(scope: BinderScope): void {
    for (const { label, blocks, order } of scope.gotos) {
      const target = blocks.find(block => block.labels.has(label.name))?.labels.get(label.name);
      if (target) {
        this.addReference({ symbol: target, loc: label.loc!, read: true, write: false, isCall: false }, order);
      }
    }
  }

  override visitIdentifier(node: Identifier): void {
    const parent = this.topNode()?.node;
    // A key is recorded with its member expression; ? is the print shorthand.
    if (this.recorded.has(node) || node.name === '?' || (parent?.type === 'MemberExpression' && parent.identifier === node)) {
      return;
    }
    this.read(this.resolve(node).symbol, node.loc!);
  }

  override visitMemberExpression(node: MemberExpression): void {
    if (this.recorded.has(node)) {
      return;
    }
    const parent = this.topNode()?.node;
    const isCall = (parent?.type === 'CallExpression' || parent?.type === 'StringCallExpression' || parent?.type === 'TableCallExpression')
      && parent.base === node;
    this.read(this.tableOf(node.base).member(node.identifier.name), node.identifier.loc!, isCall);
  }

  override visitTableConstructorExpression(node: TableConstructorExpression): BinderScope {
    const target = this.targets.get(node);
    if (target?.kind === 'entry') {
      const tableEntry = target.entry;
      const table = tableEntry.symbol;
      for (const field of node.fields) {
        if (field.type === 'TableKeyString') {
          const member = table?.member(field.key.name);
          if (member) {
            this.define(member, field.key, field.loc!, field, field.value);
          }
          if (field.value.type === 'FunctionDeclaration') {
            const method = this.link(this.addEntry(tableEntry, field.key.name, CodeSymbolType.Method, field.loc!, field.key.loc!), member);
            this.targets.set(field.value, { kind: 'entry', entry: method, selfTable: tableEntry, selfSymbol: table });
            continue;
          }
          const unwrapped = unwrapValue(field.value);
          let memberEntry: OutlineEntry;
          if (unwrapped?.type === 'TableConstructorExpression') {
            const innerCtor = unwrapped as TableConstructorExpression;
            memberEntry = this.memberEntry(tableEntry, field.key.name, tableTypeOf(innerCtor), field.loc!, field.key.loc!);
            receiveTable(memberEntry, innerCtor);
            this.targets.set(innerCtor, { kind: 'entry', entry: memberEntry });
          } else {
            memberEntry = this.memberEntry(tableEntry, field.key.name, CodeSymbolType.Field, field.loc!, field.key.loc!);
          }
          this.recordValue(memberEntry, field.value);
        } else if (field.type === 'TableValue' || field.type === 'TableKey') {
          this.registerPositionalTarget(field.value, tableEntry);
        }
      }
    } else {
      const { owner, natural } = target?.kind === 'flat' ? target : this.callbackOwner();
      const prefix = target?.kind === 'flat' ? target.name : '';
      const named = target?.kind === 'flat' ? target.symbol : undefined;
      // The keys of a table that no name holds still get symbols, so that a method call on some other table
      // can find its methods by key.
      const table = named ?? new LuaSymbol('value', '');
      for (const field of node.fields) {
        if (field.type === 'TableKeyString') {
          const member = table.member(field.key.name);
          this.define(member, field.key, field.loc!, field, field.value);
          if (field.value.type === 'FunctionDeclaration') {
            this.targets.set(field.value, { kind: 'flat', owner, natural, name: prefix ? `${prefix}.${field.key.name}` : field.key.name,
              loc: field.loc!, selectionLoc: field.key.loc!, symbol: named && member });
          } else {
            const unwrapped = unwrapValue(field.value);
            if (unwrapped?.type === 'TableConstructorExpression') {
              this.targets.set(unwrapped as TableConstructorExpression, { kind: 'flat', owner, natural,
                name: prefix ? `${prefix}.${field.key.name}` : '', symbol: named && member });
            }
          }
        } else if (field.type === 'TableValue' || field.type === 'TableKey') {
          this.registerPositionalTarget(field.value, owner, natural);
        }
      }
    }
    // A scope to the visitor only: nothing can be declared in a table constructor.
    return new BinderScope(this.topScope().owner, 'block', this.topScope().analysisScope);
  }

  // loc: the range of this target's entries.
  private assign(variable: Variable, value: Expression | undefined, statement: Statement, loc: Bounds, compound: boolean): StatementInfo | undefined {
    if (variable.type === 'Identifier') {
      return this.assignName(variable, value, statement, loc, compound);
    } else if (variable.type === 'MemberExpression') {
      return this.assignMember(variable, value, statement, loc, compound);
    }
    return this.assignIndex(variable);
  }

  // t[k] = v and t.a[k] = v are about t, as t.k = v is, so that they don't break a run of t's methods.
  private assignIndex(variable: IndexExpression): StatementInfo | undefined {
    let base = variable.base;
    while (base.type === 'IndexExpression' || base.type === 'MemberExpression') {
      base = base.base;
    }
    const entry = base.type === 'Identifier' ? this.resolve(base).entry : undefined;
    return entry && { about: entry };
  }

  // A statement is about a table only when all of its targets are.
  private recordStatement(statement: Statement, perTarget: Array<StatementInfo | undefined>): void {
    const about = perTarget[0]?.about;
    if (!about || perTarget.some(info => info?.about !== about)) {
      return;
    }
    this.statementInfo.set(statement, {
      about,
      defines: perTarget.some(info => info?.defines) ? about : undefined,
      methods: perTarget.flatMap(info => info?.methods ?? []),
    });
  }

  private assignName(name: Identifier, value: Expression | undefined, statement: Statement, loc: Bounds,
    compound: boolean): StatementInfo | undefined {
    const binding = this.resolve(name);
    if (compound && binding.kind === 'global') {
      // In PICO-8, x += 1 fails on a global that was never assigned, so a plain assignment elsewhere defines it.
      this.write(binding.symbol, name, true);
      return binding.entry && { about: binding.entry };
    }
    this.define(binding.symbol, name, statement.loc!, statement, value, compound);
    const unwrapped = unwrapValue(value);

    if (binding.kind !== 'global') {
      if (value?.type === 'FunctionDeclaration') {
        const entry = this.link(this.addEntry(this.topScope().owner, name.name, CodeSymbolType.Function,
          loc, name.loc!), binding.symbol);
        this.targets.set(value, { kind: 'entry', entry });
        this.hideForwardDeclaration(binding, entry);
      } else if (unwrapped?.type === 'TableConstructorExpression' && binding.kind === 'local' && binding.entry) {
        const ctor = unwrapped as TableConstructorExpression;
        receiveTable(binding.entry, ctor);
        this.targets.set(ctor, { kind: 'entry', entry: binding.entry });
      } else if (unwrapped?.type === 'TableConstructorExpression') {
        // Listed as an unnamed table, but its keys are still members of the variable.
        this.targets.set(unwrapped as TableConstructorExpression, { kind: 'flat', owner: this.topScope().owner, name: '', symbol: binding.symbol });
      }
      return binding.entry && { about: binding.entry, defines: binding.entry };
    }

    if (value?.type === 'FunctionDeclaration') {
      // Listed under the enclosing function, if any: its range lies inside that function's, and breadcrumbs
      // only follow entries whose ranges contain the cursor.
      const entry = this.link(this.addEntry(this.topScope().owner, name.name, CodeSymbolType.Function, loc, name.loc!), binding.symbol);
      this.targets.set(value, { kind: 'entry', entry });
      if (!binding.entry) {
        this.setGlobalEntry(name, entry);
      }
    } else {
      if (binding.entry?.implicit) {
        binding.entry.loc = loc;
        binding.entry.selectionLoc = name.loc!;
        binding.entry.implicit = false;
      }
      if (unwrapped?.type === 'TableConstructorExpression') {
        const ctor = unwrapped as TableConstructorExpression;
        if (binding.entry) {
          receiveTable(binding.entry, ctor);
          this.targets.set(ctor, { kind: 'entry', entry: binding.entry });
        } else {
          const entry = this.link(this.addEntry(this.root, name.name, tableTypeOf(ctor), loc, name.loc!), binding.symbol);
          this.setGlobalEntry(name, entry);
          this.targets.set(ctor, { kind: 'entry', entry });
        }
      } else if (!binding.entry) {
        this.setGlobalEntry(name,
          this.link(this.addEntry(this.root, name.name, CodeSymbolType.Variable, loc, name.loc!), binding.symbol));
      }
    }
    const table = this.globalEntry(name)!;
    this.recordValue(table, value);
    return { about: table, defines: table };
  }

  // local f, then f = function() end in the same function: the function's entry is enough. Not when the function is in
  // another file, whose outline lists it: the declaration's file would lose the name.
  private hideForwardDeclaration(binding: Binding, functionEntry: OutlineEntry): void {
    const declared = binding.kind === 'local' && binding.forward ? binding.entry : undefined;
    if (declared && declared.members.size === 0 && declared.children.length === 0 && declared.parent === functionEntry.parent
      && declared.loc.start.filename.equals(functionEntry.loc.start.filename)) {
      declared.hidden = true;
    }
  }

  private assignMember(variable: MemberExpression, value: Expression | undefined, statement: Statement, loc: Bounds,
    compound: boolean): StatementInfo | undefined {
    this.recorded.add(variable);
    const member = this.tableOf(variable.base).member(variable.identifier.name);
    this.define(member, variable.identifier, statement.loc!, statement, value, compound);

    const segments: Identifier[] = [ variable.identifier ];
    let base: Expression = variable.base;
    while (base.type === 'MemberExpression') {
      segments.push(base.identifier);
      base = base.base;
    }
    segments.reverse();
    if (base.type !== 'Identifier') {
      return;
    }
    const root = base as Identifier;

    if (root.name === 'self' && this.resolveSelfBinding() !== 'local-or-loopvar') {
      if (value?.type === 'FunctionDeclaration') {
        return this.addMethod(value, root, segments, variable.indexer, undefined, loc, member);
      }
      // In a method such as function a.b:m(), self's fields go at the end of the method's path, so the keys of both
      // count as those of one path. Checked first: resolveSelfTable makes an entry for each key of the method's path.
      const path = this.methodPath();
      if (path && path.segments.length + segments.length > MAX_OUTLINE_KEYS) {
        return undefined;
      }
      const selfTable = this.resolveSelfTable();
      if (!selfTable) {
        this.assignUnknownRoot(root, segments, value, member);
        return undefined;
      }
      return this.addMemberField(selfTable, segments, value, loc);
    }

    const binding = this.resolve(root);
    if (binding.kind === 'param' || binding.kind === 'loopvar') {
      if (value?.type === 'FunctionDeclaration') {
        return this.addMethod(value, root, segments, variable.indexer, undefined, loc, member);
      }
      this.assignUnknownRoot(root, segments, value, member); // the outline can't know which table was passed in
      return undefined;
    }

    if (value?.type === 'FunctionDeclaration') {
      // Grouping takes this file's entry only, but self.k = v still goes under the table when another file has its entry.
      const selfTable = binding.entry ?? (binding.kind === 'global' ? this.anyGlobalEntry(root.name) : undefined);
      return this.addMethod(value, root, segments, variable.indexer, binding.entry, loc, member, selfTable);
    }

    let rootEntry = binding.entry;
    if (!rootEntry) {
      if (binding.kind !== 'global') {
        return;
      }
      rootEntry = this.link(this.addEntry(this.root, root.name, CodeSymbolType.Table, loc, root.loc!), binding.symbol);
      rootEntry.implicit = true;
      this.setGlobalEntry(root, rootEntry);
    }

    return this.addMemberField(rootEntry, segments, value, loc);
  }

  private addMemberField(rootEntry: OutlineEntry, segments: Identifier[], value: Expression | undefined, loc: Bounds): StatementInfo {
    if (segments.length > MAX_OUTLINE_KEYS) {
      return { about: rootEntry };
    }
    const unwrapped = unwrapValue(value);
    let tableEntry = rootEntry;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      tableEntry = this.pathEntry(tableEntry, seg.name, loc, seg.loc!);
    }
    const lastSeg = segments[segments.length - 1];
    const memberType = unwrapped?.type === 'TableConstructorExpression'
      ? tableTypeOf(unwrapped as TableConstructorExpression) : CodeSymbolType.Field;
    const member = this.memberEntry(tableEntry, lastSeg.name, memberType, loc, lastSeg.loc!);
    if (unwrapped?.type === 'TableConstructorExpression') {
      const ctor = unwrapped as TableConstructorExpression;
      receiveTable(member, ctor);
      this.targets.set(ctor, { kind: 'entry', entry: member });
    }
    this.recordValue(member, value);
    return { about: rootEntry };
  }

  // A method written as its own statement: function a.b(), function a:b() or a.b = function() end. table: the entry
  // to group the method under; selfTable: the entry self's fields go under.
  private addMethod(fn: FunctionDeclaration, root: Identifier, segments: Identifier[], indexer: Indexer,
    table: OutlineEntry | undefined, loc: Bounds, member: LuaSymbol, selfTable = table): StatementInfo | undefined {
    const key = segments[segments.length - 1];
    const name = [ root, ...segments.slice(0, -1) ].map(id => id.name).join('.') + indexer + key.name;
    const entry = this.link(this.addEntry(this.topScope().owner, name, CodeSymbolType.Method, loc, key.loc!), member);
    const intermediates = segments.slice(0, -1);
    const firstParam = fn.parameters[0];
    const isSelfMethod = indexer === ':' || (firstParam?.type === 'Identifier' && firstParam.name === 'self');
    if (isSelfMethod) {
      const selfSymbol = member.owner;
      if (intermediates.length === 0) {
        this.targets.set(fn, { kind: 'entry', entry, selfTable: selfTable ?? null, selfSymbol });
      } else if (selfTable) {
        this.targets.set(fn, { kind: 'entry', entry, selfPath: { root: selfTable, segments: intermediates, loc }, selfSymbol });
      } else {
        this.targets.set(fn, { kind: 'entry', entry, selfTable: null, selfSymbol });
      }
    } else {
      this.targets.set(fn, { kind: 'entry', entry });
    }
    if (table && segments.length === 1) {
      return { about: table, methods: [{ entry, key: key.name }] };
    }
    return table && { about: table };
  }

  private assignUnknownRoot(root: Identifier, segments: Identifier[], value: Expression | undefined, member: LuaSymbol): void {
    const unwrapped = unwrapValue(value);
    if (unwrapped?.type === 'TableConstructorExpression') {
      const pathName = [ root, ...segments ].map(id => id.name).join('.');
      this.targets.set(unwrapped as TableConstructorExpression, { kind: 'flat', owner: this.topScope().owner, name: pathName, symbol: member });
    }
  }

  private registerPositionalTarget(value: Expression, owner: Owner, natural?: Owner): void {
    if (value.type === 'FunctionDeclaration') {
      this.targets.set(value, { kind: 'anonymous', owner, natural });
    } else {
      const unwrapped = unwrapValue(value);
      if (unwrapped?.type === 'TableConstructorExpression') {
        this.targets.set(unwrapped as TableConstructorExpression, { kind: 'flat', owner, natural, name: '' });
      }
    }
  }

  // A definition, and its name as a reference: written, and for x += 1 read first.
  private define(symbol: LuaSymbol, name: Identifier, loc: Bounds, node: ASTNode, value?: Expression, compound = false): void {
    const isFunction = value?.type === 'FunctionDeclaration';
    symbol.definitions.push({ loc, nameLoc: name.loc!, node, value, isFunction, compound });
    if (isFunction) {
      symbol.signature = signatureOf(value);
      if (!this.functionDocNodes.has(value)) {
        this.functionDocNodes.set(value, node);
      }
    }
    this.write(symbol, name, compound);
  }

  private write(symbol: LuaSymbol, name: Identifier, compound: boolean): void {
    this.recorded.add(name);
    this.addReference({ symbol, loc: name.loc!, read: compound, write: true, isCall: false });
  }

  private read(symbol: LuaSymbol, loc: Bounds, isCall = false): void {
    this.addReference({ symbol, loc, read: true, write: false, isCall });
  }

  private addReference(unordered: Omit<Reference, 'order'>, order?: number): void {
    const reference = { ...unordered, order: order ?? this.nextOrder(unordered.loc.start.filename.path) };
    reference.symbol.references.push(reference);
    this.references.push(reference);
  }

  // For completion: symbol is visible in scope from `from` on, or only past it.
  private declare(scope: BinderScope, symbol: LuaSymbol, from: CodeLocation, past = false): void {
    const order = this.nextOrder(from.filename.path);
    scope.analysisScope.declarations.push({ symbol, file: from.filename, visibleFrom: past ? from.index + 1 : from.index, order });
  }

  private link(entry: OutlineEntry, symbol: LuaSymbol | undefined): OutlineEntry {
    if (symbol && !entry.symbol) {
      entry.symbol = symbol;
      symbol.entries.push(entry);
    }
    return entry;
  }

  // The member entries of a table entry stand for the members of the table's symbol. memberEntry is for a member's own
  // definition, pathEntry for a member a deeper path goes through.
  private memberEntry(table: OutlineEntry, key: string, type: CodeSymbolType, loc: Bounds, selectionLoc: Bounds): OutlineEntry {
    return this.link(defineMember(table, key, type, loc, selectionLoc), table.symbol?.member(key));
  }

  private pathEntry(table: OutlineEntry, key: string, loc: Bounds, selectionLoc: Bounds): OutlineEntry {
    return this.link(pathMember(table, key, loc, selectionLoc), table.symbol?.member(key));
  }

  private recordValue(entry: OutlineEntry, value: Expression | undefined): void {
    if (value) {
      this.valueEntries.set(value, entry);
    }
  }

  // Where a callback or a function listed flat goes: under the innermost entry, in the function being visited, whose
  // value holds it, as in local co = cocreate(function() end), and then natural is that function, or the root at the top
  // level; otherwise under the function or the root itself. The entry must be listed under that function too: a global
  // first assigned in _init is listed at the top level, and a cursor in a callback listed there would no longer find _init.
  private callbackOwner(): { owner: Owner, natural?: Owner } {
    const natural = this.topScope().owner;
    for (let i = this.nodeStack.length - 1; i >= 0; i--) {
      const { node } = this.nodeStack[i];
      if (node.type === 'FunctionDeclaration') {
        break;
      }
      const entry = this.valueEntries.get(node);
      if (entry && boundsContain(entry.loc, node.loc!) && this.entriesAbove(entry, natural) !== undefined) {
        return { owner: entry, natural };
      }
    }
    return { owner: natural };
  }

  // Breadcrumbs descend into the first entry whose range contains the cursor, and the range of a member can lie outside
  // its table's: local e = {}, then e.co = cocreate(function() end). So a callback that callbackOwner put under an entry
  // goes up to the lowest entry the descent reaches it through: the entries from the function it is in down to there all
  // contain it. With none, it goes back to that function. This waits for the last grouping, which stretches tables over
  // their methods.
  private liftUnreachableCallbacks(): void {
    for (const { entry, natural } of this.nestedCallbacks) {
      let place: Owner = natural;
      for (const above of (this.entriesAbove(entry, natural) ?? []).reverse()) {
        if (!boundsContain(above.loc, entry.loc)) {
          break;
        }
        place = above;
      }
      if (place !== entry.parent) {
        moveEntry(entry, place);
      }
    }
  }

  // The entries from entry's parent up to owner, owner left out, nearest first; undefined when owner does not hold entry.
  // The root, where every chain of parents ends, holds every entry.
  private entriesAbove(entry: OutlineEntry, owner: Owner): OutlineEntry[] | undefined {
    const entries: OutlineEntry[] = [];
    for (let parent = entry.parent; parent !== owner; parent = (parent as OutlineEntry).parent) {
      if (parent === this.root) {
        return undefined;
      }
      entries.push(parent as OutlineEntry);
    }
    return entries;
  }

  // The symbol whose members base.k names: self stands for its method's table. A base that is not a name or a
  // path of names (t[i].x, f().x) gets a symbol of its own, so that its keys still have symbols.
  private tableOf(base: Expression): LuaSymbol {
    return this.pathSymbol(base) ?? new LuaSymbol('value', '');
  }

  private pathSymbol(expression: Expression): LuaSymbol | undefined {
    const keys: MemberExpression[] = [];
    let base = expression;
    while (base.type === 'MemberExpression' && !this.paths.has(base)) {
      keys.push(base);
      base = base.base;
    }
    let symbol: LuaSymbol | undefined;
    if (base.type === 'MemberExpression') {
      symbol = this.paths.get(base);
    } else if (base.type === 'Identifier') {
      const { symbol: named } = this.resolve(base);
      symbol = named.table ?? named;
    }
    for (let i = keys.length - 1; i >= 0; i--) {
      symbol = symbol?.member(keys[i].identifier.name);
      this.paths.set(keys[i], symbol);
    }
    return symbol;
  }

  private globalSymbol(name: string): LuaSymbol {
    let symbol = this.globals.get(name);
    if (!symbol) {
      symbol = new LuaSymbol('global', name);
      this.globals.set(name, symbol);
    }
    return symbol;
  }

  private globalEntry(name: Identifier): OutlineEntry | undefined {
    return this.globalEntries.get(name.name)?.get(name.loc!.start.filename.path);
  }

  private setGlobalEntry(name: Identifier, entry: OutlineEntry): void {
    let entries = this.globalEntries.get(name.name);
    if (!entries) {
      entries = new Map<string, OutlineEntry>();
      this.globalEntries.set(name.name, entries);
    }
    entries.set(name.loc!.start.filename.path, entry);
  }

  private anyGlobalEntry(name: string): OutlineEntry | undefined {
    const [ first ] = this.globalEntries.get(name)?.values() ?? [];
    return first;
  }

  private visibleDecl(scope: BinderScope, name: string): Decl | undefined {
    let decl = scope.decls.get(name);
    while (decl) {
      const { stmt } = decl;
      if (!stmt || !this.nodeStack.some(n => n.node === stmt)) {
        return decl;
      }
      decl = decl.previous;
    }
    return undefined;
  }

  private resolveSelfBinding(): 'local-or-loopvar' | 'other' {
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      const scope = this.scopeStack[i];
      const decl = this.visibleDecl(scope, 'self');
      if (decl) {
        return (decl.kind === 'local' || decl.kind === 'loopvar') ? 'local-or-loopvar' : 'other';
      }
      if (scope.selfTable !== undefined || scope.selfPath !== undefined) {
        return 'other';
      }
    }
    return 'other';
  }

  private resolveSelfTable(): OutlineEntry | null | undefined {
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      const scope = this.scopeStack[i];
      if (scope.selfTable !== undefined) {
        return scope.selfTable;
      }
      if (scope.selfPath) {
        let entry = scope.selfPath.root;
        for (const seg of scope.selfPath.segments) {
          entry = this.pathEntry(entry, seg.name, scope.selfPath.loc, seg.loc!);
        }
        scope.selfTable = entry;
        return entry;
      }
    }
    return undefined;
  }

  // The path of the method that self's table is at the end of, also after resolveSelfTable has made its entries.
  private methodPath(): SelfPath | undefined {
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      const scope = this.scopeStack[i];
      if (scope.selfTable !== undefined || scope.selfPath) {
        return scope.selfPath;
      }
    }
    return undefined;
  }

  private resolve(name: Identifier): Binding {
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      // Skip any decl whose declaring stmt is still being initialised (LocalStatement on the node stack).
      const decl = this.visibleDecl(this.scopeStack[i], name.name);
      if (decl) {
        return decl;
      }
    }
    // A self that nothing declares belongs to the innermost function alone, so that self.k never links two
    // functions. Outside every function it is the global of that name, as in Lua.
    const fn = name.name === 'self' ? [ ...this.scopeStack ].reverse().find(scope => scope.kind === 'function') : undefined;
    if (fn) {
      fn.implicitSelf ??= { kind: 'param', symbol: new LuaSymbol('self', 'self') };
      return fn.implicitSelf;
    }
    return { kind: 'global', symbol: this.globalSymbol(name.name), entry: this.globalEntry(name) };
  }
}

// The range of the entries of target i. With several targets, each gets its own name and value, the first from the start
// of the statement; a target with no value of its own gets just its name.
function targetRange(statement: AssignmentStatement | LocalStatement, i: number): Bounds {
  const { variables, init } = statement;
  if (variables.length < 2) {
    return statement.loc!;
  }
  const start = i === 0 ? statement.loc!.start : variables[i].loc!.start;
  const valueEnd = init[i]?.loc?.end;
  return { start, end: valueEnd?.filename.equals(start.filename) ? valueEnd : variables[i].loc!.end };
}

type BlockHeader = { keyword: OutlineBlock['keyword'], headerEnd?: CodeLocation };

// Undefined for a scope that is not a block the outline can show.
function blockHeader(node: VisitableASTNode): BlockHeader | undefined {
  switch (node.type) {
  case 'ForNumericStatement':
    return { keyword: 'for', headerEnd: (node.step ?? node.end).loc?.end };
  case 'ForGenericStatement':
    return { keyword: 'for', headerEnd: node.iterators[node.iterators.length - 1]?.loc?.end };
  case 'WhileStatement':
    return { keyword: 'while', headerEnd: node.condition.loc?.end };
  case 'RepeatStatement':
    return { keyword: 'repeat' };
  case 'DoStatement':
    return { keyword: 'do' };
  case 'IfClause':
    return { keyword: 'if', headerEnd: node.condition.loc?.end };
  case 'ElseifClause':
    return { keyword: 'elseif', headerEnd: node.condition.loc?.end };
  case 'ElseClause':
    return { keyword: 'else' };
  default:
    return undefined;
  }
}

export function emptyAnalysis(): Analysis {
  return {
    outline: [], globals: new Map(), referencesByFile: new Map(), membersByKey: new Map(),
    scope: { kind: 'file', children: [], declarations: [] }, includeScopes: new Map(), includeStarts: new Map(),
    includeCheckpoints: new Map(), codeStarts: new Map(), comments: [], blocks: [],
  };
}

export function analyze(chunk: Chunk): Analysis {
  const comments = [ ...(chunk.comments ?? []), ...(chunk.includedComments ?? []) ];
  const binder = new Binder(findBoundaryLines(comments));
  binder.visit(chunk);
  const referencesByFile = new Map<string, Reference[]>();
  const membersByKey = new Map<string, LuaSymbol[]>();
  const members = new Set<LuaSymbol>();
  for (const reference of binder.references) {
    listIn(referencesByFile, reference.loc.start.filename.path).push(reference);
    const { symbol } = reference;
    if (symbol.kind === 'member' && !members.has(symbol)) {
      members.add(symbol);
      listIn(membersByKey, symbol.name).push(symbol);
    }
  }
  for (const references of referencesByFile.values()) {
    references.sort((a, b) => a.loc.start.index - b.loc.start.index);
  }
  return {
    outline: binder.root.children, globals: binder.globals, referencesByFile, membersByKey,
    scope: binder.fileScope, includeScopes: binder.includeScopes, includeStarts: binder.includeStarts,
    includeCheckpoints: binder.includeCheckpoints, codeStarts: binder.codeStarts, comments, blocks: binder.blocks,
  };
}

function listIn<T>(map: Map<string, T[]>, key: string): T[] {
  let list = map.get(key);
  if (!list) {
    list = [];
    map.set(key, list);
  }
  return list;
}
