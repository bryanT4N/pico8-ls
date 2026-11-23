import { Expression, Identifier, Indexer, MemberExpression, TableConstructorExpression, Variable } from '../expressions';
import { AnonymousFunctionName, AssignmentStatement, Block, Chunk, ForGenericStatement, ForNumericStatement,
  FunctionDeclaration, GotoStatement, IncludeStatement, isStatementWithBody, LabelStatement, LocalStatement, Statement } from '../statements';
import { resolveIncludeFile } from '../file-resolver';
import { ASTNode, Bounds, CodeLocation } from '../types';
import { ASTVisitor, VisitableASTNode } from '../visitor';
import { addEntry, CodeSymbolType, OutlineEntry, Owner, signatureOf } from '../outline/model';
import { getOrAddMember, receiveTable, tableTypeOf, unwrapValue } from '../outline/members';
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
};

// What a name refers to at some point: its innermost declaration, or else the global.
type Binding = Decl | { kind: 'global', symbol: LuaSymbol, entry?: OutlineEntry };

// For a deeper method path (e.g. T.a:m), the last intermediate table may not exist yet;
// selfPath holds the info to create it on the first self.k = v that needs it.
type SelfPath = { root: OutlineEntry, segments: Identifier[], stmt: Statement };

// selfSymbol is the table self means in a method, as far as names tell. A flat target's symbol is the member a
// function defines, or the variable that holds a table.
type ValueTarget =
  | { kind: 'entry', entry: OutlineEntry, selfTable?: OutlineEntry | null, selfPath?: SelfPath, selfSymbol?: LuaSymbol }
  | { kind: 'flat', owner: Owner, name: string, loc?: Bounds, selectionLoc?: Bounds, symbol?: LuaSymbol } // rule 7, unnamed table
  | { kind: 'anonymous', owner: Owner };

type PendingGoto = { label: Identifier, blocks: BinderScope[] };

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
  // analysisScope: the scope the analysis keeps, which a table constructor shares with the scope around it.
  constructor(public owner: Owner, public kind: 'file' | 'function' | 'block', readonly analysisScope: Scope, public block?: Block) {}
}

class Binder extends ASTVisitor<BinderScope> {
  readonly root: Owner = { children: [] };
  readonly globals = new Map<string, LuaSymbol>();
  readonly references: Reference[] = [];
  readonly fileScope: Scope = { kind: 'file', children: [], declarations: [] };
  readonly includeScopes = new Map<string, Scope>();
  private order = 0;
  // The first entry each global name got.
  private readonly globalEntries = new Map<string, OutlineEntry>();
  // For each expression value, where to attach it in the outline. The statement hooks fill this in before the
  // visitor reaches the values (so do function and table constructor hooks for the values inside them); the
  // whole design relies on that order.
  private readonly targets = new Map<Expression, ValueTarget>();
  private readonly statementInfo = new Map<Statement, StatementInfo>();
  // Names and member expressions that a statement hook recorded before the visitor reaches them.
  private readonly recorded = new Set<ASTNode>();

  constructor(private readonly boundaryLines: number[]) {
    super();
  }

  override visit(chunk: Chunk): void {
    super.visit(chunk);
    this.resolveGotos(this.scopeStack[0]);
    groupMethodRuns(chunk.block.body, this.statementInfo, this.boundaryLines);
  }

  override onExitScope(scope: BinderScope): void {
    if (scope.kind === 'function') {
      this.resolveGotos(scope);
    }
    if (scope.block) {
      groupMethodRuns(scope.block.body, this.statementInfo, this.boundaryLines);
    }
  }

  override startingScope(): BinderScope {
    return new BinderScope(this.root, 'file', this.fileScope);
  }

  createDefaultScope(scopeNode: VisitableASTNode | null): BinderScope {
    return new BinderScope(this.topScope().owner, 'block', { kind: 'block', loc: scopeNode?.loc, children: [], declarations: [] },
      isStatementWithBody(scopeNode) ? scopeNode.block : undefined);
  }

