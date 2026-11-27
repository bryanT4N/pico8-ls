import * as assert from 'assert';
import { Identifier } from '../expressions';
import { ASTVisitor, VisitableASTNode } from '../visitor';
import { parse } from './test-utils';

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

  it('visits every iterator of a generic for before any of its names', () => {
    assert.deepStrictEqual(depths('for k, v in next, t do end'), [ 'next@1', 't@1', 'k@2', 'v@2' ]);
  });

  it('visits the bounds of a numeric for outside the loop', () => {
    assert.deepStrictEqual(depths('for i = a, b, c do x = i end'), [ 'a@1', 'b@1', 'c@1', 'i@2', 'x@2', 'i@2' ]);
  });

  it('visits the condition of repeat inside the loop', () => {
    assert.deepStrictEqual(depths('repeat local done = true until done'), [ 'done@2', 'done@2' ]);
  });
});

class Order extends ASTVisitor<number> {
  seen: string[] = [];
  createDefaultScope(): number {
    return 0;
  }
  private see(name: string) {
    this.seen.push(`${name}/${this.nodeStack.length}`);
  }
  override visitIdentifier(node: Identifier): void {
    this.see(node.name);
  }
  override visitBinaryExpression(): void {
    this.see('Binary');
  }
  override visitLogicalExpression(): void {
    this.see('Logical');
  }
  override visitMemberExpression(): void {
    this.see('Member');
  }
  override visitIndexExpression(): void {
    this.see('Index');
  }
  override visitCallExpression(): void {
    this.see('Call');
  }
  override visitStringCallExpression(): void {
    this.see('StringCall');
  }
  override visitTableCallExpression(): void {
    this.see('TableCall');
  }
  override visitStringLiteral(): void {
    this.see('StringLiteral');
  }
  override visitTableConstructorExpression(): number {
    this.see('TableConstructor');
    return 0;
  }
}

describe('ASTVisitor chains', () => {
  it('visits a chain of calls, members and operators in order, with its links on the node stack', () => {
    const visitor = new Order();
    visitor.visit(parse('x = a.b(c)[d]:e"s"{f} + g * h and i'));
    assert.deepStrictEqual(visitor.seen, [
      'x/1', 'Logical/1', 'Binary/2', 'TableCall/3', 'StringCall/4', 'Member/5', 'Index/6', 'Call/7', 'Member/8', 'a/9', 'b/9',
      'c/8', 'd/7', 'e/6', 'StringLiteral/5', 'TableConstructor/4', 'f/6', 'Binary/3', 'g/4', 'h/4', 'i/2',
    ]);
  });

  it('calls onVisitNode once for every node, each link of a chain too, before visiting it', () => {
    class Hooked extends Order {
      override onVisitNode(node: VisitableASTNode): void {
        this.seen.push(`hook ${node.type === 'Identifier' ? node.name : node.type}`);
      }
    }
    const visitor = new Hooked();
    visitor.visit(parse('x = a.b(c)[d]:e"s"{f} + g * h'));
    assert.deepStrictEqual(visitor.seen, [
      'hook AssignmentStatement', 'hook x', 'x/1', 'hook BinaryExpression', 'Binary/1', 'hook TableCallExpression', 'TableCall/2',
      'hook StringCallExpression', 'StringCall/3', 'hook MemberExpression', 'Member/4', 'hook IndexExpression', 'Index/5',
      'hook CallExpression', 'Call/6', 'hook MemberExpression', 'Member/7', 'hook a', 'a/8', 'hook b', 'b/8', 'hook c', 'c/7',
      'hook d', 'd/6', 'hook e', 'e/5', 'hook StringLiteral', 'StringLiteral/4', 'hook TableConstructorExpression',
      'TableConstructor/3', 'hook TableValue', 'hook f', 'f/5', 'hook BinaryExpression', 'Binary/2', 'hook g', 'g/3', 'hook h', 'h/3',
    ]);
  });
});
