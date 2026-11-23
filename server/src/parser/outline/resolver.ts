import { Expression, Identifier } from '../expressions';
import { AnonymousFunctionName, AssignmentStatement, Chunk, ForGenericStatement, ForNumericStatement,
  FunctionDeclaration, LabelStatement, LocalStatement, Statement } from '../statements';
import { ASTVisitor } from '../visitor';
import { addEntry, CodeSymbolType, OutlineEntry, Owner, signatureOf } from './model';

type Decl = { kind: 'local' | 'param' | 'loopvar', entry?: OutlineEntry };

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
      }
    });
  }

  override visitLocalStatement(node: LocalStatement): void {
    node.variables.forEach((variable, i) => {
      if (variable.type !== 'Identifier') {
        return;
      }
      const value = node.init[i];
      if (value?.type === 'FunctionDeclaration') {
        const entry = addEntry(this.topScope().owner, variable.name, CodeSymbolType.Function,
          node.loc!, variable.loc!);
        this.targets.set(value, { kind: 'entry', entry });
        this.topScope().decls.set(variable.name, { kind: 'local', entry });
      } else {
        const entry = addEntry(this.topScope().owner, variable.name, CodeSymbolType.Variable,
          node.loc!, variable.loc!);
        this.topScope().decls.set(variable.name, { kind: 'local', entry });
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

  private assignName(name: Identifier, value: Expression | undefined, statement: Statement): void {
    const binding = this.resolve(name.name);
    if (binding.kind !== 'global') {
      // Assignment to a local, param, or loopvar: only record if value is a function
      if (value?.type === 'FunctionDeclaration') {
        const entry = addEntry(this.topScope().owner, name.name, CodeSymbolType.Function,
          statement.loc!, name.loc!);
        this.targets.set(value, { kind: 'entry', entry });
      }
      return;
    }

    if (value?.type === 'FunctionDeclaration') {
      const entry = addEntry(this.root, name.name, CodeSymbolType.Function, statement.loc!, name.loc!);
      this.targets.set(value, { kind: 'entry', entry });
      if (!binding.entry) {
        this.globals.set(name.name, entry);
      }
    } else if (!binding.entry) {
      this.globals.set(name.name, addEntry(this.root, name.name, CodeSymbolType.Variable, statement.loc!, name.loc!));
    }
  }

  private resolve(name: string): Binding {
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      const decl = this.scopeStack[i].decls.get(name);
      if (decl) {
        return decl;
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
