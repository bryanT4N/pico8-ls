import { deepStrictEqual, strictEqual } from 'assert';
import { CompletionItem, CompletionItemKind } from 'vscode-languageserver/node';
import { completionItems, completionRequestAt } from '../completion';
import { analyzeCode, indexAt, testFile } from '../parser/test/test-utils';

const lines = (...l: string[]) => l.join('\n');

function itemsAt(code: string, line: number, column: number, files?: Record<string, string>, filename?: string): CompletionItem[] {
  const a = analyzeCode(code, files);
  const text = filename ? files![filename] : code;
  const request = completionRequestAt(text.split('\n')[line - 1], column);
  return completionItems([ a.analysis ], testFile(filename), indexAt(a, line, column, filename), request, line - 1, column);
}
// The names a test cares about: everything but the built-in ones, sorted.
const names = (items: CompletionItem[]) => items.filter(i => !i.sortText!.startsWith('2')).map(i => i.label).sort();

function about(items: CompletionItem[], label: string) {
  const item = items.find(i => i.label === label);
  return item && { kind: item.kind, detail: item.detail, sortText: item.sortText };
}

describe('completionRequestAt', () => {
  it('reads a plain name', () => {
    deepStrictEqual(completionRequestAt('  pl', 4), { path: [], colon: false, start: 2 });
  });

  it('reads a path after a dot', () => {
    deepStrictEqual(completionRequestAt('  player.', 9), { path: [ 'player' ], colon: false, start: 9 });
    deepStrictEqual(completionRequestAt('  player.h', 10), { path: [ 'player' ], colon: false, start: 9 });
  });

  it('reads a colon', () => {
    deepStrictEqual(completionRequestAt('  self:', 7), { path: [ 'self' ], colon: true, start: 7 });
  });

  it('reads a longer path', () => {
    deepStrictEqual(completionRequestAt('x = cfg.pos.x', 13), { path: [ 'cfg', 'pos' ], colon: false, start: 12 });
  });

  it('gives up after something that is not a name', () => {
    const requests = [
      completionRequestAt('get().', 6),
      completionRequestAt('t[1].x', 6),
      completionRequestAt('x = 1.', 6),
      completionRequestAt('a:b.', 4),
    ];
    deepStrictEqual(requests.map(request => request.path), [ null, null, null, null ]);
  });

  it('ignores the end of a CRLF line', () => {
    deepStrictEqual(completionRequestAt('  player.\r', 9), { path: [ 'player' ], colon: false, start: 9 });
  });
});

