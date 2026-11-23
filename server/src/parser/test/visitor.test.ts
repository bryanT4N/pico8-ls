import * as assert from 'assert';
import { Identifier } from '../expressions';
import { ASTVisitor } from '../visitor';
import { parse } from './test-utils';

// Records each name with the number of scopes open when it is visited.
class ScopeDepths extends ASTVisitor<number> {
  seen: string[] = [];
  createDefaultScope(): number {
    return this.scopeStack.length;
  }
  override visitIdentifier(node: Identifier): void {
    this.seen.push(`${node.name}@${this.scopeStack.length}`);
  }
}

function depths(code: string): string[] {
  const visitor = new ScopeDepths();
  visitor.visit(parse(code));
  return visitor.seen;
}

describe('ASTVisitor scopes', () => {
  it('visits the iterators of a generic for outside the loop', () => {
    assert.deepStrictEqual(depths('for t in all(t) do print(t) end'), [ 'all@1', 't@1', 't@2', 'print@2', 't@2' ]);
  });

  it('visits the bounds of a numeric for outside the loop', () => {
    assert.deepStrictEqual(depths('for i = a, b, c do x = i end'), [ 'a@1', 'b@1', 'c@1', 'i@2', 'x@2', 'i@2' ]);
  });

  it('visits the condition of repeat inside the loop', () => {
    assert.deepStrictEqual(depths('repeat local done = true until done'), [ 'done@2', 'done@2' ]);
  });
});
