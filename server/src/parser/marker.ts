import { Token } from './tokens';
import { Bounds, ASTNode, boundsClone, CodeLocation } from './types';

export default class Marker {
  loc: Bounds;

  constructor(tokenOrBounds: Token | Bounds) {
    if ((tokenOrBounds as Token).type) {
      this.loc = (tokenOrBounds as Token).bounds;
    } else {
      this.loc = (tokenOrBounds as Bounds);
    }
  }

  complete(endLocation: CodeLocation) {
    this.loc = boundsClone(this.loc);
    this.loc.end = endLocation;
  }

  bless(node: ASTNode) {
    node.loc = this.loc;
  }

  clone(): Marker {
    return new Marker(boundsClone(this.loc));
  }
}
