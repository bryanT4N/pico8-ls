import * as path from 'path';
import { createErrForToken, errMessages, ParseError } from './errors';
import ResolvedFile from './file-resolver';
import { Token } from './tokens';
import { CodeLocation } from './types';

export type Goto = {
  token: Token,
  maxDepth: number,
  target: string,
  localCounts: number[],
};

export type Label = {
  localCount: number,
  line: number,
  file: ResolvedFile,
};

export type Local = {
  name: string,
  token: Token,
};

// One for each local variable Lua makes, the hidden ones of a for loop among them.
export type LocalVariable = { name: string };

export type FlowScope = {
  labels: { [key: string]: Label },
  locals: Local[],
  variables: LocalVariable[],
  deferredGotos: Goto[],
  isLoop: boolean,
};

// The errors it finds go into the list it was given, so that the statements around them are still parsed. Lua finds
// each of them at a later token than the one it names, and stops at the first error it finds, so an error is left out
// when stoppedBefore says that Lua stops before that token.

export class FlowContext {
  allowVararg: boolean;
  scopes: FlowScope[];
  pendingGotos: Goto[];
  errors: ParseError[];
  stoppedBefore: (found: Token) => boolean;

  // The local variables of the functions around this one that are in scope where it starts: it can have no more
  // upvalues than these and _ENV.
  readonly outerVariables: number;
  // Null unless outerVariables could take this function past the upvalue limit.
  upvalues: Set<LocalVariable | 'ENV'> | null;
  reportedTooManyVariables = false;
  reportedTooManyUpvalues = false;

  constructor(errors: ParseError[], stoppedBefore: (found: Token) => boolean, readonly parent: FlowContext | null = null,
    readonly start: CodeLocation | null = null, maxUpvalues = Infinity) {
    this.outerVariables = parent ? parent.outerVariables + parent.activeVariables() : 0;
    this.upvalues = this.outerVariables + 1 > maxUpvalues ? new Set() : null;
    this.allowVararg = false;
    this.scopes = [];
    this.pendingGotos = [];
    this.errors = errors;
    this.stoppedBefore = stoppedBefore;
  }

  isInLoop(): boolean {
    let i = this.scopes.length;
    while (i --> 0) {
      if (this.scopes[i].isLoop) {
        return true;
      }
    }
    return false;
  }

  currentScope() {
    return this.scopes[this.scopes.length - 1];
  }

  activeVariables(): number {
    let count = 0;
    for (const scope of this.scopes) {
      count += scope.variables.length;
    }
    return count;
  }

  variableNamed(name: string): LocalVariable | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const variables = this.scopes[i].variables;
      for (let j = variables.length - 1; j >= 0; j--) {
        if (variables[j].name === name) {
          return variables[j];
        }
      }
    }
    return undefined;
  }

  pushScope(isLoop?: boolean) {
    const scope = {
      labels: {},
      locals: [],
      variables: [],
      deferredGotos: [],
      isLoop: !!isLoop,
    };
    this.scopes.push(scope);
  }

  popScope() {
    for (const theGoto of this.pendingGotos) {
      if (theGoto.maxDepth >= this.scopes.length) {
        theGoto.maxDepth--;
      }
    }
    this.scopes.pop();
  }

  // Leaves the function's own scope, where Lua reports the first goto that is
  // still without its label, a break outside a loop being one. found: the token
  // Lua has read there, the one after the function's `end`, or the end of the
  // file.
  endFunction(found: Token) {
    const [ first ] = this.pendingGotos;
    if (first) {
      this.report(found, first.target === 'break'
        ? createErrForToken(first.token, errMessages.noLoopToBreak, 'break')
        : createErrForToken(first.token, errMessages.labelNotVisible, first.target));
    }
    this.scopes.pop();
  }

  // Lua takes a break as a goto to a label named break, which no code can
  // define, so one outside a loop is still pending at the end of the function.
  addBreak(token: Token) {
    if (!this.isInLoop()) {
      this.pendingGotos.push({ maxDepth: this.scopes.length, target: 'break', token, localCounts: [] });
    }
  }

  addGoto(target: string, token: Token) {
    const localCounts = [];

    for (let i = 0; i < this.scopes.length; ++i) {
      const scope = this.scopes[i];
      localCounts.push(scope.locals.length);
      if (Object.prototype.hasOwnProperty.call(scope.labels, target)) {
        return;
      }
    }

    this.pendingGotos.push({
      maxDepth: this.scopes.length,
      target: target,
      token: token,
      localCounts: localCounts,
    });
  }

  // found: the token after the label's name, which Lua has read when it finds the name taken.
  addLabel(name: string, token: Token, found: Token) {
    const scope = this.currentScope();

    if (Object.prototype.hasOwnProperty.call(scope.labels, name)) {
      const first = scope.labels[name];
      this.report(found, first.file.equals(token.bounds.start.filename)
        ? createErrForToken(token, errMessages.labelAlreadyDefined, name, first.line)
        : createErrForToken(token, errMessages.labelAlreadyDefinedInFile, name, first.line, path.basename(first.file.path)));
      return;
    }

    const newGotos = [];

    for (let i = 0; i < this.pendingGotos.length; ++i) {
      const theGoto = this.pendingGotos[i];

      if (theGoto.maxDepth >= this.scopes.length && theGoto.target === name) {
        if (theGoto.localCounts[this.scopes.length - 1] < scope.locals.length) {
          scope.deferredGotos.push(theGoto);
        }

        continue;
      }

      newGotos.push(theGoto);
    }

    this.pendingGotos = newGotos;

    scope.labels[name] = {
      localCount: scope.locals.length,
      line: token.bounds.start.line,
      file: token.bounds.start.filename,
    };
  }

  addLocal(name: string, token: Token) {
    this.currentScope().locals.push({
      name: name,
      token: token,
    });
  }

  // found: the first token after the label that is not another label or a `;`, where Lua checks the gotos to it.
  raiseDeferredErrors(found: Token) {
    const scope = this.currentScope();
    const bads = scope.deferredGotos;
    for (let i = 0; i < bads.length; ++i) {
      const theGoto = bads[i];
      this.report(found, createErrForToken(
        theGoto.token,
        errMessages.gotoJumpInLocalScope,
        theGoto.target,
        scope.locals[theGoto.localCounts[this.scopes.length - 1]].name,
      ));
    }
    // Reported once: this runs again before every statement of the scope.
    scope.deferredGotos = [];
  }

  private report(found: Token, error: ParseError) {
    if (!this.stoppedBefore(found)) {
      this.errors.push(error);
    }
  }
}
