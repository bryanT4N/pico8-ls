import { deepStrictEqual } from 'assert';
import { NO_OUTLINE_OPTIONS } from '../parser/outline/model';
import { DEFAULT_SETTINGS, settingsFrom } from '../settings';

describe('settingsFrom', () => {
  it('takes the limit and the outline options, and the defaults for what is not given', () => {
    deepStrictEqual(settingsFrom({ maxNumberOfProblems: 7, outline: { showBlocks: true } }, DEFAULT_SETTINGS), {
      settings: { maxNumberOfProblems: 7, outline: { ...NO_OUTLINE_OPTIONS, showBlocks: true } }, outlineChanged: true,
    });
    deepStrictEqual(settingsFrom(null, DEFAULT_SETTINGS), { settings: DEFAULT_SETTINGS, outlineChanged: false });
  });

  it('says the outline changed only when one of its options did', () => {
    const blocks = settingsFrom({ outline: { showBlocks: true } }, DEFAULT_SETTINGS).settings;
    deepStrictEqual([
      settingsFrom({ maxNumberOfProblems: 5, outline: { showBlocks: true } }, blocks).outlineChanged,
      settingsFrom({ outline: { showBlocks: true, showParameters: true } }, blocks).outlineChanged,
      settingsFrom(undefined, blocks).outlineChanged,
    ], [ false, true, true ]);
  });
});
