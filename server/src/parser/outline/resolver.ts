import { Expression, Identifier } from '../expressions';
import { AssignmentStatement, Chunk, FunctionDeclaration, LabelStatement, Statement } from '../statements';
import { ASTVisitor } from '../visitor';
import { addEntry, CodeSymbolType, OutlineEntry, Owner, signatureOf } from './model';

type Decl = { kind: 'local' | 'param' | 'loopvar', entry?: OutlineEntry };

// What a name refers to at some point: its innermost declaration, or else the global.
type Binding = Decl | { kind: 'global', entry?: OutlineEntry };

class ResolverScope {
  decls = new Map<string, Decl>();
  constructor(public owner: Owner) {}
}

class OutlineResolver extends ASTVisitor<ResolverScope> {
  readonly root: Owner = { children: [] };
  // The first entry each global name got.
  private readonly globals = new Map<string, OutlineEntry>();
  // Filled in by an assignment for each function value it assigns, before the
  // visitor reaches that function, so the entry can own the function's body.
  private readonly functionEntries = new Map<FunctionDeclaration, OutlineEntry>();

  override startingScope(): ResolverScope {
    return new ResolverScope(this.root);
  }

  createDefaultScope(): ResolverScope {
    return new ResolverScope(this.topScope().owner);
  }

  override visitFunctionDeclaration(node: FunctionDeclaration): ResolverScope {
    if (node.identifier?.type === 'Identifier' && !node.isLocal) {
      // `function f() end` assigns to f, the same as `f = function() end`.
      this.assignName(node.identifier, node, node);
    }

    const entry = this.functionEntries.get(node);
    const scope = entry ? new ResolverScope(entry) : this.createDefaultScope();
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

  override visitLabelStatement(node: LabelStatement): void {
    addEntry(this.topScope().owner, node.label.name, CodeSymbolType.Label, node.loc!, node.label.loc!);
  }

  private assignName(name: Identifier, value: Expression | undefined, statement: Statement): void {
    const binding = this.resolve(name.name);
    if (binding.kind !== 'global') {
      return;
    }

    if (value?.type === 'FunctionDeclaration') {
      const entry = addEntry(this.root, name.name, CodeSymbolType.Function, statement.loc!, name.loc!, signatureOf(value));
      this.functionEntries.set(value, entry);
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
