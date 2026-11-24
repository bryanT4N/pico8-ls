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
  let baseName: string;
  switch (memberExpression.base.type) {
  case 'Identifier':
    baseName = memberExpression.base.name;
    break;

  case 'MemberExpression':
    const maybeBaseName = getMemberExpressionName(memberExpression.base);
    if (maybeBaseName === undefined) {
      return undefined;
    } else {
      baseName = maybeBaseName;
    }
    break;

  default:
    // It's a more complicated expression like `getValue().blah`
    return undefined;
  }

  return baseName + '.' + memberExpression.identifier.name;
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

export type Comment_ = ASTNode & {
  type: 'Comment',
  value: string,
  raw: string,
  // Only whitespace comes before the comment on the line where it starts.
  startsLine: boolean,
  // The text of its line before it: empty or blanks when the comment starts its line.
  lineBefore: string,
};

export type Whitespace = ASTNode & {
  type: 'Whitespace',
  // The number of newlines to insert
  count: number,
};

export function isComment(node: any): node is Comment_ {
  return node.type === 'Comment';
}
