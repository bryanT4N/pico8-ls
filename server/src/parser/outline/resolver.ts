import { Expression, Identifier, Indexer, MemberExpression, TableConstructorExpression, Variable } from '../expressions';
import { AnonymousFunctionName, AssignmentStatement, Block, Chunk, ForGenericStatement, ForNumericStatement,
  FunctionDeclaration, isStatementWithBody, LabelStatement, LocalStatement, Statement } from '../statements';
import { ASTVisitor, VisitableASTNode } from '../visitor';
import { addEntry, CodeSymbolType, OutlineEntry, Owner, signatureOf } from './model';
import { getOrAddMember, receiveTable, tableTypeOf, unwrapValue } from './members';
import { findBoundaryLines, groupMethodRuns, StatementInfo } from './method-runs';

type Decl = {
  kind: 'local' | 'param' | 'loopvar',
  entry?: OutlineEntry,
  // Set for locals declared by a LocalStatement; absent for local function and params/loopvars.
  // While this stmt is on the nodeStack (its initializers are being visited), the decl is hidden.
  stmt?: Statement,
  // The decl shadowed by this one in the same scope, if any.
  previous?: Decl,
};

// What a name refers to at some point: its innermost declaration, or else the global.
type Binding = Decl | { kind: 'global', entry?: OutlineEntry };

// For a deeper method path (e.g. T.a:m), the last intermediate table may not exist yet;
// selfPath holds the info to create it on the first self.k = v that needs it.
type SelfPath = { root: OutlineEntry, segments: Identifier[], stmt: Statement };

type ValueTarget =
  | { kind: 'entry', entry: OutlineEntry, selfTable?: OutlineEntry | null, selfPath?: SelfPath }
  | { kind: 'flat', owner: Owner, name: string }                      // rule 7, unnamed table (Task 8)
  | { kind: 'anonymous', owner: Owner };                              // Task 8

class ResolverScope {
  decls = new Map<string, Decl>();
  // undefined = inherit from enclosing scope; null = self is used but the table is not known
  selfTable?: OutlineEntry | null;
  selfPath?: SelfPath;
  constructor(public owner: Owner, public block?: Block) {}
}

class OutlineResolver extends ASTVisitor<ResolverScope> {
  readonly root: Owner = { children: [] };
  // The first entry each global name got.
  private readonly globals = new Map<string, OutlineEntry>();
  // For each expression value, where to attach it in the outline.
  private readonly targets = new Map<Expression, ValueTarget>();
  private readonly statementInfo = new Map<Statement, StatementInfo>();

  constructor(private readonly boundaryLines: number[]) {
    super();
  }

  override visit(chunk: Chunk): void {
    super.visit(chunk);
    groupMethodRuns(chunk.block.body, this.statementInfo, this.boundaryLines);
  }

  override onExitScope(scope: ResolverScope): void {
    if (scope.block) {
      groupMethodRuns(scope.block.body, this.statementInfo, this.boundaryLines);
    }
  }

  override startingScope(): ResolverScope {
    return new ResolverScope(this.root);
  }

  createDefaultScope(scopeNode: VisitableASTNode | null): ResolverScope {
    return new ResolverScope(this.topScope().owner, isStatementWithBody(scopeNode) ? scopeNode.block : undefined);
  }

