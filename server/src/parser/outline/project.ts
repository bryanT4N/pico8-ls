import ResolvedFile from '../file-resolver';
import { Bounds, boundsContain } from '../types';
import { CodeSymbol, CodeSymbolType, NO_OUTLINE_OPTIONS, OutlineBlock, OutlineEntry, OutlineOptions } from './model';

// blocks: those of the analysis; text: the file's, which names the blocks.
export function projectToFile(entries: OutlineEntry[], file: ResolvedFile, blocks: OutlineBlock[] = [], options: OutlineOptions = NO_OUTLINE_OPTIONS,
  text = ''): CodeSymbol[] {
  // With every option off, the outline is the one from before the options.
  const levels = options.showParameters || options.showLoopVariables || options.showBlocks ? new Levels(file, blocks, options, text) : undefined;
  const { listed, lifted } = project(entries, file, levels);
  const top = inOrder([ ...listed, ...lifted ]);
  return levels ? levels.arrange(undefined, top) : top;
}

// listed: the symbols of this level. lifted: this file's entries in the body of a function of another file, which is
// where an #include in a function body puts them. No entry of the other file can hold them in this file's outline, so
// they go up to the nearest entry of this file, or to the top.
function project(entries: OutlineEntry[], file: ResolvedFile, levels?: Levels): { listed: CodeSymbol[], lifted: CodeSymbol[] } {
  const listed: CodeSymbol[] = [];
  const lifted: CodeSymbol[] = [];
  for (const entry of entries) {
    if (entry.loc.start.filename.equals(file)) {
      const inner = project(entry.children, file, levels);
      const ordered = inOrder([ ...inner.listed, ...inner.lifted ]);
      const children = levels ? levels.arrange(entry, ordered) : ordered;
      if (!entry.hidden || children.length > 0) {
        const { name, detail, type, loc, selectionLoc } = entry;
        const symbol = { name, detail, type, loc, selectionLoc, children };
        levels?.made(symbol, entry);
        listed.push(symbol);
      }
      continue;
    }
    // A function's members are the fields set on it (f.x = 1); the rest, like code #included in its body, go up.
    const isFunction = entry.type === CodeSymbolType.Function || entry.type === CodeSymbolType.Method;
    const members = new Set(entry.members.values());
    const stays = (child: OutlineEntry) => !isFunction || members.has(child);
    const kept = project(entry.children.filter(stays), file, levels);
    const body = project(entry.children.filter(child => !stays(child)), file, levels);
    lifted.push(...kept.lifted, ...body.listed, ...body.lifted);
    if (kept.listed.length > 0) {
      // Members this file adds to an entry of another file still need a parent in this file's outline.
      const children = inOrder(kept.listed);
      const { loc, selectionLoc } = children[0];
      listed.push({ name: entry.name, detail: undefined, type: CodeSymbolType.Table, loc, selectionLoc, children });
    }
  }
  return { listed, lifted };
}

// What the options add to each level of the outline: the level of an entry of this file, or the top, whose owner is
// undefined, as it is for the blocks there.
class Levels {
  private readonly blocksByOwner = new Map<OutlineEntry | undefined, OutlineBlock[]>();
  // The block that a symbol made from an entry, or a loop variable, is in.
  private readonly blockOf = new Map<CodeSymbol, OutlineBlock>();

  constructor(private readonly file: ResolvedFile, blocks: OutlineBlock[], private readonly options: OutlineOptions, private readonly text: string) {
    for (const block of blocks) {
      if (block.loc.start.filename.equals(file)) {
        const owned = this.blocksByOwner.get(block.owner) ?? [];
        owned.push(block);
        this.blocksByOwner.set(block.owner, owned);
      }
    }
  }

  made(symbol: CodeSymbol, entry: OutlineEntry): void {
    // A table created by t.k = 1 and defined later takes the range of its definition, which can lie outside the block
    // it was created in.
    for (let block = entry.block; block; block = block.parent) {
      if (boundsContain(block.loc, entry.loc)) {
        this.blockOf.set(symbol, block);
        return;
      }
    }
  }

  arrange(owner: OutlineEntry | undefined, symbols: CodeSymbol[]): CodeSymbol[] {
    const owned = this.blocksByOwner.get(owner) ?? [];
    const variables: CodeSymbol[] = [];
    if (this.options.showParameters) {
      for (const parameter of owner?.parameters ?? []) {
        if (parameter.loc.start.filename.equals(this.file)) {
          variables.push(variableSymbol(parameter.name, parameter.loc));
        }
      }
    }
    if (this.options.showLoopVariables) {
      for (const block of owned) {
        for (const variable of block.variables) {
          const symbol = variableSymbol(variable.name, variable.loc);
          this.blockOf.set(symbol, block);
          variables.push(symbol);
        }
      }
    }
    const all = [ ...variables, ...symbols ];
    if (!this.options.showBlocks || owned.length === 0) {
      return inOrder(all);
    }
    const nodes = new Map<OutlineBlock, CodeSymbol>();
    const top: CodeSymbol[] = [];
    const nodeOf = (block: OutlineBlock): CodeSymbol => {
      let node = nodes.get(block);
      if (!node) {
        node = { name: blockName(block, this.text), detail: undefined, type: CodeSymbolType.Block, loc: block.loc, selectionLoc: block.selectionLoc, children: [] };
        nodes.set(block, node);
        (block.parent ? nodeOf(block.parent).children : top).push(node);
      }
      return node;
    };
    for (const symbol of all) {
      const block = this.blockOf.get(symbol);
      // An entry lifted from the body of a function of another file is in that function's blocks, which are not listed.
      (block && block.owner === owner ? nodeOf(block).children : top).push(symbol);
    }
    for (const node of nodes.values()) {
      node.children = inOrder(node.children);
    }
    return inOrder(top);
  }
}

function variableSymbol(name: string, loc: Bounds): CodeSymbol {
  return { name, detail: undefined, type: CodeSymbolType.Variable, loc, selectionLoc: loc, children: [] };
}

// The block's first line up to its do or then. A condition's range leaves out its parentheses, so those that close
// right after it are taken too.
function blockName(block: OutlineBlock, text: string): string {
  let header: string = block.keyword;
  if (block.headerEnd) {
    const closing = /(\s*\))*/y;
    closing.lastIndex = block.headerEnd.index;
    header = text.slice(block.loc.start.index, block.headerEnd.index + closing.exec(text)![0].length);
  }
  const name = header.split(/\r\n|\r|\n/)[0].replace(/\s+/g, ' ').trim();
  return name.length > 40 ? name.slice(0, 39) + '…' : name;
}

function inOrder(symbols: CodeSymbol[]): CodeSymbol[] {
  return listedOnce(symbols.sort(bySourcePosition));
}

// Entries defined by the same statement share loc.start, so where their names sit breaks the tie.
function bySourcePosition(a: CodeSymbol, b: CodeSymbol): number {
  return a.loc.start.index - b.loc.start.index || a.selectionLoc.start.index - b.selectionLoc.start.index;
}

// A file included twice is in the analysis twice, so each of its entries comes twice.
function listedOnce(symbols: CodeSymbol[]): CodeSymbol[] {
  const listed = new Set<string>();
  return symbols.filter(({ name, type, loc }) => {
    const key = JSON.stringify([ name, type, loc.start.filename.path, loc.start.index, loc.end.index ]);
    if (listed.has(key)) {
      return false;
    }
    listed.add(key);
    return true;
  });
}
