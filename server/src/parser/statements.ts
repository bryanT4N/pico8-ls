import { ParseError } from './errors';
import { Comment_, Expression, Identifier, VarargLiteral, Variable, MemberExpression, getMemberExpressionName, Whitespace } from './expressions';
import ResolvedFile from './file-resolver';
import { ASTNode } from './types';

export type Block = ASTNode & {
  type: 'Block',
  body: Statement[],
};

export type LabelStatement = ASTNode & {
  type: 'LabelStatement',
  label: Identifier
};

export type BreakStatement = ASTNode & {
  type: 'BreakStatement',
};

export type GotoStatement = ASTNode & {
  type: 'GotoStatement',
  label: Identifier,
};

export type ReturnStatement = ASTNode & {
  type: 'ReturnStatement',
  arguments: Expression[],
};

export type IfStatement = ASTNode & {
  type: 'IfStatement',
  clauses: GeneralIfClause[],
  oneLine: boolean,
};

export type IfClause = ASTNode & {
  type: 'IfClause',
  condition: Expression,
  block: Block,
};

export type ElseifClause = ASTNode & {
  type: 'ElseifClause',
  condition: Expression,
  block: Block,
};

export type ElseClause = ASTNode & {
  type: 'ElseClause',
  block: Block,
};

export type GeneralIfClause = IfClause | ElseifClause | ElseClause;

export type WhileStatement = ASTNode & {
  type: 'WhileStatement',
  condition: Expression,
  block: Block,
};

export type DoStatement = ASTNode & {
  type: 'DoStatement',
  block: Block,
};

export type RepeatStatement = ASTNode & {
  type: 'RepeatStatement',
  condition: Expression,
  block: Block,
};

export type LocalStatement = ASTNode & {
  type: 'LocalStatement',
  variables: Variable[],
  operator?: string,
  init: Expression[],
};

export type AssignmentStatement = ASTNode & {
  type: 'AssignmentStatement',
  variables: Expression[],
  operator: string,
  init: Expression[],
};

export type CallStatement = ASTNode & {
  type: 'CallStatement',
  expression: Expression | null,
};

export type IncludeStatement = ASTNode & {
  type: 'IncludeStatement',
  filename: string,
  // The file the parser resolved it to. The binder takes it rather than resolving the name again, since the included
  // file's nodes carry this path, spelled as the disk does.
  resolvedFile?: ResolvedFile,
};

export type ForNumericStatement = ASTNode & {
  type: 'ForNumericStatement',
  variable: Identifier,
  start: Expression,
  end: Expression,
  step: Expression | null,
  block: Block,
};

export type ForGenericStatement = ASTNode & {
  type: 'ForGenericStatement',
  variables: Identifier[],
  iterators: Expression[],
  block: Block,
};

export type FunctionParameter = Identifier | VarargLiteral;

export type FunctionDeclaration = ASTNode & {
  type: 'FunctionDeclaration',
  identifier: Identifier | MemberExpression | null,
  isLocal: boolean,
  parameters: FunctionParameter[],
  block: Block,
};

export const AnonymousFunctionName = '<anonymous function>';

export function getFunctionDeclarationName(funcDeclaration: FunctionDeclaration): string {
  if (!funcDeclaration.identifier) {
    return AnonymousFunctionName;
  }

  if (funcDeclaration.identifier.type === 'Identifier') {
    return funcDeclaration.identifier.name;
  }

  return getMemberExpressionName(funcDeclaration.identifier) || AnonymousFunctionName;
}

export type Statement = LabelStatement | BreakStatement | GotoStatement | ReturnStatement | IfStatement
  | WhileStatement | DoStatement | RepeatStatement | LocalStatement | AssignmentStatement | CallStatement
  | FunctionDeclaration | ForNumericStatement | ForGenericStatement | IncludeStatement | Comment_ | Whitespace;

export type StatementWithBody = WhileStatement | DoStatement
  | RepeatStatement | ForNumericStatement | ForGenericStatement | FunctionDeclaration | GeneralIfClause;

export function isStatementWithBody(statement: any): statement is StatementWithBody {
  return !!statement && statement.block !== undefined;
}

export type StatementWithCondition = IfClause | ElseifClause | WhileStatement;

export function isStatementWithCondition(statement: any): statement is StatementWithCondition {
  return !!statement && statement.condition !== undefined;
}

export type Include = { stmt: IncludeStatement, resolvedFile: ResolvedFile };

export type Chunk = {
  type: 'Chunk',
  block: Block,
  errors: ParseError[],
  comments?: Comment_[],
  // The comments of the #included files, kept apart: the formatter, folding and outline regions take `comments` as the
  // main file's own.
  includedComments?: Comment_[],
  includes?: Include[],
  // The files that #includes, nested ones too, could not find or read. A file that appears later can be one of them.
  unresolvedIncludes?: ResolvedFile[],
};
