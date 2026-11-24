import { deepStrictEqual, notStrictEqual as ne, ok, strictEqual as eq } from 'assert';
import { OutlineEntry } from '../outline/model';
import { analyzeCode, Analyzed, describeSymbol, getTestFileContents, referenceAtPos, symbolAt, TEST_CARTS } from './test-utils';

const lines = (...l: string[]) => l.join('\n');

// Positions are line (from 1) and column (from 0) in the main file. Every name the tests compare has a symbol,
// so that two missing ones never count as the same.
function probe(a: Analyzed) {
  return {
    at: (line: number, column: number) => {
      const symbol = symbolAt(a, line, column);
      ok(symbol, `no symbol at ${line}:${column}`);
      return symbol;
    },
    kind: (line: number, column: number) => describeSymbol(symbolAt(a, line, column)),
  };
}

describe('binder', () => {
  it('reads the outer x in local x = x', () => {
    const { at, kind } = probe(analyzeCode(lines('local x = 1', 'function f()', '  local x = x', 'end')));
    eq(kind(3, 12), 'local x');
    eq(at(3, 12), at(1, 6));
  });

  it('sees a local function in its own body, but not a local in its own initializer', () => {
    const { at, kind } = probe(analyzeCode(lines('function f()', '  local function fact(n) return n * fact(n - 1) end',
      '  local g = function(n) return g(n) end', 'end')));
    eq(at(2, 36), at(2, 17));
    eq(kind(3, 31), 'global g');
  });

  it('keeps a parameter and a local of the same name apart', () => {
    const { at, kind } = probe(analyzeCode(lines('function f(x)', '  local x = x + 1', '  return x', 'end')));
    eq(kind(2, 12), 'param x');
    eq(kind(3, 9), 'local x');
    ne(at(2, 12), at(3, 9));
  });

  it('keeps a top-level local apart from the global of the same name', () => {
    const { at, kind } = probe(analyzeCode(lines('x = 1', 'local x = 5', 'print(x)')));
    eq(kind(3, 6), 'local x');
    eq(kind(1, 0), 'global x');
    ne(at(3, 6), at(1, 0));
  });

  it('scopes loop variables to the loop body', () => {
    eq(probe(analyzeCode(lines('function f()', '  for i = 1, 3 do end', '  print(i)', 'end'))).kind(3, 8), 'global i');
    const generic = probe(analyzeCode('for t in all(t) do\n  print(t)\nend'));
    eq(generic.kind(1, 13), 'global t');
    eq(generic.kind(2, 8), 'loopvar t');
    eq(probe(analyzeCode('for i = 1, i do end')).kind(1, 11), 'global i');
  });

  it('lets until see the locals of the repeat body', () => {
    const { at } = probe(analyzeCode('repeat local done = true until done'));
    eq(at(1, 31), at(1, 13));
  });

  it('resolves goto to a label of its own function', () => {
    const { at, kind } = probe(analyzeCode(lines('function a()', '  goto done', '  ::done::', 'end',
      'function b()', '  goto done', '  ::done::', 'end', 'done = true', 'print(done)')));
    eq(kind(2, 7), 'label done');
    eq(at(2, 7), at(3, 4));
    ne(at(2, 7), at(7, 4));
    eq(kind(10, 6), 'global done');
  });

  it('resolves a goto to a label written after it', () => {
    const { at } = probe(analyzeCode(lines('function f()', '  goto later', '  ::later::', 'end')));
    eq(at(2, 7), at(3, 4));
  });

  it('resolves goto continue to the label of its own loop', () => {
    const { at } = probe(analyzeCode(lines('for i = 1, 3 do', '  for j = 1, 3 do', '    if j == 2 then goto continue end',
      '    ::continue::', '  end', '  if i == 2 then goto continue end', '  ::continue::', 'end')));
    eq(at(3, 24), at(4, 6));
    eq(at(6, 22), at(7, 4));
    ne(at(3, 24), at(7, 4));
  });

  it('resolves self in the four method forms', () => {
    const { at, kind } = probe(analyzeCode(lines('a = {}', 'function a:m1() self.f1 = 1 end', 'function a.m2(self) self.f2 = 2 end',
      'a.m3 = function(self) self.f3 = 3 end', 'b = { m4 = function(self) self.f4 = 4 end }', 'print(a.f1, a.f2, a.f3, b.f4)')));
    eq(at(2, 21), at(6, 8));
    eq(at(3, 25), at(6, 14));
    eq(at(4, 27), at(6, 20));
    eq(at(5, 31), at(6, 26));
    eq(kind(2, 16), 'self self');
  });

  it('resolves self in a callback inside a method', () => {
    const { at } = probe(analyzeCode(lines('player = {}', 'function player:update()', '  foreach(enemies, function(e)',
      '    self.hits += 1', '  end)', 'end', 'print(player.hits)')));
    eq(at(4, 9), at(7, 13));
  });

  it('lets a callback\'s own self parameter hide the method\'s self', () => {
    const { at } = probe(analyzeCode(lines('player = {}', 'function player:update()',
      '  foreach(es, function(self) self.x = 1 end)', 'end', 'print(player.x)')));
    ne(at(3, 35), at(5, 13));
  });

  it('treats self in a function of an unnamed table as its parameter', () => {
    const { at, kind } = probe(analyzeCode(lines('function spawn()', '  add(enemies, {', '    hp = 3,',
      '    update = function(self) self.hp -= 1 end,', '  })', 'end')));
    eq(kind(4, 28), 'self self');
    eq(at(4, 28), at(4, 22));
  });

  it('keeps self.k apart in functions that are not methods', () => {
    const { at, kind } = probe(analyzeCode(lines('function f() self.x = 1 end', 'function g() print(self.x) end')));
    eq(kind(1, 13), 'self self');
    ne(at(1, 18), at(2, 24));
  });

  it('keeps self.k of two functions apart wherever top-level code uses self', () => {
    const first = probe(analyzeCode(lines('print(self)', 'function f() self.x = 1 end', 'function g() print(self.x) end')));
    eq(first.kind(1, 6), 'global self');
    ne(first.at(2, 18), first.at(3, 24));
    const last = probe(analyzeCode(lines('function f() self.x = 1 end', 'function g() print(self.x) end', 'print(self)')));
    ne(last.at(1, 18), last.at(2, 24));
  });

  it('gives a callback in a function that is not a method its own self, whichever uses self first', () => {
    const outerFirst = probe(analyzeCode(lines('function f()', '  self.y = 2', '  foreach(t, function(e) self.x = 1 end)', 'end')));
    ne(outerFirst.at(2, 2), outerFirst.at(3, 25));
    const callbackFirst = probe(analyzeCode(lines('function f()', '  foreach(t, function(e) self.x = 1 end)', '  self.y = 2', 'end')));
    ne(callbackFirst.at(2, 25), callbackFirst.at(3, 2));
  });

  it('connects constructor keys with field uses', () => {
    const { at } = probe(analyzeCode(lines('player = { x = 64, y = 64 }', 'function _draw()', '  spr(1, player.x, player.y)', 'end')));
    eq(at(1, 11), at(3, 16));
  });

  it('records a field read that is a whole right-hand side', () => {
    const { at, kind } = probe(analyzeCode(lines('player = { hp = 3 }', 'x = player.hp', 'local y = player.hp')));
    eq(at(2, 11), at(1, 11));
    eq(at(3, 17), at(1, 11));
    eq(kind(2, 4), 'global player');
  });

  it('keeps members of different tables apart and marks method calls', () => {
    const a = analyzeCode(lines('a = {}', 'b = {}', 'function a:update() end', 'function b:update() end', 'a:update()', 'print(a.update)'));
    const { at } = probe(a);
    eq(at(5, 2), at(3, 11));
    ne(at(5, 2), at(4, 11));
    eq(referenceAtPos(a, 5, 2)!.isCall, true);
    eq(referenceAtPos(a, 6, 8)!.isCall, false);
  });

  it('gives the key of a call on an unnamed table a symbol', () => {
    const a = analyzeCode(lines('enemies[1]:update()', 'get_player():hit()'));
    const { kind } = probe(a);
    eq(kind(1, 11), 'member update');
    eq(referenceAtPos(a, 1, 11)!.isCall, true);
    eq(kind(2, 13), 'member hit');
  });

  it('gives the keys of a table that no name holds a symbol', () => {
    const a = analyzeCode('add(enemies, { update = function(self) end })');
    const update = probe(a).at(1, 15);
    eq(describeSymbol(update), 'member update');
    ok(update.definitions.some(definition => definition.isFunction));
    ok(a.analysis.membersByKey.get('update')!.includes(update));
  });

  it('marks compound assignment targets as read and written', () => {
    const a = analyzeCode(lines('score = 0', 'score += 1', 'player = {}', 'player.hp = 1', 'player.hp -= 1', 't = {}', 'local i = 1', 't[i] = 2'));
    const access = (line: number, column: number) => {
      const { read, write } = referenceAtPos(a, line, column)!;
      return { read, write };
    };
    deepStrictEqual(access(2, 0), { read: true, write: true });
    deepStrictEqual(access(5, 7), { read: true, write: true });
    deepStrictEqual(access(8, 0), { read: true, write: false });
    eq(probe(a).kind(8, 2), 'local i');
  });

  it('sees a top-level local of an included file after the #include', () => {
    const a = analyzeCode('#include lib.lua\nprint(a)', { 'lib.lua': 'local a = 5' });
    eq(probe(a).at(2, 6), symbolAt(a, 1, 6, 'lib.lua'));
  });

  it('lets an #include inside a function see the function\'s locals', () => {
    const a = analyzeCode(lines('function _init()', '  local speed = 1', '  #include lib.lua', 'end'), { 'lib.lua': 'print(speed)' });
    eq(symbolAt(a, 1, 6, 'lib.lua'), probe(a).at(2, 8));
  });

  it('hides a local declared after the #include from the included file', () => {
    const a = analyzeCode(lines('local speed = 2', '#include lib.lua', 'local gravity = 1'),
      { 'lib.lua': lines('function move(p)', '  p.x += speed', '  p.y += gravity', 'end') });
    eq(describeSymbol(symbolAt(a, 2, 9, 'lib.lua')), 'local speed');
    eq(describeSymbol(symbolAt(a, 3, 9, 'lib.lua')), 'global gravity');
  });

  it('leaves no loop variable behind after a broken for', () => {
    eq(probe(analyzeCode(lines('function f()', '  for i=1,10 x', '  i = 5', 'end'))).kind(3, 2), 'global i');
  });

  it('assigns the global after an #include whose file leaves a block open', () => {
    const a = analyzeCode(lines('function _init()', '  x = 0', 'end', '#include inc.lua', 'a = 5', 'function _update()', '  x += 1', 'end'),
      { 'inc.lua': 'function typing()\n  local a = 1' });
    eq(probe(a).kind(5, 0), 'global a');
  });

  it('copes with names that JavaScript objects have', () => {
    const { at, kind } = probe(analyzeCode('local o = constructor()\nfunction constructor() return {} end\nprint(toString)'));
    eq(kind(1, 10), 'global constructor');
    eq(at(1, 10), at(2, 9));
    eq(kind(3, 6), 'global toString');
  });
});

