import { Comment_ } from '../expressions';
import ResolvedFile, { FileResolver } from '../file-resolver';
import Parser from '../parser';
import { isLongComment, isTabMarker, regionMarkerOf } from '../region-markers';
import { ASTNode } from '../types';
import { Analysis, Definition, LuaSymbol } from './model';
import { placeOf, targetsOf } from './queries';

// name is 'return' for @returns too.
export type DocTag = { name: string, param?: string, text: string };
export type Doc = { description: string, tags: DocTag[] };
// definition: the one the doc comes from; with no doc, the one to show the symbol as.
export type Documentation = { definition?: Definition, doc?: Doc };

export function documentationOf(analysis: Analysis, symbol: LuaSymbol): Documentation {
  switch (symbol.kind) {
  case 'self':
    return { doc: symbol.table && documentationOf(analysis, symbol.table).doc };
  case 'loopvar':
    return { definition: symbol.definitions[0] };
  case 'param': {
    // The first definition is the parameter itself; assignments in the body come after it.
    const definition = symbol.definitions[0];
    const text = paramDoc(docAbove(analysis, definition.node), symbol.name);
    return { definition, doc: text === undefined ? undefined : { description: text, tags: [] } };
  }
  }
  const sites = docSites(symbol);
  for (const definition of sites) {
    const doc = definitionDoc(analysis, definition);
    if (doc) {
      return { definition, doc };
    }
  }
  // f = nil, then function f(a): f shows as the function. The value of hp -= 1 says nothing of what hp holds.
  return { definition: sites.find(definition => definition.isFunction) ?? sites.find(definition => !definition.compound) ?? sites[0] };
}

// The definitions Go to Definition goes to.
export function docSites(symbol: LuaSymbol): Definition[] {
  const targets = new Set(targetsOf(symbol).map(placeOf));
  return symbol.definitions.filter(definition => targets.has(placeOf(definition.nameLoc)));
}

export function definitionDoc(analysis: Analysis, definition: Definition): Doc | undefined {
  const { node } = definition;
  if (node.type === 'ForNumericStatement' || node.type === 'ForGenericStatement') {
    return undefined;
  }
  const above = docAbove(analysis, node);
  if (above || definition.isFunction || node.type === 'LabelStatement' || node.type === 'FunctionDeclaration') {
    return above;
  }
  const { start, end } = node.loc!;
  const comment = commentsIn(analysis, start.filename.path)?.trailing.find(trailing => trailing.loc!.start.line === end.line
    && trailing.loc!.start.index >= end.index && !isLongComment(trailing) && /^[\s,;]*$/.test(trailing.lineBefore.slice(end.column)));
  const text = comment && linesOf(comment)[0].trim();
  return text && !isSeparator(text) && !isCode(text) ? parseDoc(text) : undefined;
}

export function paramDoc(doc: Doc | undefined, name: string): string | undefined {
  return doc?.tags.find(tag => tag.name === 'param' && tag.param === name && tag.text !== '')?.text;
}

export function parseDoc(text: string): Doc {
  const description: string[] = [];
  const tags: DocTag[] = [];
  for (const line of text.split('\n')) {
    const tag = /^@(\w+)\s*(.*)$/.exec(line.trimStart());
    if (tag) {
      const [ , name, rest ] = tag;
      if (name === 'param') {
        const [ , param, paramText ] = /^(\S*)\s*(.*)$/.exec(rest)!;
        tags.push({ name, param, text: paramText.trim() });
      } else {
        tags.push({ name: name === 'returns' ? 'return' : name, text: rest.trim() });
      }
    } else if (tags.length > 0) {
      const last = tags[tags.length - 1];
      last.text = last.text === '' ? line.trim() : `${last.text}\n${line.trim()}`;
    } else {
      description.push(line);
    }
  }
  for (const tag of tags) {
    tag.text = tag.text.replace(/\n+$/, '');
  }
  return { description: description.join('\n').trim(), tags };
}

type Block = { comments: Comment_[], endLine: number, title: boolean };
type FileComments = { blocks: Map<number, Block>, trailing: Comment_[] };

const indexes = new WeakMap<Analysis, Map<string, FileComments>>();

function commentsIn(analysis: Analysis, path: string): FileComments | undefined {
  let index = indexes.get(analysis);
  if (!index) {
    index = indexComments(analysis);
    indexes.set(analysis, index);
  }
  return index.get(path);
}

function indexComments(analysis: Analysis): Map<string, FileComments> {
  // By file, then by place: a file included twice has its comments twice.
  const byFile = new Map<string, Map<number, Comment_>>();
  for (const comment of analysis.comments) {
    const { filename, index } = comment.loc!.start;
    let comments = byFile.get(filename.path);
    if (!comments) {
      comments = new Map();
      byFile.set(filename.path, comments);
    }
    comments.set(index, comment);
  }
  const index = new Map<string, FileComments>();
  for (const [ path, comments ] of byFile) {
    index.set(path, fileComments(analysis, path, [ ...comments.values() ].sort((a, b) => a.loc!.start.index - b.loc!.start.index)));
  }
  return index;
}

