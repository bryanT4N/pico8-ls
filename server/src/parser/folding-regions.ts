import { TextDocument } from 'vscode-languageserver-textdocument';
import { Comment_ } from './expressions';
import { isTabMarker, regionMarkerOf } from './region-markers';

export type CartridgeSection = {
  // Name of the section, without the surrounding underscores (e.g. 'lua', 'gfx')
  name: string,
  // 0-based line number of the section marker itself (e.g. the '__gfx__' line)
  startLine: number,
  // 0-based line number of the last line belonging to the section
  endLine: number,
};

const sectionMarkerRegex = /^__([a-z0-9]+)__$/;

// Finds all the cartridge sections (__lua__, __gfx__, etc) in the given lines.
export function findCartridgeSections(lines: string[]): CartridgeSection[] {
  const sections: CartridgeSection[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = sectionMarkerRegex.exec(lines[i].trim());
    if (!match) {
      continue;
    }

    // The previous section ends right before this marker.
    const previous = sections[sections.length - 1];
    if (previous) {
      previous.endLine = i - 1;
    }

    sections.push({ name: match[1], startLine: i, endLine: lines.length - 1 });
  }

  return sections;
}

export type FoldingRegion = { name: string, startLine: number, endLine: number, kind: 'tab' | 'region' };

// Folding regions for the cartridge sections themselves (__lua__, __gfx__, __map__, etc).
// Each region spans from the section marker to the last line before the next section.
export function getSectionFoldingRegions(textDocument: TextDocument): { name: string, startLine: number, endLine: number }[] {
  const lines = textDocument.getText().split('\n');

  return findCartridgeSections(lines)
    // Don't bother with sections that are empty (nothing to fold away)
    .filter(section => section.endLine > section.startLine)
    .map(section => ({
      name: `__${section.name}__`,
      startLine: section.startLine,
      endLine: section.endLine,
    }));
}

export function getFoldingRegions(textDocument: TextDocument, comments: Comment_[]): FoldingRegion[] {
  const sortedComments = [ ...comments ].sort((a, b) => a.loc!.start.line - b.loc!.start.line);
  const lua = findCartridgeSections(textDocument.getText().split('\n')).find(section => section.name === 'lua');
  const codeStartLine = lua ? lua.startLine + 1 : 0;
  const codeEndLine = lua ? lua.endLine : textDocument.lineCount - 1;
  const regions: FoldingRegion[] = [];

  const tabMarkerLines = sortedComments.filter(isTabMarker).map(comment => comment.loc!.start.line - 1);
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
    regions.push({ name: start.label || 'region', startLine: start.startLine, endLine: codeEndLine, kind: 'region' });
  }

  return regions.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
}

// PICO-8 shows the comment that starts a tab's first line as the name of the tab.
function tabName(sortedComments: Comment_[], startLine: number): string {
  const comment = sortedComments.find(c => c.loc!.start.line - 1 === startLine && c.startsLine && !isTabMarker(c));
  return comment?.value.split(/\r\n|\r|\n/).map(line => line.trim()).find(line => line !== '') ?? 'tab';
}