describe('completionItems', () => {
  it('offers only the locals declared above the cursor', () => {
    const code = lines('function a()', '  local early = 1', '  ', '  local late = 2', '  local function inner() end', 'end',
      'function b()', '  ', 'end', 'local top = 1', '');
    deepStrictEqual(names(itemsAt(code, 3, 2)), [ 'a', 'b', 'early' ]);
    deepStrictEqual(names(itemsAt(code, 8, 2)), [ 'a', 'b' ]);
    deepStrictEqual(names(itemsAt(code, 11, 0)), [ 'a', 'b', 'top' ]);
  });

  it('offers neither a later top-level local nor dotted names', () => {
    const code = lines('function _update()', '  p', 'end', 'player = { x = 1 }', 'player.hp = 3', 'local pal_index = 1');
    deepStrictEqual(names(itemsAt(code, 2, 3)), [ '_update', 'player' ]);
  });

  it('offers the fields and methods of a table on a line being typed', () => {
    const code = lines('player = { x = 64, y = 64 }', 'player.hp = 3', 'function player:update()', '  self.', 'end',
      'function _draw()', '  player.', 'end');
    deepStrictEqual(names(itemsAt(code, 4, 7)), [ 'hp', 'update', 'x', 'y' ]);
    deepStrictEqual(names(itemsAt(code, 7, 9)), [ 'hp', 'update', 'x', 'y' ]);
    deepStrictEqual(names(itemsAt(code, 4, 2)), [ '_draw', 'player', 'self' ]);
  });

  it('offers only methods after a colon', () => {
    const code = (typed: string) => lines('player = {}', 'function player:update() end', 'function player.draw() end',
      'player.speed = 2', 'function _draw()', typed, 'end');
    deepStrictEqual(names(itemsAt(code('  player:'), 6, 9)), [ 'draw', 'update' ]);
    deepStrictEqual(names(itemsAt(code('  player.'), 6, 9)), [ 'draw', 'speed', 'update' ]);
  });

  it('follows a path', () => {
    const code = lines('cfg = { pos = { x = 1, y = 2 } }', 'function f()', '  cfg.pos.', 'end');
    deepStrictEqual(names(itemsAt(code, 3, 10)), [ 'x', 'y' ]);
  });

  it('offers the fields used through a parameter', () => {
    const code = (typed: string) => lines('function f(p)', '  p:update()', '  p.x = 1', typed, 'end');
    deepStrictEqual(names(itemsAt(code('  p:'), 4, 4)), [ 'update' ]);
    deepStrictEqual(names(itemsAt(code('  p.'), 4, 4)), [ 'x' ]);
  });

  it('offers parameters and loop variables, and a shadowed name once', () => {
    const loop = lines('function f(x, y)', '  for i = 1, 3 do', '    local z = 1', '    ', '  end', '  ', 'end');
    deepStrictEqual(names(itemsAt(loop, 4, 4)), [ 'f', 'i', 'x', 'y', 'z' ]);
    deepStrictEqual(names(itemsAt(loop, 6, 2)), [ 'f', 'x', 'y' ]);
    const shadowed = itemsAt(lines('local x = 1', 'function f()', '  local x = "inner"', '  ', 'end'), 4, 2);
    deepStrictEqual(names(shadowed), [ 'f', 'x' ]);
    strictEqual(about(shadowed, 'x')?.sortText, '0x');
  });

  it('respects the order of #include', () => {
    const main = lines('local speed = 2', '#include lib.lua', 'local gravity = 1');
    const lib = { 'lib.lua': lines('function move(p)', '  p.x += speed', '  p.y += gravity', 'end') };
    deepStrictEqual(names(itemsAt(main, 2, 9, lib, 'lib.lua')), [ 'move', 'p', 'speed' ]);
    deepStrictEqual(names(itemsAt(main, 4, 3, lib, 'lib.lua')), [ 'move', 'p', 'speed' ]);
    const includer = lines('#include lib.lua', 'function _update()', '  ', 'end');
    const included = { 'lib.lua': lines('local cfg = { speed = 1 }', 'function helper() end') };
    deepStrictEqual(names(itemsAt(includer, 3, 2, included)), [ '_update', 'cfg', 'helper' ]);
  });

  it('sees the locals of the function an #include sits in', () => {
    const main = lines('function _init()', '  local speed = 1', '  #include lib.lua', 'end');
    const lib = { 'lib.lua': lines('local gravity = 2', 'function move()', '  ', 'end') };
    deepStrictEqual(names(itemsAt(main, 3, 2, lib, 'lib.lua')), [ '_init', 'gravity', 'move', 'speed' ]);
  });

  it('does not offer a global that is only compound-assigned', () => {
    const code = lines('function _update() score += 1 end', 'function _draw()', '  ', 'end');
    deepStrictEqual(names(itemsAt(code, 3, 2)), [ '_draw', '_update' ]);
  });

  it('gives kinds, signatures and sort order', () => {
    const code = (typed: string) => lines('function f(a)', '  local function g() end', '  local v = 1', typed, 'end',
      'player = { x = 1, hop = function() end }');
    const plain = itemsAt(code('  '), 4, 2);
    deepStrictEqual(about(plain, 'a'), { kind: CompletionItemKind.Variable, detail: undefined, sortText: '0a' });
    deepStrictEqual(about(plain, 'g'), { kind: CompletionItemKind.Function, detail: '()', sortText: '0g' });
    deepStrictEqual(about(plain, 'f'), { kind: CompletionItemKind.Function, detail: '(a)', sortText: '1f' });
    deepStrictEqual(about(plain, 'player'), { kind: CompletionItemKind.Variable, detail: undefined, sortText: '1player' });
    deepStrictEqual(about(plain, 'print'), { kind: CompletionItemKind.Function, detail: undefined, sortText: '2print' });
    strictEqual(about(plain, '█')?.kind, CompletionItemKind.Constant);

    const dotted = itemsAt(code('  player.'), 4, 9);
    deepStrictEqual(about(dotted, 'x'), { kind: CompletionItemKind.Field, detail: undefined, sortText: '1x' });
    deepStrictEqual(about(dotted, 'hop'), { kind: CompletionItemKind.Method, detail: '()', sortText: '1hop' });
    deepStrictEqual(dotted.map(i => i.label).sort(), [ 'hop', 'x' ]);
  });

  it('replaces only the word being typed', () => {
    const items = itemsAt(lines('player = { hp = 1 }', 'function f()', '  player.h', 'end'), 3, 10);
    deepStrictEqual(items.find(i => i.label === 'hp')?.textEdit,
      { range: { start: { line: 2, character: 9 }, end: { line: 2, character: 10 } }, newText: 'hp' });
  });

  it('sees the parameters of a function in a loop header', () => {
    const code = lines('for e in all(filter(enemies, function(enemy)', '  return ', 'end)) do end');
    deepStrictEqual(names(itemsAt(code, 2, 9)), [ 'enemy' ]);
  });
});
