import { TextDocument } from 'vscode-languageserver-textdocument';
import { readCode } from './code';
import { Comment_ } from './expressions';
import { regionMarkerOf } from './region-markers';

export type FoldingRegion = { name: string, startLine: number, endLine: number, kind: 'tab' | 'region' };

// The sections of a cart as PICO-8 reads them (readCode), __lua__ among them, each from its line to the line before the
// next.
export function getSectionFoldingRegions(textDocument: TextDocument): { startLine: number, endLine: number }[] {
  const startLines = (readCode(textDocument.getText()).sections ?? []).map(index => textDocument.positionAt(index).line);
  return startLines
    .map((startLine, k) => ({ startLine, endLine: k + 1 < startLines.length ? startLines[k + 1] - 1 : textDocument.lineCount - 1 }))
    // Don't bother with sections that are empty (nothing to fold away)
    .filter(section => section.endLine > section.startLine);
}

// The tabs and #region markers of the code that PICO-8 reads from the text (readCode).
export function getFoldingRegions(textDocument: TextDocument, comments: Comment_[]): FoldingRegion[] {
  const sortedComments = [ ...comments ].sort((a, b) => a.loc!.start.line - b.loc!.start.line);
  const code = readCode(textDocument.getText());
  const codeStartLine = textDocument.positionAt(code.runs[0].from).line;
  const codeEndLine = code.end ? textDocument.positionAt(code.end.index).line - 1 : textDocument.lineCount - 1;
  const regions: FoldingRegion[] = [];

  const tabMarkerLines = sortedComments.filter(comment => comment.tabMarker).map(comment => comment.loc!.start.line - 1);
  if (tabMarkerLines.length > 0) {
    const startLines = [ codeStartLine, ...tabMarkerLines.map(line => line + 1) ];
    const endLines = [ ...tabMarkerLines.map(line => line - 1), codeEndLine ];
    startLines.forEach((startLine, tabNumber) => {
      const endLine = endLines[tabNumber];
      // An empty tab still takes its number, so that the numbers match the tabs in PICO-8.
      if (endLine >= startLine) {
        regions.push({ name: `${tabNumber}: ${tabName(sortedComments, startLine)}`, startLine, endLine, kind: 'tab' });
      }
    });
  }

  const openRegions: { startLine: number, label: string }[] = [];
  for (const comment of sortedComments) {
    const marker = regionMarkerOf(comment);
    const line = comment.loc!.start.line - 1;
    if (marker?.kind === 'start') {
      openRegions.push({ startLine: line, label: marker.label });
    } else if (marker?.kind === 'end') {
      const start = openRegions.pop();
      if (start) {
        regions.push({ name: start.label || marker.label || 'region', startLine: start.startLine, endLine: line, kind: 'region' });
      }
    }
  }
  for (const start of openRegions) {
    // Running on to the end of the code would take in every later tab as well.
    const endLine = tabAt(regions, start.startLine)?.endLine ?? codeEndLine;
    regions.push({ name: start.label || 'region', startLine: start.startLine, endLine, kind: 'region' });
  }

  return regions.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
}

export function tabAt(regions: FoldingRegion[], line: number): FoldingRegion | undefined {
  return regions.find(region => region.kind === 'tab' && region.startLine <= line && line <= region.endLine);
}

// PICO-8 shows the comment that starts a tab's first line as the name of the tab.
function tabName(sortedComments: Comment_[], startLine: number): string {
  const comment = sortedComments.find(c => c.loc!.start.line - 1 === startLine && c.startsLine && !c.tabMarker);
  return comment?.value.split(/\r\n|\r|\n/).map(line => line.trim()).find(line => line !== '') ?? 'tab';
}
