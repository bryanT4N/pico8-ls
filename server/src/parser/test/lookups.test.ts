import { deepStrictEqual, ok, strictEqual } from 'assert';
import { builtinInfo, Builtins, isBuiltinName } from '../builtins';
import { outlineOf } from './outline-utils';
import { analyzeCode, Analyzed, definitionsAtPos, describeSymbol, referencesAtPos, symbolAt, warningsIn } from './test-utils';

const lines = (...l: string[]) => l.join('\n');

function probe(a: Analyzed) {
  return {
    d: (line: number, column: number) => definitionsAtPos(a, line, column),
    r: (line: number, column: number) => referencesAtPos(a, line, column),
    w: () => warningsIn(a),
  };
}

describe('Go to Definition and Find References', () => {
  it('goes to a function from anywhere on its name', () => {
    const { d } = probe(analyzeCode('function somefn() end'));
    const name = [ 'main_test_file 1:9-1:15' ];
    deepStrictEqual(d(1, 11), name);
    deepStrictEqual(d(1, 9), name);
    deepStrictEqual(d(1, 15), name);
    deepStrictEqual(d(1, 8), []);
    deepStrictEqual(d(1, 16), []);
  });

  it('finds the uses of a function', () => {
    const { r } = probe(analyzeCode('function somefn()\n  somefn()\nend'));
    deepStrictEqual(r(1, 9), [ 'main_test_file 1:9-1:15', 'main_test_file 2:2-2:8' ]);
  });

  it('finds a function used before its definition', () => {
    const { d, r } = probe(analyzeCode('\ndo_the_thing()\nfunction do_the_thing() print(\'hi\') end'));
    deepStrictEqual(d(2, 1), [ 'main_test_file 3:9-3:21' ]);
    deepStrictEqual(r(2, 1), [ 'main_test_file 2:0-2:12', 'main_test_file 3:9-3:21' ]);
  });

  it('goes to a local', () => {
    const { d, r, w } = probe(analyzeCode('local a\nb = a'));
    deepStrictEqual(d(2, 4), [ 'main_test_file 1:6-1:7' ]);
    deepStrictEqual(r(2, 4), [ 'main_test_file 1:6-1:7', 'main_test_file 2:4-2:5' ]);
    deepStrictEqual(w(), []);
  });

  it('goes to a parameter', () => {
    const setv = probe(analyzeCode('function setv(v, x, y)\n  v.x = x\n  v.y = y\nend'));
    deepStrictEqual(setv.d(1, 17), [ 'main_test_file 1:17-1:18' ]);
    deepStrictEqual(setv.r(1, 17), [ 'main_test_file 1:17-1:18', 'main_test_file 2:8-2:9' ]);
    deepStrictEqual(setv.w(), []);
    const round = probe(analyzeCode('function round(x)\n  return flr(x+0.5)\nend'));
    deepStrictEqual(round.r(1, 15), [ 'main_test_file 1:15-1:16', 'main_test_file 2:13-2:14' ]);
    deepStrictEqual(round.w(), []);
  });

  it('goes to a table and to its field', () => {
    const { d, r } = probe(analyzeCode('a = {}\na.b = "1"\nprint(a.b)'));
    const table = [ 'main_test_file 1:0-1:1' ];
    deepStrictEqual(d(1, 1), table);
    deepStrictEqual(d(2, 0), table);
    deepStrictEqual(d(2, 1), table);
    deepStrictEqual(d(3, 6), table);
    deepStrictEqual(d(3, 7), table);
    deepStrictEqual(r(1, 0), [ 'main_test_file 1:0-1:1', 'main_test_file 2:0-2:1', 'main_test_file 3:6-3:7' ]);
    const field = [ 'main_test_file 2:2-2:3' ];
    deepStrictEqual(d(2, 2), field);
    deepStrictEqual(d(2, 3), field);
    deepStrictEqual(d(3, 8), field);
    deepStrictEqual(d(3, 9), field);
    deepStrictEqual(r(2, 2), [ 'main_test_file 2:2-2:3', 'main_test_file 3:8-3:9' ]);
  });

  it('follows a path of fields', () => {
    const { d, r } = probe(analyzeCode('\na = {}\na.b = {}\na.b.c = {}\na.b.c.d = {}'));
    deepStrictEqual(r(2, 0), [ 'main_test_file 2:0-2:1', 'main_test_file 3:0-3:1', 'main_test_file 4:0-4:1', 'main_test_file 5:0-5:1' ]);
    deepStrictEqual(d(3, 2), [ 'main_test_file 3:2-3:3' ]);
    deepStrictEqual(r(3, 2), [ 'main_test_file 3:2-3:3', 'main_test_file 4:2-4:3', 'main_test_file 5:2-5:3' ]);
    deepStrictEqual(r(4, 4), [ 'main_test_file 4:4-4:5', 'main_test_file 5:4-5:5' ]);
    deepStrictEqual(r(5, 6), [ 'main_test_file 5:6-5:7' ]);
  });

  it('goes to the explicit definition of an intermediate member', () => {
    deepStrictEqual(probe(analyzeCode('a = {}\na.b.c = 1\nprint(a.b.c)')).d(3, 8), [ 'main_test_file 2:2-2:3' ]);
    deepStrictEqual(probe(analyzeCode('a = {}\na.b.c = 1\na.b = { d = 2 }\nprint(a.b.c)')).d(4, 8), [ 'main_test_file 3:2-3:3' ]);
  });

  it('goes to a field of a table written as x or {...}', () => {
    deepStrictEqual(probe(analyzeCode('cfg = cfg or { speed = 1 }\nprint(cfg.speed)')).d(2, 10), [ 'main_test_file 1:15-1:20' ]);
  });

  it('links fields through self across the methods of a table', () => {
    const { d, r, w } = probe(analyzeCode(lines('vector={}', 'function vector:deconstruct()', '  return self.x, self.y', 'end', '',
      'function vector:set(x, y)', '  self.x = x', '  self.y = y', 'end')));
    deepStrictEqual(d(3, 15), [ 'main_test_file 7:7-7:8' ]);
    deepStrictEqual(r(3, 15), [ 'main_test_file 3:14-3:15', 'main_test_file 7:7-7:8' ]);
    deepStrictEqual(w(), []);
  });

  it('resolves self in a colon method on a path', () => {
    const { d, r } = probe(analyzeCode('\na = {}\na.b = {}\nfunction a.b:self_fn() self.mem = 0 end\na.b.mem()'));
    deepStrictEqual(d(4, 23), [ 'main_test_file 3:2-3:3' ]);
    deepStrictEqual(r(4, 28), [ 'main_test_file 4:28-4:31', 'main_test_file 5:4-5:7' ]);
  });

  it('finds a local of an included file', () => {
    const { d, r, w } = probe(analyzeCode('#include other_file.lua\nprint(a)', { 'other_file.lua': 'local a = 5' }));
    deepStrictEqual(d(2, 6), [ 'other_file.lua 1:6-1:7' ]);
    deepStrictEqual(r(2, 6), [ 'main_test_file 2:6-2:7', 'other_file.lua 1:6-1:7' ]);
    deepStrictEqual(w(), []);
  });

  it('finds a use in an included file', () => {
    const { r } = probe(analyzeCode('local a = 5\n#include other_file.lua', { 'other_file.lua': 'print(a)' }));
    deepStrictEqual(r(1, 6), [ 'main_test_file 1:6-1:7', 'other_file.lua 1:6-1:7' ]);
  });

  it('looks a position up in its own file (#61)', () => {
    const a = analyzeCode('#include other_file.lua\ninit_tiles()', { 'other_file.lua': 'function init_tiles() end\ngp = 1' });
    strictEqual(describeSymbol(symbolAt(a, 2, 1)), 'global init_tiles');
    strictEqual(describeSymbol(symbolAt(a, 2, 1, 'other_file.lua')), 'global gp');
    strictEqual(describeSymbol(symbolAt(a, 2, 5, 'other_file.lua')), 'none');
  });

  it('finds a global defined in a later #include', () => {
    const a = analyzeCode('#include a.lua\n#include b.lua', { 'a.lua': 'function _init() init_b() end', 'b.lua': 'function init_b() end' });
    deepStrictEqual(definitionsAtPos(a, 1, 17, 'a.lua'), [ 'b.lua 1:9-1:15' ]);
    deepStrictEqual(warningsIn(a), []);
  });

  it('does not warn about a goto to a later label', () => {
    const { d, w } = probe(analyzeCode(lines(
      'function some_fun()',
      '  for i=1,10 do',
      '    for j=1,10 do',
      '      if true then',
      '        goto outside',
      '      end',
      '    end',
      '  end',
      '  ::outside::',
      'end',
    )));
    deepStrictEqual(w(), []);
    deepStrictEqual(d(5, 13), [ 'main_test_file 9:4-9:11' ]);
  });

  it('links fields of a parameter only through that parameter', () => {
    const { d, r, w } = probe(analyzeCode(lines('function deconstruct(v)', '  return v.x, v.y', 'end', '',
      'function setv(v, x, y)', '  v.x = x', '  v.y = y', 'end')));
    deepStrictEqual(d(2, 11), []);
    deepStrictEqual(r(2, 11), [ 'main_test_file 2:11-2:12' ]);
    deepStrictEqual(w(), []);
  });

  it('does not resolve self in a function that is not a method', () => {
    const { d, r, w } = probe(analyzeCode('\na = {}\na.self_fn = function() self.mem = 0 end\na.mem()'));
    deepStrictEqual(d(3, 25), []);
    deepStrictEqual(d(3, 30), [ 'main_test_file 3:28-3:31' ]);
    deepStrictEqual(r(3, 30), [ 'main_test_file 3:28-3:31' ]);
    deepStrictEqual(w(), []);
  });

  it('does not see a local declared after the #include', () => {
    const a = analyzeCode('#include other_file.lua\nlocal a = 5', { 'other_file.lua': '\nfunction doit()\n  print(a)\nend' });
    deepStrictEqual(definitionsAtPos(a, 3, 9, 'other_file.lua'), []);
    deepStrictEqual(warningsIn(a), [ 'other_file.lua 3:8 undefined variable: a' ]);
  });

  it('finds a local function only in its own function', () => {
    const { d, r, w } = probe(analyzeCode(lines('function a()', '  local function helper() return 1 end', '  return helper()', 'end',
      'function b()', '  return helper()', 'end')));
    deepStrictEqual(d(3, 10), [ 'main_test_file 2:17-2:23' ]);
    deepStrictEqual(r(3, 10), [ 'main_test_file 2:17-2:23', 'main_test_file 3:9-3:15' ]);
    deepStrictEqual(d(6, 10), []);
    deepStrictEqual(w(), [ 'main_test_file 6:9 undefined variable: helper' ]);
  });

  it('keeps local functions of the same name apart', () => {
    const { d, r } = probe(analyzeCode(lines('function a()', '  local function step() end', '  step()', 'end',
      'function b()', '  local function step() end', '  step()', 'end')));
    deepStrictEqual(d(3, 3), [ 'main_test_file 2:17-2:21' ]);
    deepStrictEqual(r(3, 3), [ 'main_test_file 2:17-2:21', 'main_test_file 3:2-3:6' ]);
    deepStrictEqual(d(7, 3), [ 'main_test_file 6:17-6:21' ]);
  });

  it('keeps a global function and a field of the same name apart', () => {
    const { d, r } = probe(analyzeCode(lines('function init() end', 'player = {', '  init = function(self) end,', '}',
      'init()', 'player.init()', 'player:init()')));
    deepStrictEqual(d(5, 1), [ 'main_test_file 1:9-1:13' ]);
    deepStrictEqual(r(5, 1), [ 'main_test_file 1:9-1:13', 'main_test_file 5:0-5:4' ]);
    deepStrictEqual(d(6, 8), [ 'main_test_file 3:2-3:6' ]);
    deepStrictEqual(d(7, 8), [ 'main_test_file 3:2-3:6' ]);
    deepStrictEqual(r(6, 8), [ 'main_test_file 3:2-3:6', 'main_test_file 6:7-6:11', 'main_test_file 7:7-7:11' ]);
  });

  it('goes to the method of the called table only', () => {
    const { d, r } = probe(analyzeCode(lines('a = {}', 'b = {}', 'function a:update() end', 'function b:update() end', 'a:update()')));
    deepStrictEqual(d(5, 2), [ 'main_test_file 3:11-3:17' ]);
    deepStrictEqual(r(5, 2), [ 'main_test_file 3:11-3:17', 'main_test_file 5:2-5:8' ]);
  });

  it('goes to the function of the right local table', () => {
    const { d } = probe(analyzeCode(lines('local a = {}', 'function a.f() end', 'local b = {}', 'function b.f() end', 'a.f()', 'function f() end')));
    deepStrictEqual(d(5, 2), [ 'main_test_file 2:11-2:12' ]);
  });

  it('does not fall back to a global with the field\'s name', () => {
    const { d, r } = probe(analyzeCode(lines('x = 0', 'player = { x = 64 }', 'print(player.x)')));
    deepStrictEqual(d(3, 13), [ 'main_test_file 2:11-2:12' ]);
    deepStrictEqual(r(3, 13), [ 'main_test_file 2:11-2:12', 'main_test_file 3:13-3:14' ]);
    deepStrictEqual(r(1, 0), [ 'main_test_file 1:0-1:1' ]);
  });

  it('goes from a field to its constructor key', () => {
    const { d, r } = probe(analyzeCode(lines('player = { x = 64, y = 64 }', 'function _draw()', '  spr(1, player.x, player.y)', 'end')));
    deepStrictEqual(d(3, 16), [ 'main_test_file 1:11-1:12' ]);
    deepStrictEqual(r(1, 11), [ 'main_test_file 1:11-1:12', 'main_test_file 3:16-3:17' ]);
  });

  it('goes to the first definition of a field, not to every write', () => {
    const { d, r } = probe(analyzeCode(lines('player = {}', 'function _init()', '  player.hp = 3', 'end', 'function hit()',
      '  player.hp -= 1', '  player.hp = max(player.hp, 0)', 'end', 'function _draw()', '  print(player.hp)', 'end')));
    deepStrictEqual(d(10, 15), [ 'main_test_file 3:9-3:11' ]);
    deepStrictEqual(r(10, 15), [ 'main_test_file 3:9-3:11', 'main_test_file 6:9-6:11', 'main_test_file 7:9-7:11',
      'main_test_file 7:25-7:27', 'main_test_file 10:15-10:17' ]);
  });

  it('goes to the first assignment of a global', () => {
    const { d, r } = probe(analyzeCode(lines('score = 0', 'function _update()', '  score += 1', '  if btn(4) then score = 0 end', 'end',
      'function _draw()', '  print(score)', 'end')));
    deepStrictEqual(d(7, 8), [ 'main_test_file 1:0-1:5' ]);
    deepStrictEqual(r(7, 8), [ 'main_test_file 1:0-1:5', 'main_test_file 3:2-3:7', 'main_test_file 4:17-4:22', 'main_test_file 7:8-7:13' ]);
  });

  it('finds a field read that is a whole right-hand side', () => {
    const { d, r, w } = probe(analyzeCode(lines('player = { hp = 3 }', 'player.hp = 4', 'x = player.hp', 'local y = player.hp',
      'z = player.hp + 1', 'w = plyer.hp')));
    deepStrictEqual(d(3, 11), [ 'main_test_file 1:11-1:13' ]);
    deepStrictEqual(r(3, 11), [ 'main_test_file 1:11-1:13', 'main_test_file 2:7-2:9', 'main_test_file 3:11-3:13',
      'main_test_file 4:17-4:19', 'main_test_file 5:11-5:13' ]);
    deepStrictEqual(w(), [ 'main_test_file 6:4 undefined variable: plyer' ]);
  });

  it('does not count a read inside a table constructor as a definition', () => {
    const { d, r } = probe(analyzeCode(lines('score = 0', 't = { k = score }', 'print(score)')));
    deepStrictEqual(d(3, 6), [ 'main_test_file 1:0-1:5' ]);
    deepStrictEqual(r(3, 6), [ 'main_test_file 1:0-1:5', 'main_test_file 2:10-2:15', 'main_test_file 3:6-3:11' ]);
  });

  it('follows self into a callback', () => {
    const { d, r } = probe(analyzeCode(lines('player = {}', 'function player:update()', '  foreach(enemies, function(e)',
      '    self.hits += 1', '  end)', 'end', 'print(player.hits)')));
    deepStrictEqual(d(7, 14), [ 'main_test_file 4:9-4:13' ]);
    deepStrictEqual(r(7, 14), [ 'main_test_file 4:9-4:13', 'main_test_file 7:13-7:17' ]);
    deepStrictEqual(d(4, 5), [ 'main_test_file 1:0-1:6' ]);
  });

  it('goes from self to its table', () => {
    const { d } = probe(analyzeCode(lines('a = {}', 'function a:m1() self.f1 = 1 end')));
    deepStrictEqual(d(2, 17), [ 'main_test_file 1:0-1:1' ]);
  });

  it('treats self in a function of an unnamed table as its parameter', () => {
    const { d, r } = probe(analyzeCode(lines('function spawn()', '  add(enemies, {', '    hp = 3,',
      '    update = function(self) self.hp -= 1 end,', '  })', 'end')));
    deepStrictEqual(d(4, 29), [ 'main_test_file 4:22-4:26' ]);
    deepStrictEqual(r(4, 29), [ 'main_test_file 4:22-4:26', 'main_test_file 4:28-4:32' ]);
    deepStrictEqual(d(4, 34), []);
  });

  it('links fields of loop variables and parameters only through the same variable', () => {
    const { d, r } = probe(analyzeCode(lines('function hit(p) p.hp = 0 end', 'function spawn()', '  local e = { hp = 3 }', '  e.x = 1', 'end',
      'function _update()', '  for e in all(es) do e.x -= 1 end', 'end', 'function _draw()', '  for p in all(ps) do print(p.hp) end', 'end')));
    deepStrictEqual(d(7, 24), []);
    deepStrictEqual(r(7, 24), [ 'main_test_file 7:24-7:25' ]);
    deepStrictEqual(d(10, 30), []);
    deepStrictEqual(r(10, 30), [ 'main_test_file 10:30-10:32' ]);
  });

  it('goes to the first plain assignment of a field set through a parameter', () => {
    const { d, r } = probe(analyzeCode(lines('function hit(p)', '  p.hp = 0', '  p.hp -= 1', '  print(p.hp)', 'end')));
    deepStrictEqual(d(4, 10), [ 'main_test_file 2:4-2:6' ]);
    deepStrictEqual(r(4, 10), [ 'main_test_file 2:4-2:6', 'main_test_file 3:4-3:6', 'main_test_file 4:10-4:12' ]);
  });

  it('goes to the function of a forward-declared local', () => {
    const { d, r } = probe(analyzeCode(lines('local update_enemy', 'function _update()', '  update_enemy()', 'end',
      'function update_enemy()', 'end')));
    deepStrictEqual(d(3, 3), [ 'main_test_file 5:9-5:21' ]);
    deepStrictEqual(r(3, 3), [ 'main_test_file 1:6-1:18', 'main_test_file 3:2-3:14', 'main_test_file 5:9-5:21' ]);
  });

  it('goes to the label in the same function', () => {
    const { d, r } = probe(analyzeCode(lines('function a()', '  goto done', '  ::done::', 'end',
      'function b()', '  goto done', '  ::done::', 'end', 'done = true', 'print(done)')));
    deepStrictEqual(d(2, 8), [ 'main_test_file 3:4-3:8' ]);
    deepStrictEqual(r(2, 8), [ 'main_test_file 2:7-2:11', 'main_test_file 3:4-3:8' ]);
    deepStrictEqual(d(10, 6), [ 'main_test_file 9:0-9:4' ]);
    deepStrictEqual(r(10, 6), [ 'main_test_file 9:0-9:4', 'main_test_file 10:6-10:10' ]);
  });

  it('follows Lua\'s shadowing', () => {
    const { d, r } = probe(analyzeCode(lines('x = 1', 'function f(x)', '  local x = x + 1', '  return x', 'end', 'local x = 5', 'print(x)')));
    deepStrictEqual(d(3, 12), [ 'main_test_file 2:11-2:12' ]);
    deepStrictEqual(d(4, 9), [ 'main_test_file 3:8-3:9' ]);
    deepStrictEqual(d(7, 6), [ 'main_test_file 6:6-6:7' ]);
    deepStrictEqual(r(7, 6), [ 'main_test_file 6:6-6:7', 'main_test_file 7:6-7:7' ]);
    deepStrictEqual(r(1, 0), [ 'main_test_file 1:0-1:1' ]);
  });

  it('warns about a local function value calling itself by its own name', () => {
    const { d, w } = probe(analyzeCode(lines('local x = 1', 'function f()', '  local x = x', '  local g = function(n) return g(n) end', 'end')));
    deepStrictEqual(d(3, 12), [ 'main_test_file 1:6-1:7' ]);
    deepStrictEqual(w(), [ 'main_test_file 4:31 undefined variable: g' ]);
  });

  it('lets until read a body local, and warns about a loop variable used after its loop', () => {
    const { d, w } = probe(analyzeCode(lines('function f()', '  repeat local done = true until done', '  for i = 1, 3 do end', '  print(i)', 'end')));
    deepStrictEqual(d(2, 33), [ 'main_test_file 2:15-2:19' ]);
    deepStrictEqual(w(), [ 'main_test_file 4:8 undefined variable: i' ]);
  });

  it('does not take a global for a loop variable after the loop', () => {
    const { d, w } = probe(analyzeCode(lines('function f()', '  for i = 1, 3 do end', '  i = 10', 'end', 'function g()', '  print(i)', 'end')));
    deepStrictEqual(d(6, 8), [ 'main_test_file 3:2-3:3' ]);
    deepStrictEqual(w(), []);
  });

  it('lists every definition of a function defined twice', () => {
    const { d } = probe(analyzeCode(lines('function draw() end', 'function draw() end', 'draw()')));
    deepStrictEqual(d(3, 0), [ 'main_test_file 1:9-1:13', 'main_test_file 2:9-2:13' ]);
  });

  it('goes to the methods of that name when a method call has no definition on its table', () => {
    const { d, r } = probe(analyzeCode(lines('entity = {}', 'function entity:become(s) self.state = s end', 'guy = entity:extend()',
      'function guy:free()', '  self:become("idle")', '  print(self.become)', 'end')));
    deepStrictEqual(d(5, 8), [ 'main_test_file 2:16-2:22' ]);
    deepStrictEqual(r(5, 8), [ 'main_test_file 5:7-5:13', 'main_test_file 6:13-6:19' ]);
    deepStrictEqual(d(6, 14), []);
  });

  it('lists every candidate method, and prefers the table\'s own', () => {
    const inherited = probe(analyzeCode(lines('entity = {}', 'function entity:become(s) end', 'other = {}', 'function other:become() end',
      'guy = entity:extend()', 'function guy:free()', '  self:become("idle")', 'end')));
    deepStrictEqual(inherited.d(7, 8), [ 'main_test_file 2:16-2:22', 'main_test_file 4:15-4:21' ]);
    const own = probe(analyzeCode(lines('entity = {}', 'function entity:become(s) end', 'guy = {}', 'function guy:become() end',
      'function guy:free()', '  self:become()', 'end')));
    deepStrictEqual(own.d(6, 8), [ 'main_test_file 4:13-4:19' ]);
    const throughParameter = probe(analyzeCode(lines('entity = {}', 'function entity.become(s) end', 'function f(e) e.become(1) end')));
    deepStrictEqual(throughParameter.d(3, 16), [ 'main_test_file 2:16-2:22' ]);
  });

  it('goes from a method call on an unnamed table to the methods of that name', () => {
    const { d } = probe(analyzeCode(lines('enemy = {}', 'function enemy:update() end', 'player = {}', 'function player:hit(n) end',
      'for i = 1, #enemies do', '  enemies[i]:update()', 'end', 'get_player():hit(1)')));
    deepStrictEqual(d(6, 14), [ 'main_test_file 2:15-2:21' ]);
    deepStrictEqual(d(8, 13), [ 'main_test_file 4:16-4:19' ]);
  });

  it('does not count a compound assignment as a definition of a global', () => {
    const { d, r, w } = probe(analyzeCode(lines('function _update() score += 1 end', 'function _draw() print(score) end')));
    deepStrictEqual(d(2, 23), []);
    deepStrictEqual(r(2, 23), [ 'main_test_file 1:19-1:24', 'main_test_file 2:23-2:28' ]);
    deepStrictEqual(w(), [ 'main_test_file 1:19 undefined variable: score', 'main_test_file 2:23 undefined variable: score' ]);
  });

  it('goes to the first plain assignment of a global that is also compound-assigned', () => {
    const code = lines('function _update() score += 1 end', 'function _init() score = 0 end');
    const { d, w } = probe(analyzeCode(code));
    deepStrictEqual(d(1, 19), [ 'main_test_file 2:17-2:22' ]);
    deepStrictEqual(w(), []);
    strictEqual(outlineOf(code), lines('_update() [Function]', '_init() [Function]', 'score [Variable]'));
  });

  it('does not move the implicit entry of a global to a compound assignment', () => {
    deepStrictEqual(probe(analyzeCode(lines('a.x = 1', 'a += 1'))).d(2, 0), [ 'main_test_file 1:0-1:1' ]);
  });

  it('still counts a compound assignment of a field as a definition', () => {
    const { d } = probe(analyzeCode(lines('player = { hp = 3 }', 'function hit() player.hp -= 1 end')));
    deepStrictEqual(d(2, 22), [ 'main_test_file 1:11-1:13' ]);
    const throughParameter = probe(analyzeCode(lines('function hit(p)', '  p.hp -= 1', 'end')));
    deepStrictEqual(throughParameter.d(2, 5), []);
  });

  it('does not link self.k of functions that are not methods', () => {
    const { d, r, w } = probe(analyzeCode(lines('function f() self.x = 1 end', 'function g() print(self.x) end')));
    deepStrictEqual(d(2, 19), []);
    deepStrictEqual(r(2, 24), [ 'main_test_file 2:24-2:25' ]);
    deepStrictEqual(r(1, 18), [ 'main_test_file 1:18-1:19' ]);
    deepStrictEqual(w(), []);
  });

  it('leaves the declaration out when asked', () => {
    const a = analyzeCode('local a\nb = a');
    deepStrictEqual(referencesAtPos(a, 2, 4, undefined, false), [ 'main_test_file 2:4-2:5' ]);
  });
});