  override visitFunctionDeclaration(node: FunctionDeclaration): ResolverScope {
    if (node.identifier?.type === 'Identifier' && node.isLocal) {
      // local function name() end — declare in the enclosing scope before entering body
      const outer = this.topScope();
      const entry = addEntry(outer.owner, node.identifier.name, CodeSymbolType.Function,
        node.loc!, node.identifier.loc!);
      this.targets.set(node, { kind: 'entry', entry });
      outer.decls.set(node.identifier.name, { kind: 'local', entry });
      this.statementInfo.set(node, { about: entry, defines: entry });
    } else if (node.identifier) {
      // function f() end and function t.f() end — same as f = function() end and t.f = function() end
      this.recordStatement(node, [ this.assign(node.identifier, node, node) ]);
    }

    const target = this.targets.get(node);
    let owner: Owner;
    if (target?.kind === 'entry') {
      target.entry.detail = signatureOf(node);
      owner = target.entry;
    } else if (target?.kind === 'flat') {
      owner = addEntry(target.owner, target.name, CodeSymbolType.Method, node.loc!, node.loc!, signatureOf(node));
    } else if (target?.kind === 'anonymous') {
      owner = addEntry(target.owner, AnonymousFunctionName, CodeSymbolType.Function, node.loc!, node.loc!, signatureOf(node));
    } else if (!node.identifier) {
      owner = addEntry(this.topScope().owner, AnonymousFunctionName, CodeSymbolType.Function,
        node.loc!, node.loc!, signatureOf(node));
    } else {
      owner = this.topScope().owner;
    }

    const scope = new ResolverScope(owner, node.block);

    const firstParam = node.parameters[0];
    const firstParamIsSelf = firstParam?.type === 'Identifier' && firstParam.name === 'self';
    const isColonMethod = node.identifier?.type === 'MemberExpression' && node.identifier.indexer === ':';
    if (isColonMethod || firstParamIsSelf) {
      if (target?.kind === 'entry' && target.selfTable !== undefined) {
        scope.selfTable = target.selfTable;
      } else if (target?.kind === 'entry' && target.selfPath) {
        scope.selfPath = target.selfPath;
      } else {
        scope.selfTable = null;
      }
    } else if (node.parameters.some(p => p.type === 'Identifier' && p.name === 'self')) {
      scope.selfTable = null;
    }

    for (const param of node.parameters) {
      if (param.type === 'Identifier') {
        scope.decls.set(param.name, { kind: 'param' });
      }
    }
    return scope;
  }

  override visitAssignmentStatement(node: AssignmentStatement): void {
    this.recordStatement(node, node.variables.map((variable, i) => this.assign(variable, node.init[i], node)));
  }

  override visitLocalStatement(node: LocalStatement): void {
    this.recordStatement(node, node.variables.map((variable, i) => {
      if (variable.type !== 'Identifier') {
        return undefined;
      }
      const value = node.init[i];
      const previous = this.topScope().decls.get(variable.name);
      const unwrapped = unwrapValue(value);
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
      this.topScope().decls.set(variable.name, { kind: 'local', entry, stmt: node, previous });
      return { about: entry, defines: entry };
    }));
  }

  override visitForNumericStatement(node: ForNumericStatement): ResolverScope {
    const scope = this.createDefaultScope(node);
    scope.decls.set(node.variable.name, { kind: 'loopvar' });
    return scope;
  }

  override visitForGenericStatement(node: ForGenericStatement): ResolverScope {
    const scope = this.createDefaultScope(node);
    for (const variable of node.variables) {
      scope.decls.set(variable.name, { kind: 'loopvar' });
    }
    return scope;
  }

  override visitLabelStatement(node: LabelStatement): void {
    addEntry(this.topScope().owner, node.label.name, CodeSymbolType.Label, node.loc!, node.label.loc!);
  }

