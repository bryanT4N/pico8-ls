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
// around them are still parsed. Lua finds each of them at a later token than
// the one it names, and stops at the first error it finds, so an error is left
// out when stoppedBefore says that Lua stops before that token.

export class FlowContext {
  allowVararg: boolean;
  scopes: FlowScope[];
  pendingGotos: Goto[];
  breaksOutsideLoops: Token[];
  errors: ParseError[];
  stoppedBefore: (found: Token) => boolean;

  constructor(errors: ParseError[], stoppedBefore: (found: Token) => boolean) {
    this.allowVararg = false;
    this.scopes = [];
    this.pendingGotos = [];
    this.breaksOutsideLoops = [];
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
    for (const theGoto of this.pendingGotos) {
      if (theGoto.maxDepth >= this.scopes.length) {
        theGoto.maxDepth--;
      }
    }
    this.scopes.pop();
  }

  // Leaves the function's own scope, where Lua reports a goto that is still
  // without its label and a break outside a loop. found: the token Lua has read
  // there, the one after the function's `end`, or the end of the file.
  endFunction(found: Token) {
    for (const theGoto of this.pendingGotos) {
      this.report(found, createErrForToken(theGoto.token, errMessages.labelNotVisible, theGoto.target));
    }
    for (const token of this.breaksOutsideLoops) {
      this.report(found, createErrForToken(token, errMessages.noLoopToBreak, 'break'));
    }
    this.pendingGotos = [];
    this.breaksOutsideLoops = [];
    this.scopes.pop();
  }

  addBreak(token: Token) {
    if (!this.isInLoop()) {
      this.breaksOutsideLoops.push(token);
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

    // The first label of a name stays the one gotos jump to.
    if (Object.prototype.hasOwnProperty.call(scope.labels, name)) {
      this.report(found, createErrForToken(token, errMessages.labelAlreadyDefined, name, scope.labels[name].line));
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
