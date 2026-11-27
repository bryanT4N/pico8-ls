import { Comment_ } from './expressions';

export type RegionMarker = { kind: 'start' | 'end', label: string };

export function isLongComment(comment: Comment_): boolean {
  return /^--\[=*\[/.test(comment.raw);
}

const regionMarkerRegex = /^#(region|endregion)(?:\s+(.*))?$/;

// Like VS Code, only line comments (-- or //) mark regions; a #region in a long comment --[[ … ]] is not a marker.
// A #region written after code on the same line is a remark about that code, not a marker.
export function regionMarkerOf(comment: Comment_): RegionMarker | undefined {
  const match = comment.startsLine && !isLongComment(comment) ? regionMarkerRegex.exec(comment.value.trim()) : null;
  if (!match) {
    return undefined;
  }
  return { kind: match[1] === 'region' ? 'start' : 'end', label: match[2] ?? '' };
}
