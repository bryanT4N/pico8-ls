import { Comment_ } from './expressions';

export type RegionMarker = { kind: 'start' | 'end', label: string };

export function isTabMarker(comment: Comment_): boolean {
  return comment.raw === '-->8';
}

const regionMarkerRegex = /^#(region|endregion)(?:\s+(.*))?$/;

// A #region written after code on the same line is a remark about that code, not a marker.
export function regionMarkerOf(comment: Comment_): RegionMarker | undefined {
  const match = comment.startsLine ? regionMarkerRegex.exec(comment.value.trim()) : null;
  if (!match) {
    return undefined;
  }
  return { kind: match[1] === 'region' ? 'start' : 'end', label: match[2] ?? '' };
}
