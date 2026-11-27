import { FunctionDeclaration } from './statements';
import { ASTNode } from './types';

export type Identifier = ASTNode & {
  type: 'Identifier',
  name: string,
};

export type Variable = Identifier | MemberExpression | IndexExpression;

export type StringLiteral = ASTNode & {
  type: 'StringLiteral',
  value: string,
  raw: string,
};

export type NumericLiteral = ASTNode & {
  type: 'NumericLiteral',
  value: number,
  raw: string,
};

export type BooleanLiteral = ASTNode & {
  type: 'BooleanLiteral',
  value: boolean,
};

export type NilLiteral = ASTNode & {
  type: 'NilLiteral'
};

// A VarargLiteral is '...'
export type VarargLiteral = ASTNode & {
  type: 'VarargLiteral',
  value: any,
  raw: string,
};

export type Literal = StringLiteral | NumericLiteral | BooleanLiteral | NilLiteral | VarargLiteral;

// { [keyExpr] = value }
export type TableKey = ASTNode & {
  type: 'TableKey',
  key: Expression,
  value: Expression,
};

// { key = value }
export type TableKeyString = ASTNode & {
  type: 'TableKeyString',
  key: Identifier,
  value: Expression,
};

// { value }
export type TableValue = ASTNode & {
  type: 'TableValue',
  value: Expression,
};

export type GeneralTableField = TableKey | TableKeyString | TableValue | Whitespace;
export type GeneralTableField_NoWhitespace = TableKey | TableKeyString | TableValue;

const generalTableFieldTypes = Object.freeze([ 'TableKey', 'TableKeyString', 'TableValue' ]);
export function isGeneralTableField(node: ASTNode): node is GeneralTableField_NoWhitespace {
  return node && generalTableFieldTypes.includes(node.type);
}

export type TableConstructorExpression = ASTNode & {
  type: 'TableConstructorExpression',
  fields: GeneralTableField[],
};

export type BinaryExpression = ASTNode & {
  type: 'BinaryExpression',
  operator: string,
  left: Expression,
  right: Expression,
  parens?: boolean,
};

export type LogicalExpression = ASTNode & {
  type: 'LogicalExpression',
  operator: 'and' | 'or',
  left: Expression,
  right: Expression,
  parens?: boolean,
};

export type UnaryExpression = ASTNode & {
  type: 'UnaryExpression',
  operator: string,
  argument: Expression,
};

export type Indexer = '.' | ':';

// base.identifier
// or base:identifier
export type MemberExpression = ASTNode & {
  type: 'MemberExpression',
  base: Expression,
  indexer: Indexer,
  identifier: Identifier,
};

export function getMemberExpressionName(memberExpression: MemberExpression): string | undefined {
  const names = [ memberExpression.identifier.name ];
  let base = memberExpression.base;
  while (base.type === 'MemberExpression') {
    names.push(base.identifier.name);
    base = base.base;
  }
  if (base.type !== 'Identifier') {
    // It's a more complicated expression like `getValue().blah`
    return undefined;
  }
  names.push(base.name);
  return names.reverse().join('.');
}

// base[index]
export type IndexExpression = ASTNode & {
  type: 'IndexExpression',
  base: Expression,
  index: Expression,
};

export type CallExpression = ASTNode & {
  type: 'CallExpression',
  base: Expression,
  arguments: (Expression | Comment_)[],
};

// func { argument }
export type TableCallExpression = ASTNode & {
  type: 'TableCallExpression',
  base: Expression,
  arguments: TableConstructorExpression,
};

// func "argument"
export type StringCallExpression = ASTNode & {
  type: 'StringCallExpression',
  base: Expression,
  argument: StringLiteral,
};

export type Expression = (TableConstructorExpression | BinaryExpression | LogicalExpression | UnaryExpression
  | MemberExpression | IndexExpression | CallExpression | TableCallExpression | StringCallExpression | Literal
  | Identifier | FunctionDeclaration | Whitespace) & {
  /** Whether this expression is surrounded by parentheses. */
  parens?: boolean;
};

// A link of a chain of operators, calls or member accesses. a+b+c is (a+b)+c and a.b(c).d is ((a.b)(c)).d, so a
// long chain nests on the first operand of each link.
export type ChainLink = BinaryExpression | LogicalExpression | MemberExpression | IndexExpression | CallExpression
  | StringCallExpression | TableCallExpression;

export function isChainLink(node: ASTNode): node is ChainLink {
  switch (node.type) {
  case 'BinaryExpression': case 'LogicalExpression': case 'MemberExpression': case 'IndexExpression':
  case 'CallExpression': case 'StringCallExpression': case 'TableCallExpression':
    return true;
  default:
    return false;
  }
}

export function firstOperand(link: ChainLink): Expression {
  return link.type === 'BinaryExpression' || link.type === 'LogicalExpression' ? link.left : link.base;
}

export type Comment_ = ASTNode & {
  type: 'Comment',
  value: string,
  raw: string,
  startsLine: boolean,
  lineBefore: string,
  // Only whitespace, and comments that end the line, come after the comment on the line where it ends: no code.
  endsLine: boolean,
  // A line -->8 where PICO-8 splits the code into tabs (tabsOf).
  tabMarker: boolean,
};

export type Whitespace = ASTNode & {
  type: 'Whitespace',
  // The number of newlines to insert
  count: number,
};

export function isComment(node: any): node is Comment_ {
  return node.type === 'Comment';
}
