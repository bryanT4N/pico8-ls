import { SymbolInformation } from 'vscode-languageserver/node';
import { symbolKindFor } from './document-symbols';
import { Analysis } from './parser/analysis/model';
import { placeOf } from './parser/analysis/queries';
import { CodeSymbolType, isColonMethod, NO_OUTLINE_OPTIONS, OutlineBlock, OutlineEntry, OutlineOptions, OutlineVariable } from './parser/outline/model';
import { AnonymousFunctionName } from './parser/statements';
import { Bounds } from './parser/types';
import { compareStrings, groupBy } from './parser/util';
import { rangeOf } from './ranges';

export type SymbolItem = {
  name: string,
  own: string,
  nameKey: string,
  ownKey: string,
  label: string,
  container: string,
  type: CodeSymbolType,
  selectionLoc: Bounds,
};

// A cart holds at most 8,192 tokens, so only a folder full of .lua files gets near this.
export const SYMBOL_LIMIT = 1000;

type Items = { byUri: Map<string, SymbolItem[]>, byPlace: Map<string, SymbolItem> };

// An analysis is never changed, only replaced, so its items hold for as long as it lives.
const cache = new WeakMap<Analysis, Map<string, Items>>();

export function symbolItems(analysis: Analysis, options: OutlineOptions = NO_OUTLINE_OPTIONS): Map<string, SymbolItem[]> {
  return itemsOf(analysis, options).byUri;
}

export function containerOf(analysis: Analysis, nameLoc: Bounds): string | undefined {
  return itemsOf(analysis, NO_OUTLINE_OPTIONS).byPlace.get(placeOf(nameLoc))?.container;
}