describe('undefined variable warnings', () => {
  const warnings = (code: string) => warningsIn(analyzeCode(code));

  it('warns about an undefined function', () => {
    deepStrictEqual(warnings('do_the_thing()'), [ 'main_test_file 1:0 undefined variable: do_the_thing' ]);
  });

  it('warns about an undefined value', () => {
    deepStrictEqual(warnings('a = b'), [ 'main_test_file 1:4 undefined variable: b' ]);
  });

  it('warns about an undefined value assigned to a field', () => {
    deepStrictEqual(warnings('a = {} a.member = b'), [ 'main_test_file 1:18 undefined variable: b' ]);
  });

  it('warns about an undefined base of a field', () => {
    deepStrictEqual(warnings('local a\nb.c = a'), [ 'main_test_file 2:0 undefined variable: b' ]);
    deepStrictEqual(warnings('a.b()'), [ 'main_test_file 1:0 undefined variable: a' ]);
  });

  it('warns about a top-level local used above its declaration (#37)', () => {
    deepStrictEqual(warnings(lines('function _draw()', '  print(a)', '  print(b)', 'end', 'a = 1', 'local b = 1')),
      [ 'main_test_file 3:8 undefined variable: b' ]);
    deepStrictEqual(warnings('print(b)\nlocal b = 1'), [ 'main_test_file 1:6 undefined variable: b' ]);
  });

  it('does not warn about visible locals', () => {
    deepStrictEqual(warnings(lines('local b = 1', 'function _draw()', '  print(b)', 'end')), []);
    deepStrictEqual(warnings(lines('function f()', '  local b = 1', '  return function() return b end', 'end')), []);
  });

  it('does not warn about self', () => {
    deepStrictEqual(warnings(lines('a2 = {', '  self_fn = function() self.mem = 0 end,', '  b2 = {',
      '    self_fn = function() self.mem = 0 end,', '  }', '}')), []);
  });

  it('does not warn about the global self of top-level code', () => {
    deepStrictEqual(warnings('print(self)'), []);
    deepStrictEqual(warnings('self.x = 1'), []);
  });

  it('warns only about names that are not built in, by own property', () => {
    deepStrictEqual(warnings('print(constructor)\ncls()\nx = toString'),
      [ 'main_test_file 1:6 undefined variable: constructor', 'main_test_file 3:4 undefined variable: toString' ]);
  });

  it('gives no warnings to a cart that refers to its global _ENV, in any of its files', () => {
    const uses = [ 'print(_ENV)', 'assigntable("a:1", _ENV)', '_ENV[k] = 1', '_ENV = {}', '_\u{1d626}\u{1d62f}\u{1d637}[k] = 1' ];
    for (const use of uses) {
      deepStrictEqual(warnings(lines(use, 'print(nope)')), [], use);
    }
    deepStrictEqual(warningsIn(analyzeCode(lines('#include lib.lua', 'print(nope)'), { 'lib.lua': 'global = _ENV' })), []);
  });

  it('still warns in a cart whose only _ENV is a local one, and in one with no _ENV', () => {
    deepStrictEqual(warnings(lines('function f(_ENV) print(_ENV) end', 'print(nope)')), [ 'main_test_file 2:6 undefined variable: nope' ]);
    deepStrictEqual(warnings(lines('t = {}', 'print(t.k, nope)')), [ 'main_test_file 2:11 undefined variable: nope' ]);
  });

  it('does not warn about the names read where a local, a parameter or a loop variable _ENV is visible', () => {
    const codes = [
      lines('ps = {}', 'for _ENV in all(ps) do circ(x, y) end'),
      'function move(_ENV) x += dx end',
      lines('function new() return {} end', 'function f()', '  local _ENV = new()', '  hp = max_hp', 'end'),
      lines('function f(_ENV)', '  return function() x += dx end', 'end'),
      'function move(_\u{1d626}\u{1d62f}\u{1d637}) x += dx end',
    ];
    for (const code of codes) {
      deepStrictEqual(warnings(code), [], code);
    }
  });

  it('reads the initializer of a local _ENV, the header of a for over _ENV and the code after the scope of an _ENV outside it', () => {
    deepStrictEqual(warnings(lines('function f()', '  local _ENV = { hp = max_hp }', '  print(hp)', 'end', 'for _ENV in all(ps) do x = 1 end', 'print(x)')),
      [ 'main_test_file 2:22 undefined variable: max_hp', 'main_test_file 5:16 undefined variable: ps', 'main_test_file 6:6 undefined variable: x' ]);
  });

  it('does not take an assignment where a local _ENV is visible for a definition of the global', () => {
    deepStrictEqual(warnings(lines('function init(_ENV) score = 0 end', 'print(score)')), [ 'main_test_file 2:6 undefined variable: score' ]);
    deepStrictEqual(warnings(lines('function init(_ENV) score = 0 end', 'score = 1', 'print(score)')), []);
  });

  it('warns about rawequals and coyield, which PICO-8 does not have', () => {
    deepStrictEqual(warnings(lines('rawequals()', 'coyield()')),
      [ 'main_test_file 1:0 undefined variable: rawequals', 'main_test_file 2:0 undefined variable: coyield' ]);
  });

  it('does not warn about the globals PICO-8 0.2.7 defines for every cart, documented or not', () => {
    deepStrictEqual(warnings(lines('t = {}', 'for i, v in inext, t do print(rawequal(v, t), ls()) end', 'reboot()', 'holdframe()')), []);
  });
});

