import { Comment_, Expression } from '../expressions';
import ResolvedFile from '../file-resolver';
import type { OutlineEntry } from '../outline/model';
import { ASTNode, Bounds } from '../types';

export type SymbolKind = 'global' | 'local' | 'param' | 'loopvar' | 'member' | 'label' | 'self' | 'value';

// node: the statement, table field or label the definition comes from; a loop variable's for statement; a parameter's:
// the statement or table field that defines its function, where that function's doc is read, or else the
// FunctionDeclaration. value: what it assigns, as an initializer, a table field's value, or a function statement's
// FunctionDeclaration. Docs read the comments above node.
export type Definition = { loc: Bounds, nameLoc: Bounds, node: ASTNode, value?: Expression, isFunction: boolean, compound: boolean };

// One per identifier that names something; loc covers that identifier only. A compound target (x += 1) reads and writes.
// order: when the analysis came to it, counted together with Declared.order; for a goto, where the goto is.
export type Reference = { symbol: LuaSymbol, loc: Bounds, read: boolean, write: boolean, isCall: boolean, order: number };

// A local, parameter or loop variable, visible in its scope from index visibleFrom of file on.
export type Declared = { symbol: LuaSymbol, file: ResolvedFile, visibleFrom: number, order: number };

// For a block whose closing keyword is missing, the end of loc is synthetic: only its index is meaningful.
export type Scope = { kind: 'file' | 'function' | 'block', loc?: Bounds, parent?: Scope, children: Scope[], declarations: Declared[] };

export class LuaSymbol {
  readonly members = new Map<string, LuaSymbol>();
  readonly definitions: Definition[] = [];
  readonly references: Reference[] = [];
  // The outline entries that list it, in any file.
  readonly entries: OutlineEntry[] = [];
  // Kind 'self': the method's table when rule 8 knows it.
  table?: LuaSymbol;
  // '(a,b)', from the function definition visited last.
  signature?: string;

  // owner: a member's table symbol.
  constructor(readonly kind: SymbolKind, readonly name: string, readonly owner?: LuaSymbol) {}

  member(key: string): LuaSymbol {
    let member = this.members.get(key);
    if (!member) {
      member = new LuaSymbol('member', key, this);
      this.members.set(key, member);
    }
    return member;
  }
}

export type Analysis = {
  // The top-level outline entries of every file in the chunk.
  outline: OutlineEntry[],
  globals: Map<string, LuaSymbol>,
  // Key: ResolvedFile.path. Sorted by loc.start.index.
  referencesByFile: Map<string, Reference[]>,
  // Every member symbol that has a reference, by key.
  membersByKey: Map<string, LuaSymbol[]>,
  // The file scope.
  scope: Scope,
  // Key: ResolvedFile.path of an #included file. The scope its first #include is in.
  includeScopes: Map<string, Scope>,
  // Key: ResolvedFile.path of an #included file. The order the analysis had come to at its first #include.
  includeStarts: Map<string, number>,
  // Key: ResolvedFile.path. Where each #include in the file ends, with the order the analysis had come to after the
  // included content.
  includeCheckpoints: Map<string, Array<{ index: number, order: number }>>,
  // chunk.comments, then chunk.includedComments: a file included twice comes twice.
  comments: Comment_[],
};