  // A scope joins the tree when it is entered. A function in a loop header or a condition is entered before the
  // loop or clause, whose range contains it too, so visibleAt's descent, which takes the first child that contains
  // the cursor, finds the function.
  override onEnterScope(scope: BinderScope): void {
    const parent = this.topScope(1).analysisScope;
    if (scope.analysisScope !== parent) {
      scope.analysisScope.parent = parent;
      parent.children.push(scope.analysisScope);
    }
  }

  override visitIncludeStatement(node: IncludeStatement): void {
    const included = resolveIncludeFile(node.loc!.start.filename, node.filename).path;
    if (!this.includeScopes.has(included)) {
      this.includeScopes.set(included, this.topScope().analysisScope);
    }
  }

  override visitFunctionDeclaration(node: FunctionDeclaration): BinderScope {
    if (node.identifier?.type === 'Identifier' && node.isLocal) {
      // local function name() end — declare in the enclosing scope before entering body
      const outer = this.topScope();
      const symbol = new LuaSymbol('local', node.identifier.name);
      this.define(symbol, node.identifier, node.loc!, node, node);
      const entry = this.link(addEntry(outer.owner, node.identifier.name, CodeSymbolType.Function,
        node.loc!, node.identifier.loc!), symbol);
      this.targets.set(node, { kind: 'entry', entry });
      outer.decls.set(node.identifier.name, { kind: 'local', symbol, entry });
      this.declare(outer, symbol, node.identifier.loc!.end);
      this.statementInfo.set(node, { about: entry, defines: entry });
    } else if (node.identifier) {
      // function f() end and function t.f() end — same as f = function() end and t.f = function() end
      this.recordStatement(node, [ this.assign(node.identifier, node, node, false) ]);
    }

    const target = this.targets.get(node);
    let owner: Owner;
    if (target?.kind === 'entry') {
      target.entry.detail = signatureOf(node);
      owner = target.entry;
    } else if (target?.kind === 'flat') {
      owner = this.link(addEntry(target.owner, target.name, CodeSymbolType.Method, target.loc ?? node.loc!, target.selectionLoc ?? node.loc!,
        signatureOf(node)), target.symbol);
    } else if (target?.kind === 'anonymous') {
      owner = addEntry(target.owner, AnonymousFunctionName, CodeSymbolType.Function, node.loc!, node.loc!, signatureOf(node));
    } else if (!node.identifier) {
      owner = addEntry(this.topScope().owner, AnonymousFunctionName, CodeSymbolType.Function,
        node.loc!, node.loc!, signatureOf(node));
    } else {
      owner = this.topScope().owner;
    }

    const scope = new BinderScope(owner, 'function', { kind: 'function', loc: node.loc, children: [], declarations: [] }, node.block);

    const firstParam = node.parameters[0];
    const firstParamIsSelf = firstParam?.type === 'Identifier' && firstParam.name === 'self';
    const isColonMethod = node.identifier?.type === 'MemberExpression' && node.identifier.indexer === ':';
    let selfSymbol: LuaSymbol | undefined;
    if (isColonMethod || firstParamIsSelf) {
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
    if (isColonMethod) {
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
        this.define(symbol, param, param.loc!, param);
        scope.decls.set(param.name, { kind: 'param', symbol });
        this.declare(scope, symbol, parametersEnd);
      }
    }
    return scope;
  }

  override visitAssignmentStatement(node: AssignmentStatement): void {
    const compound = node.operator !== '=';
    this.recordStatement(node, node.variables.map((variable, i) => this.assign(variable, node.init[i], node, compound)));
  }