describe('isBuiltinName', () => {
  it('knows the builtin functions and constants', () => {
    strictEqual(isBuiltinName('cls'), true);
    strictEqual(isBuiltinName('█'), true);
  });

  it('knows the documented globals of PICO-8 0.2.7, its console commands and its internal functions, and documents only the first', () => {
    deepStrictEqual([ 'inext', 'rawequal', 'ls', 'reboot', 'holdframe', '_pausemenu' ].map(name => isBuiltinName(name)),
      [ true, true, true, true, true, true ]);
    ok([ 'inext', 'rawequal', 'ls' ].every(name => builtinInfo(name)?.sig && builtinInfo(name)?.params));
    deepStrictEqual([ 'reboot', 'holdframe', '_pausemenu' ].map(name => builtinInfo(name)), [ undefined, undefined, undefined ]);
  });

  it('does not know rawequals, which PICO-8 does not define', () => {
    strictEqual(isBuiltinName('rawequals'), false);
  });

  it('does not know coyield or self, which PICO-8 0.2.7 does not define', () => {
    deepStrictEqual([ 'coyield', 'self' ].map(name => isBuiltinName(name)), [ false, false ]);
  });

  it('does not take the properties every object has for builtins', () => {
    strictEqual(isBuiltinName('toString'), false);
    strictEqual(isBuiltinName('constructor'), false);
    strictEqual(isBuiltinName('hasOwnProperty'), false);
  });

  it('returns the info of a builtin', () => {
    ok(builtinInfo('print')!.sig!.length > 0);
  });

  it('returns undefined for inherited property names', () => {
    strictEqual(builtinInfo('constructor'), undefined);
    strictEqual(builtinInfo('toString'), undefined);
    strictEqual(builtinInfo('__proto__'), undefined);
  });

  it('gives every builtin but the ? shorthand for print a signature that calls it by its own name', () => {
    const unsigned = Object.entries(Builtins).filter(([ name, info ]) => name !== '?' && !(info.sig?.startsWith(name + '( ') && info.sig.endsWith(')')));
    deepStrictEqual(unsigned.map(([ name, info ]) => `${name}: ${info.sig}`), []);
  });
});
