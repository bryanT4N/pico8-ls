import {
  FoldingRange,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Comment_ } from './parser/expressions';
import { Chunk } from './parser/statements';
import { FoldingRangeVisitor } from './parser/folding-range-visitor';
import { getFoldingRegions, getSectionFoldingRegions } from './parser/folding-regions';

function getCommentFoldingRanges(comments: Comment_[]): FoldingRange[] {
  const ranges: FoldingRange[] = [];
  for (const comment of comments) {
    if (comment.loc && comment.loc.start.line < comment.loc.end.line) {
      ranges.push({
        startLine: comment.loc.start.line - 1,
        endLine: comment.loc.end.line - 1,
        kind: 'comment',
      });
    }
  }
  return ranges;
}

export function computeFoldingRanges(textDocument: TextDocument, chunk: Chunk): FoldingRange[] {
  const sectionRanges: FoldingRange[] = getSectionFoldingRegions(textDocument).map(section => ({
    startLine: section.startLine,
    endLine: section.endLine,
    kind: 'region' as string,
  }));

  const groupingRanges: FoldingRange[] = getFoldingRegions(textDocument, chunk.comments || []).map(region => ({
    startLine: region.startLine,
    endLine: region.endLine,
    kind: 'region' as string,
  }));

  const visitor = new FoldingRangeVisitor();
  visitor.visit(chunk);
  const blockRanges = visitor.ranges;

  const commentRanges = getCommentFoldingRanges(chunk.comments || []);

  const allRanges = [ ...sectionRanges, ...groupingRanges, ...blockRanges, ...commentRanges ];
  const uniqueRanges = Array.from(new Map(allRanges.map(r => [ `${r.startLine}-${r.endLine}`, r ])).values());

  return uniqueRanges;
}