  override visitTableConstructorExpression(node: TableConstructorExpression): ResolverScope {
    const target = this.targets.get(node);
    if (target?.kind === 'entry') {
      const tableEntry = target.entry;
      for (const field of node.fields) {
        if (field.type === 'TableKeyString') {
          if (field.value.type === 'FunctionDeclaration') {
            const method = addEntry(tableEntry, field.key.name, CodeSymbolType.Method, field.loc!, field.key.loc!);
            this.targets.set(field.value, { kind: 'entry', entry: method, selfTable: tableEntry });
            continue;
          }
          const unwrapped = unwrapValue(field.value);
          if (unwrapped?.type === 'TableConstructorExpression') {
            const innerCtor = unwrapped as TableConstructorExpression;
            const member = getOrAddMember(tableEntry, field.key.name, tableTypeOf(innerCtor), field.loc!, field.key.loc!);
            receiveTable(member, innerCtor);
            this.targets.set(innerCtor, { kind: 'entry', entry: member });
          } else {
            getOrAddMember(tableEntry, field.key.name, CodeSymbolType.Field, field.loc!, field.key.loc!);
          }
        } else if (field.type === 'TableValue' || field.type === 'TableKey') {
          this.registerPositionalTarget(field.value, tableEntry);
        }
      }
    } else {
      const owner = target?.kind === 'flat' ? target.owner : this.topScope().owner;
      const prefix = target?.kind === 'flat' ? target.name : '';
      for (const field of node.fields) {
        if (field.type === 'TableKeyString') {
          if (field.value.type === 'FunctionDeclaration') {
            this.targets.set(field.value, { kind: 'flat', owner, name: prefix ? `${prefix}.${field.key.name}` : field.key.name });
          } else {
            const unwrapped = unwrapValue(field.value);
            if (unwrapped?.type === 'TableConstructorExpression') {
              this.targets.set(unwrapped as TableConstructorExpression, { kind: 'flat', owner, name: prefix ? `${prefix}.${field.key.name}` : '' });
            }
          }
        } else if (field.type === 'TableValue' || field.type === 'TableKey') {
          this.registerPositionalTarget(field.value, owner);
        }
      }
    }
    return this.createDefaultScope(node);
  }

  private assign(variable: Variable, value: Expression | undefined, statement: Statement): StatementInfo | undefined {
    if (variable.type === 'Identifier') {
      return this.assignName(variable, value, statement);
    } else if (variable.type === 'MemberExpression') {
      return this.assignMember(variable, value, statement);
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

  private assignName(name: Identifier, value: Expression | undefined, statement: Statement): StatementInfo | undefined {
    const binding = this.resolve(name.name);
    const unwrapped = unwrapValue(value);

    if (binding.kind !== 'global') {
      if (value?.type === 'FunctionDeclaration') {
        const entry = addEntry(this.topScope().owner, name.name, CodeSymbolType.Function,
          statement.loc!, name.loc!);
        this.targets.set(value, { kind: 'entry', entry });
      } else if (unwrapped?.type === 'TableConstructorExpression' && binding.kind === 'local' && binding.entry) {
        const ctor = unwrapped as TableConstructorExpression;
        receiveTable(binding.entry, ctor);
        this.targets.set(ctor, { kind: 'entry', entry: binding.entry });
      }
      return binding.entry && { about: binding.entry, defines: binding.entry };
    }

    if (value?.type === 'FunctionDeclaration') {
      const entry = addEntry(this.root, name.name, CodeSymbolType.Function, statement.loc!, name.loc!);
      this.targets.set(value, { kind: 'entry', entry });
      if (!binding.entry) {
        this.globals.set(name.name, entry);
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
          const entry = addEntry(this.root, name.name, tableTypeOf(ctor), statement.loc!, name.loc!);
          this.globals.set(name.name, entry);
          this.targets.set(ctor, { kind: 'entry', entry });
        }
      } else if (!binding.entry) {
        this.globals.set(name.name, addEntry(this.root, name.name, CodeSymbolType.Variable, statement.loc!, name.loc!));
      }
    }
    const table = this.globals.get(name.name)!;
    return { about: table, defines: table };
  }

  private assignMember(variable: MemberExpression, value: Expression | undefined, statement: Statement): StatementInfo | undefined {
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
        return this.addMethod(value, root, segments, variable.indexer, undefined, statement);
      }
      const selfTable = this.resolveSelfTable();
      if (!selfTable) {
        this.assignUnknownRoot(root, segments, value);
        return undefined;
      }
      return this.addMemberField(selfTable, segments, value, statement);
    }

    const binding = this.resolve(root.name);
    if (binding.kind === 'param' || binding.kind === 'loopvar') {
      if (value?.type === 'FunctionDeclaration') {
        return this.addMethod(value, root, segments, variable.indexer, undefined, statement);
      }
      this.assignUnknownRoot(root, segments, value); // the outline can't know which table was passed in
      return undefined;
    }