describe('binder on the test carts', () => {
  for (const name of TEST_CARTS) {
    it(`keeps the analysis of ${name} consistent`, () => {
      const { analysis } = analyzeCode(getTestFileContents(name));
      const entries: OutlineEntry[] = [];
      const collect = (list: OutlineEntry[]) => list.forEach(entry => {
        entries.push(entry);
        collect(entry.children);
      });
      collect(analysis.outline);
      const symbols = new Set([ ...analysis.referencesByFile.values() ].flatMap(references => references.map(reference => reference.symbol)));
      for (const entry of entries) {
        ok(!entry.symbol || entry.symbol.entries.includes(entry), `${entry.name} is not among the entries of its symbol`);
        if (entry.symbol) {
          symbols.add(entry.symbol);
        }
      }
      for (const symbol of symbols) {
        ok(symbol.entries.every(entry => entry.symbol === symbol), `an entry of ${symbol.name} lists another symbol`);
        ok(symbol.entries.length === 0 || !symbol.definitions.some(definition => definition.isFunction) || symbol.signature !== undefined,
          `${symbol.name} has a function definition and entries, but no signature`);
      }
      for (const member of [ ...analysis.membersByKey.values() ].flat()) {
        ok(member.references.length > 0, `member ${member.name} has no reference`);
      }
    });
  }
});