// A long comment with code after it on its last line, as in --[[ old ]] x = 1, ends a block: the code sits between
// it and the line below.
function fileComments(analysis: Analysis, path: string, comments: Comment_[]): FileComments {
  const blocks: Block[] = [];
  const trailing: Comment_[] = [];
  const tabStarts = new Set<number>();
  let current: Block | undefined;
  for (const comment of comments) {
    const { start, end } = comment.loc!;
    if (!comment.startsLine) {
      trailing.push(comment);
      current = undefined;
    } else if (!comment.endsLine) {
      current = undefined;
    } else if (isTabMarker(comment) || regionMarkerOf(comment) !== undefined) {
      if (isTabMarker(comment)) {
        tabStarts.add(start.line + 1);
      }
      current = undefined;
    } else if (current && start.line === current.endLine + 1) {
      current.comments.push(comment);
      current.endLine = end.line;
    } else {
      current = { comments: [ comment ], endLine: end.line, title: tabStarts.has(start.line) };
      blocks.push(current);
    }
  }
  // In a .p8, comments start at __lua__.
  const first = blocks[0];
  if (first && first.comments[0] === comments[0] && first.comments[0].loc!.start.index < (analysis.codeStarts.get(path) ?? Infinity)) {
    first.title = true;
  }
  return { blocks: new Map(blocks.map(block => [ block.endLine, block ])), trailing };
}

function docAbove(analysis: Analysis, node: ASTNode): Doc | undefined {
  const { start } = node.loc!;
  const block = commentsIn(analysis, start.filename.path)?.blocks.get(start.line - 1);
  const text = block && blockText(block);
  return text === undefined ? undefined : parseDoc(text);
}

function blockText(block: Block): string | undefined {
  if (block.title || isBanner(block)) {
    return undefined;
  }
  const lines = block.comments.flatMap(linesOf);
  const filled = lines.filter(line => line.trim() !== '');
  if (filled.length === 0 || isSeparator(filled[filled.length - 1])) {
    return undefined;
  }
  // One space after -- is the usual gap, not indentation.
  const kept = lines.filter(line => !isSeparator(line)).map(line => line.replace(/^ /, '').trimEnd());
  const words = kept.filter(line => line !== '');
  // Code commented out under a label such as DEBUG:
  const labelled = words.length >= 2 && words[0].endsWith(':');
  if (isCode(words.join('\n')) || (labelled && isCode(words.slice(1).join('\n')))) {
    return undefined;
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
}

// The lines of a comment, without the extra dashes that open a doc comment: --[[-- and ---.
function linesOf(comment: Comment_): string[] {
  const lines = comment.value.split(/\r\n|\r|\n/);
  if (isLongComment(comment)) {
    lines[0] = lines[0].replace(/^-+/, '');
  } else if (comment.raw.startsWith('---') && !isSeparator(lines[0])) {
    lines[0] = lines[0].slice(1);
  }
  return lines;
}

function isSeparator(line: string): boolean {
  return /^[\s\-=*#~_+.]*$/.test(line) && line.replace(/\s/g, '').length >= 3;
}

// A heading on one line, such as -- ==== player ====: text between two runs of such characters other than dots, which
// can end a sentence, as in --- loads the level... The dashes that open the comment belong to the run they touch, as in
// ---- enemies ----, but not across a space, as in -- - then waits...
function isBanner(block: Block): boolean {
  const [ comment ] = block.comments;
  if (block.comments.length > 1 || comment.loc!.start.line !== comment.loc!.end.line) {
    return false;
  }
  const line = isLongComment(comment) ? comment.value : comment.raw.replace(/^--(?=\s)|^\/\//, '');
  const before = /^[\s\-=*#~_+]*/.exec(line)![0];
  // A loop, not a regular expression anchored at the end, which takes quadratic time on a long run inside the text.
  let end = line.length;
  while (end > before.length && /[\s\-=*#~_+]/.test(line[end - 1])) {
    end--;
  }
  return end > before.length && isSeparator(before) && isSeparator(line.slice(end));
}

const COMMENT_FILE = new ResolvedFile('comment', 'comment');
const EVERY_FILE_EMPTY: FileResolver = { doesFileExist: () => true, isFile: () => true, loadFileContents: () => '' };

// Text the parser throws on, such as thousands of nested brackets, is not code.
function isCode(text: string): boolean {
  const t = text.trim().replace(/[,;]$/, '');
  // Not a call with no brackets, such as print "dbg": a one-line doc such as calls "update" parses as one too.
  if (!/[=(){}]|\bend\b|^\s*(#include|\?|local\b|return\b)/m.test(t)) {
    return false;
  }
  const parse = (code: string) => new Parser(COMMENT_FILE, code, { includeFileResolver: EVERY_FILE_EMPTY }).parseChunk();
  try {
    const chunk = parse(t);
    if (chunk.errors.length === 0 && chunk.block.body.length > 0) {
      return true;
    }
    return t.includes('=') && parse('return {' + t + '}').errors.length === 0;
  } catch {
    return false;
  }
}