    if (value?.type === 'FunctionDeclaration') {
      return this.addMethod(value, root, segments, variable.indexer, binding.entry, statement);
    }

    let rootEntry = binding.entry;
    if (!rootEntry) {
      if (binding.kind !== 'global') {
        return;
      }
      rootEntry = addEntry(this.root, root.name, CodeSymbolType.Table, statement.loc!, root.loc!);
      rootEntry.implicit = true;
      this.globals.set(root.name, rootEntry);
    }

    return this.addMemberField(rootEntry, segments, value, statement);
  }

  private addMemberField(rootEntry: OutlineEntry, segments: Identifier[], value: Expression | undefined, statement: Statement): StatementInfo {
    const unwrapped = unwrapValue(value);
    let tableEntry = rootEntry;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      tableEntry = getOrAddMember(tableEntry, seg.name, CodeSymbolType.Table, statement.loc!, seg.loc!);
    }
    const lastSeg = segments[segments.length - 1];
    const memberType = unwrapped?.type === 'TableConstructorExpression'
      ? tableTypeOf(unwrapped as TableConstructorExpression) : CodeSymbolType.Field;
    const member = getOrAddMember(tableEntry, lastSeg.name, memberType, statement.loc!, lastSeg.loc!);
    if (unwrapped?.type === 'TableConstructorExpression') {
      const ctor = unwrapped as TableConstructorExpression;
      receiveTable(member, ctor);
      this.targets.set(ctor, { kind: 'entry', entry: member });
    }
    return { about: rootEntry };
  }

  // A method written as its own statement: function a.b(), function a:b() or a.b = function() end.
  private addMethod(fn: FunctionDeclaration, root: Identifier, segments: Identifier[], indexer: Indexer,
    table: OutlineEntry | undefined, statement: Statement): StatementInfo | undefined {
    const key = segments[segments.length - 1];
    const name = [ root, ...segments.slice(0, -1) ].map(id => id.name).join('.') + indexer + key.name;
    const entry = addEntry(this.topScope().owner, name, CodeSymbolType.Method, statement.loc!, key.loc!);
    const intermediates = segments.slice(0, -1);
    const firstParam = fn.parameters[0];
    const isSelfMethod = indexer === ':' || (firstParam?.type === 'Identifier' && firstParam.name === 'self');
    if (isSelfMethod) {
      if (intermediates.length === 0) {
        this.targets.set(fn, { kind: 'entry', entry, selfTable: table ?? null });
      } else if (table) {
        this.targets.set(fn, { kind: 'entry', entry, selfPath: { root: table, segments: intermediates, stmt: statement } });
      } else {
        this.targets.set(fn, { kind: 'entry', entry, selfTable: null });
      }
    } else {
      this.targets.set(fn, { kind: 'entry', entry });
    }
    if (table && segments.length === 1) {
      return { about: table, methods: [{ entry, key: key.name }] };
    }
    return table && { about: table };
  }

  private assignUnknownRoot(root: Identifier, segments: Identifier[], value: Expression | undefined): void {
    // The outline can't know which table was passed in.
    const unwrapped = unwrapValue(value);
    if (unwrapped?.type === 'TableConstructorExpression') {
      const pathName = [ root, ...segments ].map(id => id.name).join('.');
      this.targets.set(unwrapped as TableConstructorExpression, { kind: 'flat', owner: this.topScope().owner, name: pathName });
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

  private visibleDecl(scope: ResolverScope, name: string): Decl | undefined {
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
          entry = getOrAddMember(entry, seg.name, CodeSymbolType.Table, scope.selfPath.stmt.loc!, seg.loc!);
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
    return { kind: 'global', entry: this.globals.get(name) };
  }
}

export function resolveOutline(chunk: Chunk): OutlineEntry[] {
  const resolver = new OutlineResolver(findBoundaryLines(chunk.comments ?? []));
  resolver.visit(chunk);
  return resolver.root.children;
}