  override visitLocalStatement(node: LocalStatement): void {
    this.recordStatement(node, node.variables.map((variable, i) => {
      if (variable.type !== 'Identifier') {
        return undefined;
      }
      const value = node.init[i];
      const previous = this.topScope().decls.get(variable.name);
      const unwrapped = unwrapValue(value);
      const symbol = new LuaSymbol('local', variable.name);
      this.define(symbol, variable, node.loc!, node, value);
      let entry: OutlineEntry;
      if (value?.type === 'FunctionDeclaration') {
        entry = addEntry(this.topScope().owner, variable.name, CodeSymbolType.Function, node.loc!, variable.loc!);
        this.targets.set(value, { kind: 'entry', entry });
      } else if (unwrapped?.type === 'TableConstructorExpression') {
        entry = addEntry(this.topScope().owner, variable.name, tableTypeOf(unwrapped), node.loc!, variable.loc!);
        this.targets.set(unwrapped, { kind: 'entry', entry });
      } else {
        entry = addEntry(this.topScope().owner, variable.name, CodeSymbolType.Variable, node.loc!, variable.loc!);
      }
      this.link(entry, symbol);
      this.topScope().decls.set(variable.name, { kind: 'local', symbol, entry, stmt: node, previous });
      this.declare(this.topScope(), symbol, node.loc!.end);
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
    const lastInHeader = node.type === 'ForNumericStatement' ? (node.step ?? node.end) : node.iterators[node.iterators.length - 1];
    this.declare(scope, symbol, lastInHeader.loc!.end);
  }

  override visitLabelStatement(node: LabelStatement): void {
    const scope = this.topScope();
    const symbol = new LuaSymbol('label', node.label.name);
    this.define(symbol, node.label, node.loc!, node);
    scope.labels.set(node.label.name, symbol);
    this.link(addEntry(scope.owner, node.label.name, CodeSymbolType.Label, node.loc!, node.label.loc!), symbol);
  }

  override visitGotoStatement(node: GotoStatement): void {
    this.recorded.add(node.label);
    const blocks: BinderScope[] = [];
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      const scope = this.scopeStack[i];
      blocks.push(scope);
      if (scope.kind !== 'block') {
        scope.gotos.push({ label: node.label, blocks });
        return;
      }
    }
  }

  // A goto with no label to go to gets no reference: the parser reports it.
  private resolveGotos(scope: BinderScope): void {
    for (const { label, blocks } of scope.gotos) {
      const target = blocks.find(block => block.labels.has(label.name))?.labels.get(label.name);
      if (target) {
        this.read(target, label.loc!);
      }
    }
  }

  override visitIdentifier(node: Identifier): void {
    const parent = this.topNode()?.node;
    // A key is recorded with its member expression; ? is the print shorthand.
    if (this.recorded.has(node) || node.name === '?' || (parent?.type === 'MemberExpression' && parent.identifier === node)) {
      return;
    }
    this.read(this.resolve(node.name).symbol, node.loc!);
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
            const method = this.link(addEntry(tableEntry, field.key.name, CodeSymbolType.Method, field.loc!, field.key.loc!), member);
            this.targets.set(field.value, { kind: 'entry', entry: method, selfTable: tableEntry, selfSymbol: table });
            continue;
          }
          const unwrapped = unwrapValue(field.value);
          if (unwrapped?.type === 'TableConstructorExpression') {
            const innerCtor = unwrapped as TableConstructorExpression;
            const memberEntry = this.memberEntry(tableEntry, field.key.name, tableTypeOf(innerCtor), field.loc!, field.key.loc!);
            receiveTable(memberEntry, innerCtor);
            this.targets.set(innerCtor, { kind: 'entry', entry: memberEntry });
          } else {
            this.memberEntry(tableEntry, field.key.name, CodeSymbolType.Field, field.loc!, field.key.loc!);
          }
        } else if (field.type === 'TableValue' || field.type === 'TableKey') {
          this.registerPositionalTarget(field.value, tableEntry);
        }
      }
    } else {
      const owner = target?.kind === 'flat' ? target.owner : this.topScope().owner;
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
            this.targets.set(field.value, { kind: 'flat', owner, name: prefix ? `${prefix}.${field.key.name}` : field.key.name,
              loc: field.loc!, selectionLoc: field.key.loc!, symbol: named && member });
          } else {
            const unwrapped = unwrapValue(field.value);
            if (unwrapped?.type === 'TableConstructorExpression') {
              this.targets.set(unwrapped as TableConstructorExpression, { kind: 'flat', owner, name: prefix ? `${prefix}.${field.key.name}` : '',
                symbol: named && member });
            }
          }
        } else if (field.type === 'TableValue' || field.type === 'TableKey') {
          this.registerPositionalTarget(field.value, owner);
        }
      }
    }
    // A scope to the visitor only: nothing can be declared in a table constructor.
    return new BinderScope(this.topScope().owner, 'block', this.topScope().analysisScope);
  }

  private assign(variable: Variable, value: Expression | undefined, statement: Statement, compound: boolean): StatementInfo | undefined {
    if (variable.type === 'Identifier') {
      return this.assignName(variable, value, statement, compound);
    } else if (variable.type === 'MemberExpression') {
      return this.assignMember(variable, value, statement, compound);
    }
    return undefined;
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

  private assignName(name: Identifier, value: Expression | undefined, statement: Statement, compound: boolean): StatementInfo | undefined {
    const binding = this.resolve(name.name);
    if (compound && binding.kind === 'global') {
      // In PICO-8, x += 1 fails on a global that was never assigned, so a plain assignment elsewhere defines it.
      this.write(binding.symbol, name, true);
      return binding.entry && { about: binding.entry };
    }
    this.define(binding.symbol, name, statement.loc!, statement, value, compound);
    const unwrapped = unwrapValue(value);

    if (binding.kind !== 'global') {
      if (value?.type === 'FunctionDeclaration') {
        const entry = this.link(addEntry(this.topScope().owner, name.name, CodeSymbolType.Function,
          statement.loc!, name.loc!), binding.symbol);
        this.targets.set(value, { kind: 'entry', entry });
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
      const entry = this.link(addEntry(this.topScope().owner, name.name, CodeSymbolType.Function, statement.loc!, name.loc!), binding.symbol);
      this.targets.set(value, { kind: 'entry', entry });
      if (!binding.entry) {
        this.globalEntries.set(name.name, entry);
      }
    } else {
      if (binding.entry?.implicit) {
        binding.entry.loc = statement.loc!;
        binding.entry.selectionLoc = name.loc!;
        binding.entry.implicit = false;
      }
      if (unwrapped?.type === 'TableConstructorExpression') {
        const ctor = unwrapped as TableConstructorExpression;
        if (binding.entry) {
          receiveTable(binding.entry, ctor);
          this.targets.set(ctor, { kind: 'entry', entry: binding.entry });
        } else {
          const entry = this.link(addEntry(this.root, name.name, tableTypeOf(ctor), statement.loc!, name.loc!), binding.symbol);
          this.globalEntries.set(name.name, entry);
          this.targets.set(ctor, { kind: 'entry', entry });
        }
      } else if (!binding.entry) {
        this.globalEntries.set(name.name,
          this.link(addEntry(this.root, name.name, CodeSymbolType.Variable, statement.loc!, name.loc!), binding.symbol));
      }
    }
    const table = this.globalEntries.get(name.name)!;
    return { about: table, defines: table };
  }

  private assignMember(variable: MemberExpression, value: Expression | undefined, statement: Statement, compound: boolean): StatementInfo | undefined {
    this.recorded.add(variable);
    const member = this.tableOf(variable.base).member(variable.identifier.name);
    this.define(member, variable.identifier, statement.loc!, statement, value, compound);

    const segments: Identifier[] = [ variable.identifier ];
    let base: Expression = variable.base;
    while (base.type === 'MemberExpression') {
      segments.unshift(base.identifier);
      base = base.base;
    }
    if (base.type !== 'Identifier') {
      return;
    }
    const root = base as Identifier;

    if (root.name === 'self' && this.resolveSelfBinding() !== 'local-or-loopvar') {
      if (value?.type === 'FunctionDeclaration') {
        return this.addMethod(value, root, segments, variable.indexer, undefined, statement, member);
      }
      const selfTable = this.resolveSelfTable();
      if (!selfTable) {
        this.assignUnknownRoot(root, segments, value, member);
        return undefined;
      }
      return this.addMemberField(selfTable, segments, value, statement);
    }

    const binding = this.resolve(root.name);
    if (binding.kind === 'param' || binding.kind === 'loopvar') {
      if (value?.type === 'FunctionDeclaration') {
        return this.addMethod(value, root, segments, variable.indexer, undefined, statement, member);
      }
      this.assignUnknownRoot(root, segments, value, member); // the outline can't know which table was passed in
      return undefined;
    }

    if (value?.type === 'FunctionDeclaration') {
      return this.addMethod(value, root, segments, variable.indexer, binding.entry, statement, member);
    }

    let rootEntry = binding.entry;
    if (!rootEntry) {
      if (binding.kind !== 'global') {
        return;
      }
      rootEntry = this.link(addEntry(this.root, root.name, CodeSymbolType.Table, statement.loc!, root.loc!), binding.symbol);
      rootEntry.implicit = true;
      this.globalEntries.set(root.name, rootEntry);
    }

    return this.addMemberField(rootEntry, segments, value, statement);
  }

  private addMemberField(rootEntry: OutlineEntry, segments: Identifier[], value: Expression | undefined, statement: Statement): StatementInfo {
    const unwrapped = unwrapValue(value);
    let tableEntry = rootEntry;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      tableEntry = this.memberEntry(tableEntry, seg.name, CodeSymbolType.Table, statement.loc!, seg.loc!);
    }
    const lastSeg = segments[segments.length - 1];
    const memberType = unwrapped?.type === 'TableConstructorExpression'
      ? tableTypeOf(unwrapped as TableConstructorExpression) : CodeSymbolType.Field;
    const member = this.memberEntry(tableEntry, lastSeg.name, memberType, statement.loc!, lastSeg.loc!);
    if (unwrapped?.type === 'TableConstructorExpression') {
      const ctor = unwrapped as TableConstructorExpression;
      receiveTable(member, ctor);
      this.targets.set(ctor, { kind: 'entry', entry: member });
    }
    return { about: rootEntry };
  }

  // A method written as its own statement: function a.b(), function a:b() or a.b = function() end.
  private addMethod(fn: FunctionDeclaration, root: Identifier, segments: Identifier[], indexer: Indexer,
    table: OutlineEntry | undefined, statement: Statement, member: LuaSymbol): StatementInfo | undefined {
    const key = segments[segments.length - 1];
    const name = [ root, ...segments.slice(0, -1) ].map(id => id.name).join('.') + indexer + key.name;
    const entry = this.link(addEntry(this.topScope().owner, name, CodeSymbolType.Method, statement.loc!, key.loc!), member);
    const intermediates = segments.slice(0, -1);
    const firstParam = fn.parameters[0];
    const isSelfMethod = indexer === ':' || (firstParam?.type === 'Identifier' && firstParam.name === 'self');
    if (isSelfMethod) {
      const selfSymbol = member.owner;
      if (intermediates.length === 0) {
        this.targets.set(fn, { kind: 'entry', entry, selfTable: table ?? null, selfSymbol });
      } else if (table) {
        this.targets.set(fn, { kind: 'entry', entry, selfPath: { root: table, segments: intermediates, stmt: statement }, selfSymbol });
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

  private registerPositionalTarget(value: Expression, owner: Owner): void {
    if (value.type === 'FunctionDeclaration') {
      this.targets.set(value, { kind: 'anonymous', owner });
    } else {
      const unwrapped = unwrapValue(value);
      if (unwrapped?.type === 'TableConstructorExpression') {
        this.targets.set(unwrapped as TableConstructorExpression, { kind: 'flat', owner, name: '' });
      }
    }
  }

  // A definition, and its name as a reference: written, and for x += 1 read first.
  private define(symbol: LuaSymbol, name: Identifier, loc: Bounds, node: ASTNode, value?: Expression, compound = false): void {
    const isFunction = value?.type === 'FunctionDeclaration';
    symbol.definitions.push({ loc, nameLoc: name.loc!, node, isFunction, compound });
    if (isFunction) {
      symbol.signature = signatureOf(value);
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

  private addReference(unordered: Omit<Reference, 'order'>): void {
    const reference = { ...unordered, order: this.order++ };
    reference.symbol.references.push(reference);
    this.references.push(reference);
  }

  // For completion: symbol is visible in scope from `from` on.
  private declare(scope: BinderScope, symbol: LuaSymbol, from: CodeLocation): void {
    scope.analysisScope.declarations.push({ symbol, file: from.filename, visibleFrom: from.index, order: this.order++ });
  }

  private link(entry: OutlineEntry, symbol: LuaSymbol | undefined): OutlineEntry {
    if (symbol && !entry.symbol) {
      entry.symbol = symbol;
      symbol.entries.push(entry);
    }
    return entry;
  }

  // The member entry of a table entry stands for the member symbol of the table's symbol.
  private memberEntry(table: OutlineEntry, key: string, type: CodeSymbolType, loc: Bounds, selectionLoc: Bounds): OutlineEntry {
    return this.link(getOrAddMember(table, key, type, loc, selectionLoc), table.symbol?.member(key));
  }

  // The symbol whose members base.k names: self stands for its method's table. A base that is not a name or a
  // path of names (t[i].x, f().x) gets a symbol of its own, so that its keys still have symbols.
  private tableOf(base: Expression): LuaSymbol {
    return this.pathSymbol(base) ?? new LuaSymbol('value', '');
  }

  private pathSymbol(expression: Expression): LuaSymbol | undefined {
    if (expression.type === 'Identifier') {
      const { symbol } = this.resolve(expression.name);
      return symbol.table ?? symbol;
    }
    if (expression.type === 'MemberExpression') {
      return this.pathSymbol(expression.base)?.member(expression.identifier.name);
    }
    return undefined;
  }

  private globalSymbol(name: string): LuaSymbol {
    let symbol = this.globals.get(name);
    if (!symbol) {
      symbol = new LuaSymbol('global', name);
      this.globals.set(name, symbol);
    }
    return symbol;
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
          entry = this.memberEntry(entry, seg.name, CodeSymbolType.Table, scope.selfPath.stmt.loc!, seg.loc!);
        }
        scope.selfTable = entry;
        scope.selfPath = undefined;
        return entry;
      }
    }
    return undefined;
  }

  private resolve(name: string): Binding {
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      // Skip any decl whose declaring stmt is still being initialised (LocalStatement on the node stack).
      const decl = this.visibleDecl(this.scopeStack[i], name);
      if (decl) {
        return decl;
      }
    }
    // A self that nothing declares belongs to the innermost function alone, so that self.k never links two
    // functions. Outside every function it is the global of that name, as in Lua.
    const fn = name === 'self' ? [ ...this.scopeStack ].reverse().find(scope => scope.kind === 'function') : undefined;
    if (fn) {
      fn.implicitSelf ??= { kind: 'param', symbol: new LuaSymbol('self', 'self') };
      return fn.implicitSelf;
    }
    return { kind: 'global', symbol: this.globalSymbol(name), entry: this.globalEntries.get(name) };
  }
}

export function analyze(chunk: Chunk): Analysis {
  const binder = new Binder(findBoundaryLines(chunk.comments ?? []));
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
    scope: binder.fileScope, includeScopes: binder.includeScopes,
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