// VS Code filters and ranks the result again with its own fuzzy match, so this match only has to be loose enough to
// keep whatever that one keeps.
export function searchSymbols(items: SymbolItem[], query: string, limit = SYMBOL_LIMIT): SymbolItem[] {
  // VS Code takes these characters out of a query before it matches too.
  const q = query.toLowerCase().replace(/[\s*"\u2026]/g, '');
  if (q === '') {
    return [];
  }
  const ranked: Array<{ item: SymbolItem, name: string, tier: number }> = [];
  for (const item of items) {
    const { nameKey: name, ownKey: own } = item;
    if (!hasInOrder(name, q)) {
      continue;
    }
    const tier = own === q || name === q ? 0 : own.startsWith(q) || name.startsWith(q) ? 1 : name.includes(q) ? 2 : 3;
    ranked.push({ item, name, tier });
  }
  ranked.sort((a, b) => a.tier - b.tier || a.name.length - b.name.length || compareStrings(a.name, b.name)
    || compareStrings(a.item.selectionLoc.start.filename.fileURL, b.item.selectionLoc.start.filename.fileURL)
    || a.item.selectionLoc.start.index - b.item.selectionLoc.start.index);
  return ranked.slice(0, limit).map(({ item }) => item);
}

export function toSymbolInformation(item: SymbolItem): SymbolInformation {
  const information: SymbolInformation = {
    name: item.label,
    kind: symbolKindFor(item.type),
    location: { uri: item.selectionLoc.start.filename.fileURL, range: rangeOf(item.selectionLoc) },
  };
  if (item.container !== '') {
    information.containerName = item.container;
  }
  return information;
}

function itemsOf(analysis: Analysis, options: OutlineOptions): Items {
  let byOptions = cache.get(analysis);
  if (!byOptions) {
    byOptions = new Map<string, Items>();
    cache.set(analysis, byOptions);
  }
  // A block is no definition, so showBlocks adds no items.
  const key = `${options.showParameters} ${options.showLoopVariables}`;
  let items = byOptions.get(key);
  if (!items) {
    items = buildItems(analysis, options);
    byOptions.set(key, items);
  }
  return items;
}

// The entry's own parent field is no help at the top, where it is the file's root, which has no name or members.
type Parent = { entry: OutlineEntry, name: string, container: string };

function buildItems(analysis: Analysis, options: OutlineOptions): Items {
  const byUri = new Map<string, SymbolItem[]>();
  const byPlace = new Map<string, SymbolItem>();
  const listed = new Set<string>();
  const add = (item: SymbolItem): boolean => {
    const { start, end } = item.selectionLoc;
    // A file included twice is in the analysis twice.
    const key = JSON.stringify([ item.label, start.filename.path, start.index, end.index ]);
    if (listed.has(key)) {
      return false;
    }
    listed.add(key);
    const inFile = byUri.get(start.filename.fileURL) ?? [];
    inFile.push(item);
    byUri.set(start.filename.fileURL, inFile);
    return true;
  };
  // Left out of byPlace, so that hover does not change with the options.
  const addVariables = (variables: OutlineVariable[], container: string) => {
    for (const { name, loc } of variables) {
      const nameKey = name.toLowerCase();
      add({ name, own: name, nameKey, ownKey: nameKey, label: name, container, type: CodeSymbolType.Variable, selectionLoc: loc });
    }
  };
  const blocksByOwner = options.showLoopVariables ? groupBy(analysis.blocks, block => block.owner) : new Map<OutlineEntry | undefined, OutlineBlock[]>();
  const addLoopVariables = (owner: OutlineEntry | undefined, container: string) => {
    for (const block of blocksByOwner.get(owner) ?? []) {
      addVariables(block.variables, container);
    }
  };
  addLoopVariables(undefined, '');
  const visit = (entries: OutlineEntry[], parent: Parent | undefined) => {
    for (const entry of entries) {
      const member = parent !== undefined && isMemberOf(entry, parent.entry);
      const name = member ? parent.name + separatorOf(entry) + entry.name : entry.name;
      // A member's table is already in its name, and an anonymous function says nothing of where its code is.
      const container = parent === undefined ? ''
        : member || parent.entry.name === AnonymousFunctionName ? parent.container : parent.name;
      if (isListed(entry)) {
        const isFunction = entry.type === CodeSymbolType.Function || entry.type === CodeSymbolType.Method;
        const own = entry.name.split(/[.:]/).pop()!;
        const item: SymbolItem = {
          name,
          own,
          nameKey: name.toLowerCase(),
          ownKey: own.toLowerCase(),
          label: isFunction ? name + '()' : name,
          container,
          type: entry.type,
          selectionLoc: entry.selectionLoc,
        };
        if (add(item)) {
          const place = placeOf(entry.selectionLoc);
          if (!byPlace.has(place)) {
            byPlace.set(place, item);
          }
        }
      }
      // A block is not in the entry tree, so a loop variable is in the function whose body holds its for, and an
      // anonymous function's parameters are where the function is.
      const inside = entry.name === AnonymousFunctionName ? container : name;
      if (options.showParameters) {
        addVariables(entry.parameters ?? [], inside);
      }
      addLoopVariables(entry, inside);
      visit(entry.children, { entry, name, container });
    }
  };
  visit(analysis.outline, undefined);
  return { byUri, byPlace };
}

// An anonymous function has no name to search for, and a label is no definition. The outline creates an implicit
// table and keeps a hidden local only to hold their children; the function the local stands for is listed itself.
function isListed(entry: OutlineEntry): boolean {
  return entry.name !== AnonymousFunctionName && entry.type !== CodeSymbolType.Label && !entry.implicit && !entry.hidden;
}

// A method grouped under its table, or written in the table's constructor, is not among the table's data members, but
// its symbol belongs to the table's. A method held flat by a variable belongs to a table no name holds, so it is not.
function isMemberOf(entry: OutlineEntry, parent: OutlineEntry): boolean {
  return parent.members.get(entry.name) === entry
    || (entry.symbol !== undefined && parent.symbol !== undefined && entry.symbol.owner === parent.symbol);
}

function separatorOf(entry: OutlineEntry): string {
  if (entry.type !== CodeSymbolType.Function && entry.type !== CodeSymbolType.Method) {
    return '.';
  }
  const { start } = entry.selectionLoc;
  const value = entry.symbol?.definitions
    .find(definition => definition.nameLoc.start.filename.path === start.filename.path && definition.nameLoc.start.index === start.index)
    ?.value;
  return value?.type === 'FunctionDeclaration' && isColonMethod(value) ? ':' : '.';
}

function hasInOrder(text: string, query: string): boolean {
  let at = 0;
  for (const char of query) {
    at = text.indexOf(char, at) + 1;
    if (at === 0) {
      return false;
    }
  }
  return true;
}
