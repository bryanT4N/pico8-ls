import { createErrForToken, errMessages, ParseError } from './errors';
import { Token } from './tokens';

export type Goto = {
  token: Token,
  maxDepth: number,
  target: string,
  localCounts: number[],
};

export type Label = {
  localCount: number,
  line: number,
};

export type Local = {
  name: string,
  token: Token,
};

export type FlowScope = {
  labels: { [key: string]: Label },
  locals: Local[],
  deferredGotos: Goto[],
  isLoop: boolean,
};

// Control flow tracking
// ---------------------
// A context object that validates loop breaks and `goto`-based control flow.
// The errors it finds go into the list it was given, so that the statements
// around them are still parsed.

export class FlowContext {
  allowVararg: boolean;
  scopes: FlowScope[];
  pendingGotos: Goto[];
  errors: ParseError[];

  constructor(errors: ParseError[]) {
    this.allowVararg = false;
    this.scopes = [];
    this.pendingGotos = [];
    this.errors = errors;
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

  pushScope(isLoop?: boolean) {
    const scope = {
      labels: {},
      locals: [],
      deferredGotos: [],
      isLoop: !!isLoop,
    };
    this.scopes.push(scope);
  }

  popScope() {
    const stillPending = [];

    for (let i = 0; i < this.pendingGotos.length; ++i) {
      const theGoto = this.pendingGotos[i];
      if (theGoto.maxDepth >= this.scopes.length) {
        if (--theGoto.maxDepth <= 0) {
          this.errors.push(createErrForToken(theGoto.token, errMessages.labelNotVisible, theGoto.target));
          continue;
        }
      }
      stillPending.push(theGoto);
    }

    this.pendingGotos = stillPending;
    this.scopes.pop();
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

  addLabel(name: string, token: Token) {
    const scope = this.currentScope();

    // The first label of a name stays the one gotos jump to.
    if (Object.prototype.hasOwnProperty.call(scope.labels, name)) {
      this.errors.push(createErrForToken(token, errMessages.labelAlreadyDefined, name, scope.labels[name].line));
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
    };
  }

  addLocal(name: string, token: Token) {
    this.currentScope().locals.push({
      name: name,
      token: token,
    });
  }

  raiseDeferredErrors() {
    const scope = this.currentScope();
    const bads = scope.deferredGotos;
    for (let i = 0; i < bads.length; ++i) {
      const theGoto = bads[i];
      this.errors.push(createErrForToken(
        theGoto.token,
        errMessages.gotoJumpInLocalScope,
        theGoto.target,
        scope.locals[theGoto.localCounts[this.scopes.length - 1]].name,
      ));
    }
    // Reported once: this runs again before every statement of the scope.
    scope.deferredGotos = [];
  }
}
