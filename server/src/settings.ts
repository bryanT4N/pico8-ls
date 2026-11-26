import { maxProblems } from './diagnostics';
import { NO_OUTLINE_OPTIONS, OutlineOptions, outlineOptionsFrom } from './parser/outline/model';

export type DocumentSettings = { maxNumberOfProblems: number, outline: OutlineOptions };

export type PicoSettings = { maxNumberOfProblems?: unknown, outline?: unknown } | null | undefined;

export const DEFAULT_SETTINGS: DocumentSettings = { maxNumberOfProblems: maxProblems(undefined), outline: NO_OUTLINE_OPTIONS };

export function settingsFrom(given: PicoSettings, before: DocumentSettings): { settings: DocumentSettings, outlineChanged: boolean } {
  const outline = outlineOptionsFrom(given?.outline);
  return {
    settings: { maxNumberOfProblems: maxProblems(given?.maxNumberOfProblems), outline },
    outlineChanged: (Object.keys(outline) as Array<keyof OutlineOptions>).some(key => outline[key] !== before.outline[key]),
  };
}
