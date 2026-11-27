import { deepStrictEqual, strictEqual } from 'assert';
import { CompletionItem, CompletionItemKind } from 'vscode-languageserver/node';
import { completionItems, completionRequestAt, Offered, resolveUserItem, wordAt } from '../completion';
import { analyzeCode, indexAt, testFile } from '../parser/test/test-utils';

const lines = (...l: string[]) => l.join('\n');

function itemsAt(code: string, line: number, column: number, files?: Record<string, string>, filename?: string): CompletionItem[] {
  const a = analyzeCode(code, files);
  const text = filename ? files![filename] : code;
  const request = completionRequestAt(text.split('\n')[line - 1], column);
  return completionItems([ a.analysis ], testFile(filename), indexAt(a, line, column, filename), request, line - 1, column);
}
// sortText 2 marks the built-in names.
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

  it('reads a name after .. as a plain name', () => {
    deepStrictEqual(completionRequestAt('  print("hp: "..pl', 18), { path: [], colon: false, start: 16 });
  });

  it('reads a path after ..', () => {
    deepStrictEqual(completionRequestAt('  print("hp: "..player.', 23), { path: [ 'player' ], colon: false, start: 23 });
  });
});

describe('wordAt', () => {
  it('extracts the word at a position', () => {
    strictEqual(wordAt('  print(x)', 4), 'print');
    strictEqual(wordAt('x = foo', 6), 'foo');
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

  it('offers a local only after its statement', () => {
    const code = lines('local a = pl', '');
    deepStrictEqual(names(itemsAt(code, 1, 12)), []);
    deepStrictEqual(names(itemsAt(code, 2, 0)), [ 'a' ]);
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

  it('ends code that runs into an included file at the #include line, and code that an included file leaves open at the end of that file', () => {
    const closed = { 'a.lua': 'end\n' };
    deepStrictEqual(names(itemsAt(lines('function f()', '  local q = 1', '#include a.lua', '', 'function g() end'), 4, 0, closed)), [ 'f', 'g' ]);
    deepStrictEqual(names(itemsAt(lines('local x =', '#include val.lua', ''), 3, 0, { 'val.lua': '42' })), [ 'x' ]);
    const opened = { 'a.lua': lines('function f()', '  local q = 1', '  ', '') };
    deepStrictEqual(names(itemsAt(lines('#include a.lua', 'end'), 3, 2, opened, 'a.lua')), [ 'f', 'q' ]);
  });

  it('offers in a file read in the middle of a statement what the same code offers with its #include as a statement', () => {
    const body = { 'val.lua': lines('function(p)', '  local q = 1', '  ', 'end') };
    const statement = { 'val.lua': lines('x = function(p)', '  local q = 1', '  ', 'end') };
    deepStrictEqual([ names(itemsAt(lines('function f()', '  local a = 1', '  x =', '#include val.lua', 'end'), 3, 2, body, 'val.lua')),
      names(itemsAt(lines('function f()', '  local a = 1', '#include val.lua', 'end'), 3, 2, statement, 'val.lua')) ],
    [[ 'a', 'f', 'p', 'q', 'x' ], [ 'a', 'f', 'p', 'q', 'x' ]]);
    const value = { 'h.lua': lines('function()', '  ', '  return speed', 'end') };
    deepStrictEqual([ names(itemsAt(lines('local speed = 2', 'h =', '#include h.lua'), 2, 2, value, 'h.lua')),
      names(itemsAt(lines('local speed = 2', '#include h.lua'), 2, 2, { 'h.lua': lines('h = function()', '  ', '  return speed', 'end') }, 'h.lua')) ],
    [[ 'h', 'speed' ], [ 'h', 'speed' ]]);
    const taken = { 'a.lua': lines('(f)()', 'local z = 2', '', '') };
    deepStrictEqual([ names(itemsAt(lines('function g()', '  local k = 1', '  x = y', '#include a.lua', 'end'), 3, 0, taken, 'a.lua')),
      names(itemsAt(lines('function g()', '  local k = 1', '  x = y', '#include a.lua', 'end'), 3, 0, { 'a.lua': lines('f()', 'local z = 2', '', '') }, 'a.lua')) ],
    [[ 'g', 'k', 'x', 'z' ], [ 'g', 'k', 'x', 'z' ]]);
  });

  it('offers in a pasted file its own locals whatever block holds them, one whose header starts in the cart too', () => {
    const rows: [string, Record<string, string>, number, number, string, string[]][] = [
      [ lines('local a = 1', '#include s.lua', 'print(a)'), { 's.lua': lines('local b = 2', 'function g()', '  ', 'end') }, 3, 2, 's.lua', [ 'a', 'b', 'g' ]],
      [ lines('function f()', '  local a = 1', '#include s.lua', 'end'), { 's.lua': lines('local b = 2', 'function g()', '  ', 'end') }, 3, 2, 's.lua', [ 'a', 'b', 'f', 'g' ]],
      [ lines('#include s.lua', '#include s.lua', 'x=1'), { 's.lua': lines('local b = 2', 'function g()', '  ', 'end') }, 3, 2, 's.lua', [ 'b', 'g', 'x' ]],
      [ lines('if a then', '#include s.lua', 'else', '#include t.lua', 'end'), { 's.lua': lines('local b = 2', 'function g()', '  ', 'end'), 't.lua': lines('local c = 3', '') }, 2, 0, 't.lua', [ 'c', 'g' ]],
      [ lines('#include s.lua', 'end', 'f()'), { 's.lua': lines('function f()', '  local q = 1', '  ', '') }, 3, 2, 's.lua', [ 'f', 'q' ]],
      [ lines('function f()', '  local a = 1', '  x =', '#include v.lua', '#include v.lua', 'end'), { 'v.lua': lines('function(p)', '  local q = 1', '  ', 'end') }, 3, 2, 'v.lua', [ 'a', 'f', 'p', 'q', 'x' ]],
      [ lines('function f()', '  local a = 1', '#include w.lua', '  x =', '#include w.lua', 'end'), { 'w.lua': lines('function(p)', '  local q = 1', '  ', 'end') }, 3, 2, 'w.lua', [ 'a', 'f', 'q', 'x' ]],
      [ lines('function f(', '#include p.lua', ''), { 'p.lua': lines('a, b)', '  local q = 1', '  ', 'end') }, 3, 2, 'p.lua', [ 'a', 'b', 'f', 'q' ]],
      [ lines('local k = 1', 't = {', '#include t.lua', '}'), { 't.lua': lines('a = 1,', 'b = function()', '  ', 'end,') }, 3, 2, 't.lua', [ 'k', 't' ]],
      [ lines('local k = 1', 'if', '#include c.lua', ''), { 'c.lua': lines('k then', '  local q = 1', '  ', 'end') }, 3, 2, 'c.lua', [ 'k', 'q' ]],
      [ lines('local k = 1', 'for i =', '#include r.lua', ''), { 'r.lua': lines('1, k do', '  local q = 1', '  ', 'end') }, 3, 2, 'r.lua', [ 'i', 'k', 'q' ]],
      [ lines('local speed = 2', 'function f()', '  local a = 1', '  x = 1 +', '#include v.lua'), { 'v.lua': lines('2', '  local q = 1', '  ', 'end') }, 3, 2, 'v.lua', [ 'a', 'f', 'q', 'speed', 'x' ]],
      [ lines('local speed = 2', 'function f()', '  local a = 1', '#include v.lua'), { 'v.lua': lines('x = 1 + 2', '  local q = 1', '  ', 'end') }, 3, 2, 'v.lua', [ 'a', 'f', 'q', 'speed', 'x' ]],
      [ lines('local k = 1', 'while', '#include w.lua', ''), { 'w.lua': lines('k do', '  local q = 1', '  ', 'end') }, 3, 2, 'w.lua', [ 'k', 'q' ]],
    ];
    for (const [ code, files, line, column, file, offered ] of rows) {
      deepStrictEqual(names(itemsAt(code, line, column, files, file)), offered, code);
    }
  });

  it('offers in a block that runs from one file into another its locals and its own, in every file, whichever file it starts in', () => {
    const rows: [string, Record<string, string>, number, number, string | undefined, string[]][] = [
      [ lines('local k = 1', '#include a.lua', '  local q = 1', '  ', 'end'), { 'a.lua': lines('for i = 1, k do', '') }, 4, 2, undefined, [ 'i', 'k', 'q' ]],
      [ lines('local k = 1', '#include a.lua', '  local q = 1', '  ', 'end'), { 'a.lua': lines('while k do', '') }, 4, 2, undefined, [ 'k', 'q' ]],
      [ lines('local k = 1', '#include a.lua', '  local q = 1', '  ', 'end'), { 'a.lua': lines('if k then', '') }, 4, 2, undefined, [ 'k', 'q' ]],
      [ lines('local k = 1', '#include a.lua', '  local q = 1', '  ', 'end'), { 'a.lua': lines('function f(p)', '') }, 4, 2, undefined, [ 'f', 'k', 'p', 'q' ]],
      [ lines('local k = 1', '#include a.lua', '  local q = 1', '  ', 'end'), { 'a.lua': lines('do', '') }, 4, 2, undefined, [ 'k', 'q' ]],
      [ lines('local k = 1', '#include a.lua', '  local q = 1', '  ', 'end'), { 'a.lua': lines('for i = 1, k do', '  local z = 1', '') }, 4, 2, undefined, [ 'i', 'k', 'q', 'z' ]],
      [ lines('local k = 1', '#include a.lua', '  local q = 1', '  ', 'end'), { 'a.lua': lines('function f(p)', '  local z = 1', '') }, 4, 2, undefined, [ 'f', 'k', 'p', 'q', 'z' ]],
      [ lines('local k = 1', '#include a.lua', '  local q = 1', 'end', ''), { 'a.lua': lines('for i = 1, k do', '') }, 5, 0, undefined, [ 'k' ]],
      [ lines('local k = 1', 'for i =', '#include r.lua', ''), { 'r.lua': lines('1, k do', '  local q = 1', 'end') }, 4, 0, undefined, [ 'k' ]],
      [ lines('local k = 1', 'if a then', 'elseif', '#include c.lua', ''), { 'c.lua': lines('k then', '  local q = 1', '  ', 'end') }, 3, 2, 'c.lua', [ 'k', 'q' ]],
      [ lines('local k = 1', 'for i = 1, 2 do', ' for j =', '#include r.lua', ''), { 'r.lua': lines('1, k do', '  local q = 1', '  ', 'end', 'end') }, 3, 2, 'r.lua', [ 'i', 'j', 'k', 'q' ]],
      [ lines('local k = 1', 'for i =', '#include r.lua', 'for j =', '#include r.lua', ''), { 'r.lua': lines('1, k do', '  local q = 1', '  ', 'end') }, 3, 2, 'r.lua', [ 'i', 'k', 'q' ]],
      [ lines('local k = 1', 'while', '#include w.lua', ''), { 'w.lua': lines('k do', '  local q = 1', 'end', 'local after = 1', '  ') }, 5, 2, 'w.lua', [ 'after', 'k' ]],
      [ lines('local k = 1', 'for i, v in', '#include r.lua', ''), { 'r.lua': lines('pairs(k) do', '  local q = 1', '  ', 'end') }, 3, 2, 'r.lua', [ 'i', 'k', 'q', 'v' ]],
      [ lines('local k = 1', 'for i =', '#include r.lua', '  local w = 2', '  ', 'end'), { 'r.lua': lines('1, k do', '  local q = 1', '') }, 5, 2, undefined, [ 'i', 'k', 'q', 'w' ]],
      [ lines('local k = 1', '#include a.lua', '  local q = 1', '  ', 'end'), { 'a.lua': lines('do', '  local z = 1', '') }, 4, 2, undefined, [ 'k', 'q', 'z' ]],
      [ lines('local k = 1', '#include a.lua', '  local q = 1', '  ', 'end'), { 'a.lua': lines('while k do', '  local z = 1', '') }, 4, 2, undefined, [ 'k', 'q', 'z' ]],
      [ lines('local k = 1', '#include a.lua', '  local q = 1', '  ', 'end'), { 'a.lua': lines('if k then', '  local z = 1', '') }, 4, 2, undefined, [ 'k', 'q', 'z' ]],
      [ lines('local k = 1', 'do', '#include a.lua', ''), { 'a.lua': lines('  local q = 1', '  ', 'end') }, 2, 2, 'a.lua', [ 'k', 'q' ]],
      [ lines('local k = 1', 'function f(p)', '#include a.lua', ''), { 'a.lua': lines('  local q = 1', '  ', 'end') }, 2, 2, 'a.lua', [ 'f', 'k', 'p', 'q' ]],
      [ lines('local k = 1', '#include a.lua', '  local q = 1', 'end'), { 'a.lua': lines('for i = 1, k do', '  local z = 1', '  ') }, 3, 2, 'a.lua', [ 'i', 'k', 'z' ]],
      [ lines('local k = 1', 'for i =', '#include r.lua', '  local w = 2', 'end'), { 'r.lua': lines('1, k do', '  local q = 1', '  ') }, 3, 2, 'r.lua', [ 'i', 'k', 'q' ]],
    ];
    for (const [ code, files, line, column, file, offered ] of rows) {
      deepStrictEqual(names(itemsAt(code, line, column, files, file)), offered, `${code} ${JSON.stringify(files)}`);
    }
  });

  it('offers in an included file the blocks around the place as the file is pasted in: not one the file closes above it, and one it opens after that', () => {
    const rows: [string, Record<string, string>, number, number, string | undefined, string[]][] = [
      [ lines('local k = 1', 'do', '#include a.lua', 'end'), { 'a.lua': lines('local x = 1', 'end', 'do', '  local y = 1', '  ', '') }, 5, 2, 'a.lua', [ 'k', 'y' ]],
      [ lines('local k = 1', 'do', '#include a.lua', '  ', 'end'), { 'a.lua': lines('local x = 1', 'end', 'do', '  local y = 1', '') }, 4, 2, undefined, [ 'k', 'y' ]],
      [ lines('local k = 1', 'do', '#include a.lua', ''), { 'a.lua': lines('local x = 1', 'end', '  ', '') }, 3, 2, 'a.lua', [ 'k' ]],
      [ lines('local k = 1', 'function f(p)', '#include a.lua', ''), { 'a.lua': lines('end', 'local g = 1', '  ', '') }, 3, 2, 'a.lua', [ 'f', 'g', 'k' ]],
      [ lines('local k = 1', 'for i = 1, 2 do', '#include a.lua', ''), { 'a.lua': lines('  local z = 1', 'end', '  ', '') }, 3, 2, 'a.lua', [ 'k' ]],
    ];
    for (const [ code, files, line, column, file, offered ] of rows) {
      deepStrictEqual(names(itemsAt(code, line, column, files, file)), offered, `${code} ${JSON.stringify(files)}`);
    }
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

  it('offers plain names after ..', () => {
    const code = lines('player = {}', 'function f()', '  print("hp: "..pl', 'end');
    deepStrictEqual(names(itemsAt(code, 3, 18)), [ 'f', 'player' ]);
  });

  it('offers the locals of an #included file from where the #include is', () => {
    const lib = { 'lib.lua': 'local gravity = 1' };
    deepStrictEqual(names(itemsAt(lines('#include lib.lua', ''), 2, 0, lib)), [ 'gravity' ]);
    deepStrictEqual(names(itemsAt(lines('local debug = true', '#include lib.lua', ''), 3, 0, lib)), [ 'debug', 'gravity' ]);
    deepStrictEqual(names(itemsAt(lines('', '#include lib.lua', 'print(1)'), 1, 0, lib)), []);
  });

  it('counts a goto where it is, not where its label is found', () => {
    const lib = { 'lib.lua': lines('::top::', 'local inside = 1', 'goto top', '') };
    deepStrictEqual(names(itemsAt(lines('#include lib.lua', 'local later = 1'), 4, 0, lib, 'lib.lua')), [ 'inside' ]);
  });

  it('offers the locals of a function whose end is not written yet', () => {
    const followed = lines('function foo(a, b)', '  local c = 1', '  ', 'function bar() end');
    deepStrictEqual(names(itemsAt(followed, 3, 2)), [ 'a', 'b', 'bar', 'c', 'foo' ]);
    deepStrictEqual(names(itemsAt(lines('function foo(a, b)', '  local c = 1', '  '), 3, 2)), [ 'a', 'b', 'c', 'foo' ]);
  });

  it('offers the locals of a closed function in an if whose end is not written yet', () => {
    deepStrictEqual(names(itemsAt(lines('function f(a)', '  local b = 1', '  if a then', '    ', 'end'), 4, 4)), [ 'a', 'b', 'f' ]);
  });

  it('does not offer the parameters of a closed function after its end', () => {
    const code = lines('function f(a)', 'end', '', 'function g(b)', '  ');
    deepStrictEqual(names(itemsAt(code, 3, 0)), [ 'f', 'g' ]);
    deepStrictEqual(names(itemsAt(code, 5, 2)), [ 'b', 'f', 'g' ]);
  });

  it('does not offer the member being typed', () => {
    deepStrictEqual(names(itemsAt(lines('function f(p)', '  x = p.h', 'end'), 2, 9)), []);
    deepStrictEqual(names(itemsAt(lines('function f(p)', '  p.hp = 1', '  x = p.h', 'end'), 3, 9)), [ 'hp' ]);
  });

  it('offers members after ..', () => {
    const code = lines('player = { hp = 1 }', 'function f()', '  print("hp: "..player.', 'end');
    deepStrictEqual(names(itemsAt(code, 3, 23)), [ 'hp' ]);
  });

  it('does not offer the next line\'s name, which Lua reads as the member after the dot', () => {
    deepStrictEqual(names(itemsAt(lines('function f(p)', '  p.', '  x = 1', 'end'), 2, 4)), []);
    deepStrictEqual(names(itemsAt(lines('player = { hp = 1 }', 'function f()', '  player.', '  y = 2', 'end'), 3, 9)), [ 'hp' ]);
    const definedAbove = lines('player = { hp = 1 }', 'player.y = 2', 'function f()', '  player.', '  y = 2', 'end');
    deepStrictEqual(names(itemsAt(definedAbove, 4, 9)), [ 'hp', 'y' ]);
    const definedBelow = lines('player = { hp = 1 }', 'function f()', '  player.', 'end', 'function g()', '  player.x = 5', 'end');
    deepStrictEqual(names(itemsAt(definedBelow, 3, 9)), [ 'hp', 'x' ]);
  });

  it('fills in the declaration and the doc when an item is resolved', () => {
    const code = lines('x = 1', '-- creates a deep copy', 'function deep_copy(obj) return obj end', 'function print(s) end', 'de');
    const a = analyzeCode(code);
    const offered: Offered = new Map();
    const items = completionItems([ a.analysis ], testFile(), indexAt(a, 5, 2), completionRequestAt('de', 2), 4, 2, offered);
    const copy = { ...items.find(i => i.label === 'deep_copy')! };
    strictEqual(copy.detail, '(obj)');
    strictEqual(resolveUserItem(copy, offered), true);
    strictEqual(copy.detail, 'function deep_copy(obj)');
    deepStrictEqual(copy.documentation, { kind: 'markdown', value: 'creates a deep copy' });
    const print = { ...items.find(i => i.label === 'print')! };
    strictEqual(resolveUserItem(print, offered), true);
    strictEqual(print.detail, 'function print(s)');
    strictEqual(print.documentation, undefined);
    strictEqual(resolveUserItem({ label: 'cls' }, offered), false);
  });
});
