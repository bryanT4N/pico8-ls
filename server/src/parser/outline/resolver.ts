import { Expression, Identifier, MemberExpression, TableConstructorExpression } from '../expressions';
import { AnonymousFunctionName, AssignmentStatement, Chunk, ForGenericStatement, ForNumericStatement,
  FunctionDeclaration, LabelStatement, LocalStatement, Statement } from '../statements';
import { ASTVisitor } from '../visitor';
import { addEntry, CodeSymbolType, OutlineEntry, Owner, signatureOf } from './model';
import { getOrAddMember, receiveTable, tableTypeOf, unwrapValue } from './members';

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
  constructor(public owner: Owner) {}
}

class OutlineResolver extends ASTVisitor<ResolverScope> {
  readonly root: Owner = { children: [] };
  // The first entry each global name got.
  private readonly globals = new Map<string, OutlineEntry>();
  // For each expression value, where to attach it in the outline.
  private readonly targets = new Map<Expression, ValueTarget>();

  override startingScope(): ResolverScope {
    return new ResolverScope(this.root);
  }

  createDefaultScope(): ResolverScope {
    return new ResolverScope(this.topScope().owner);
  }

  override visitFunctionDeclaration(node: FunctionDeclaration): ResolverScope {
    if (node.identifier?.type === 'Identifier') {
      if (node.isLocal) {
        // local function name() end — declare in the enclosing scope before entering body
        const outer = this.topScope();
        const entry = addEntry(outer.owner, node.identifier.name, CodeSymbolType.Function,
          node.loc!, node.identifier.loc!);
        this.targets.set(node, { kind: 'entry', entry });
        outer.decls.set(node.identifier.name, { kind: 'local', entry });
      } else {
        // function name() end — same as name = function() end
        this.assignName(node.identifier, node, node);
      }
    }

    const target = this.targets.get(node);
    let scope: ResolverScope;
    if (target?.kind === 'entry') {
      target.entry.detail = signatureOf(node);
      scope = new ResolverScope(target.entry);
    } else if (!node.identifier) {
      // Anonymous function expression (no identifier at all)
      const entry = addEntry(this.topScope().owner, AnonymousFunctionName, CodeSymbolType.Function,
        node.loc!, node.loc!, signatureOf(node));
      scope = new ResolverScope(entry);
    } else {
      // MemberExpression identifier (a.b, a:b) — Task 6, leave unchanged
      scope = this.createDefaultScope();
    }

    for (const param of node.parameters) {
      if (param.type === 'Identifier') {
        scope.decls.set(param.name, { kind: 'param' });
      }
    }
    return scope;
  }

  override visitAssignmentStatement(node: AssignmentStatement): void {
    node.variables.forEach((variable, i) => {
      if (variable.type === 'Identifier') {
        this.assignName(variable, node.init[i], node);
      } else if (variable.type === 'MemberExpression') {
        this.assignMember(variable, node.init[i], node);
      }
    });
  }

  override visitLocalStatement(node: LocalStatement): void {
    node.variables.forEach((variable, i) => {
      if (variable.type !== 'Identifier') {
        return;
      }
      const value = node.init[i];
      const previous = this.topScope().decls.get(variable.name);
      const unwrapped = unwrapValue(value);
      if (value?.type === 'FunctionDeclaration') {
        const entry = addEntry(this.topScope().owner, variable.name, CodeSymbolType.Function,
          node.loc!, variable.loc!);
        this.targets.set(value, { kind: 'entry', entry });
        this.topScope().decls.set(variable.name, { kind: 'local', entry, stmt: node, previous });
      } else if (unwrapped?.type === 'TableConstructorExpression') {
        const ctor = unwrapped as TableConstructorExpression;
        const entry = addEntry(this.topScope().owner, variable.name, tableTypeOf(ctor), node.loc!, variable.loc!);
        this.targets.set(ctor, { kind: 'entry', entry });
        this.topScope().decls.set(variable.name, { kind: 'local', entry, stmt: node, previous });
      } else {
        const entry = addEntry(this.topScope().owner, variable.name, CodeSymbolType.Variable,
          node.loc!, variable.loc!);
        this.topScope().decls.set(variable.name, { kind: 'local', entry, stmt: node, previous });
      }
    });
  }

  override visitForNumericStatement(node: ForNumericStatement): ResolverScope {
    const scope = this.createDefaultScope();
    scope.decls.set(node.variable.name, { kind: 'loopvar' });
    return scope;
  }

  override visitForGenericStatement(node: ForGenericStatement): ResolverScope {
    const scope = this.createDefaultScope();
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
          continue; // Task 6
        }
        const unwrapped = unwrapValue(field.value);
        if (unwrapped?.type === 'TableConstructorExpression') {
          const innerCtor = unwrapped as TableConstructorExpression;
          const member = getOrAddMember(tableEntry, field.key.name, tableTypeOf(innerCtor), field.loc!, field.key.loc!);
          this.targets.set(innerCtor, { kind: 'entry', entry: member });
        } else {
          getOrAddMember(tableEntry, field.key.name, CodeSymbolType.Field, field.loc!, field.key.loc!);
        }
      }
    }
    return this.createDefaultScope();
  }

  private assignName(name: Identifier, value: Expression | undefined, statement: Statement): void {
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
      return;
    }

    if (value?.type === 'FunctionDeclaration') {
      const entry = addEntry(this.root, name.name, CodeSymbolType.Function, statement.loc!, name.loc!);
      this.targets.set(value, { kind: 'entry', entry });
      if (!binding.entry) {
        this.globals.set(name.name, entry);
      }
    } else if (unwrapped?.type === 'TableConstructorExpression') {
      const ctor = unwrapped as TableConstructorExpression;
      if (binding.entry) {
        if (binding.entry.implicit) {
          binding.entry.loc = statement.loc!;
          binding.entry.selectionLoc = name.loc!;
          binding.entry.implicit = false;
        }
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

  private assignMember(variable: MemberExpression, value: Expression | undefined, statement: Statement): void {
    // Collect the dotted path segments in order: innermost last.
    const segments: Identifier[] = [ variable.identifier ];
    let base: Expression = variable.base;
    while (base.type === 'MemberExpression') {
      segments.unshift(base.identifier);
      base = base.base;
    }
    if (base.type !== 'Identifier') {
      return; // Not a pure dotted path
    }
    const root = base as Identifier;

    if (root.name === 'self') {
      return; // Task 7
    }

    const binding = this.resolve(root.name);
    if (binding.kind === 'param' || binding.kind === 'loopvar') {
      return; // Task 7
    }

    let tableEntry: OutlineEntry;
    if (binding.kind === 'global') {
      if (binding.entry) {
        tableEntry = binding.entry;
      } else {
        const entry = addEntry(this.root, root.name, CodeSymbolType.Table, statement.loc!, root.loc!);
        entry.implicit = true;
        this.globals.set(root.name, entry);
        tableEntry = entry;
      }
    } else {
      if (!binding.entry) {
        return;
      }
      tableEntry = binding.entry;
    }

    // Walk intermediate segments, creating Table members as needed.
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      tableEntry = getOrAddMember(tableEntry, seg.name, CodeSymbolType.Table, statement.loc!, seg.loc!);
    }

    const lastSeg = segments[segments.length - 1];
    const unwrapped = unwrapValue(value);

    if (unwrapped?.type === 'FunctionDeclaration') {
      return; // Task 6
    }

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
  const resolver = new OutlineResolver();
  resolver.visit(chunk);
  return resolver.root.children;
}
