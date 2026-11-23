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

type ValueTarget =
  | { kind: 'entry', entry: OutlineEntry, selfTable?: OutlineEntry }  // value defines or supplements entry
  | { kind: 'flat', owner: Owner, name: string }                      // rule 7, unnamed table (Task 8)
  | { kind: 'anonymous', owner: Owner };                              // Task 8

class ResolverScope {
  decls = new Map<string, Decl>();
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
    } else if (!node.identifier) {
      owner = addEntry(this.topScope().owner, AnonymousFunctionName, CodeSymbolType.Function,
        node.loc!, node.loc!, signatureOf(node));
    } else {
      owner = this.topScope().owner;
    }

    const scope = new ResolverScope(owner, node.block);
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
        if (field.type !== 'TableKeyString') {
          continue;
        }
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

    if (root.name === 'self') {
      return;
    }

    const binding = this.resolve(root.name);
    if (binding.kind === 'param' || binding.kind === 'loopvar') {
      return; // the outline can't know which table was passed in
    }

    if (value?.type === 'FunctionDeclaration') {
      return this.addMethod(value, root, segments, variable.indexer, binding.entry, statement);
    }

    const unwrapped = unwrapValue(value);
    let rootEntry = binding.entry;
    if (!rootEntry) {
      if (binding.kind !== 'global') {
        return;
      }
      rootEntry = addEntry(this.root, root.name, CodeSymbolType.Table, statement.loc!, root.loc!);
      rootEntry.implicit = true;
      this.globals.set(root.name, rootEntry);
    }

    let tableEntry = rootEntry;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      tableEntry = getOrAddMember(tableEntry, seg.name, CodeSymbolType.Table, statement.loc!, seg.loc!);
    }

    const lastSeg = segments[segments.length - 1];

    let memberType: CodeSymbolType;
    if (unwrapped?.type === 'TableConstructorExpression') {
      memberType = tableTypeOf(unwrapped as TableConstructorExpression);
    } else {
      memberType = CodeSymbolType.Field;
    }

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
    if (table && segments.length === 1) {
      this.targets.set(fn, { kind: 'entry', entry, selfTable: table });
      return { about: table, methods: [{ entry, key: key.name }] };
    }
    this.targets.set(fn, { kind: 'entry', entry });
    return table && { about: table };
  }

  private resolve(name: string): Binding {
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      let decl: Decl | undefined = this.scopeStack[i].decls.get(name);
      // Walk the shadowing chain, skipping any decl whose declaring stmt is still being
      // initialised (i.e. the LocalStatement is currently on the nodeStack).
      while (decl) {
        const { stmt } = decl;
        if (!stmt || !this.nodeStack.some(n => n.node === stmt)) {
          return decl;
        }
        decl = decl.previous;
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
