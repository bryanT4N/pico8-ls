import * as assert from 'assert';
import { outlineOf } from './outline-utils';
import { parse, deepEquals, bounds, MockFileResolver } from './test-utils';

const lines = (...l: string[]) => l.join('\n');

describe('outline', () => {
  describe('functions and globals', () => {
    it('lists global functions with their signatures, once per definition', () => {
      assert.strictEqual(outlineOf('function draw() end\nfunction update(dt) end\nfunction draw() end'),
        lines('draw() [Function]', 'update(dt) [Function]', 'draw() [Function]'));
    });

    it('lists each global once, at its first assignment, even inside a function', () => {
      assert.strictEqual(outlineOf('function _init()\n  score = 0\n  lives = 3\nend\nscore = 1'),
        lines('_init() [Function]', 'score [Variable]', 'lives [Variable]'));
    });

    it('lists every function assigned to a global', () => {
      assert.strictEqual(outlineOf('x = function(a) end\nx = function(b) end\ny = 1\ny = function() end'),
        lines('x(a) [Function]', 'x(b) [Function]', 'y [Variable]', 'y() [Function]'));
    });

    it('lists a global function declared inside a function under that function', () => {
      assert.strictEqual(outlineOf('function _init()\n  function helper() end\nend'),
        lines('_init() [Function]', '  helper() [Function]'));
      assert.strictEqual(outlineOf('function _init()\n  helper2 = function(a) end\nend'),
        lines('_init() [Function]', '  helper2(a) [Function]'));
    });

    it('formats varargs in signatures', () => {
      assert.strictEqual(outlineOf('function f(a, ...) end'), 'f(a,...) [Function]');
    });

    it('lists labels where they are', () => {
      assert.strictEqual(outlineOf('::top::\nfunction f()\n  ::again::\nend'),
        lines('top [Label]', 'f() [Function]', '  again [Label]'));
    });

    it('gives a function its full range around the ? print shorthand (issue #17)', () => {
      const { errors, symbols } = parse(lines('', 'function debug_draw()', 'circfill(mx,my,lmb>0 and 2 or 1,7)',
        'local f,g = flags[fmx+fmy*128], switch[fmx+fmy*128]', '?fmx.." "..fmy,1,122,12', 'end'));
      deepEquals(errors, []);
      deepEquals(symbols[0], { name: 'debug_draw', type: 'Function', loc: bounds(2, 0, 6, 3) });
    });
  });

  describe('scopes', () => {
    it('lists locals under their function, including those in blocks', () => {
      assert.strictEqual(outlineOf(lines(
        'function f()', '  local a = 1', '  if a then', '    local b = 2', '  end',
        '  for i = 1, 3 do', '    local c = i', '  end', 'end')),
      lines('f() [Function]', '  a [Variable]', '  b [Variable]', '  c [Variable]'));
    });

    it('does not list parameters or loop variables, but resolves assignments to them', () => {
      assert.strictEqual(outlineOf(lines(
        'function f(a, b)', '  a = a + 1', '  for i = 1, 2 do i = 3 end',
        '  for k, v in pairs(t) do v = 0 end', 'end')),
      'f(a,b) [Function]');
    });

    it('lists file-level locals at the top level', () => {
      assert.strictEqual(outlineOf('local speed = 2\nfunction f()\n  speed = 3\nend'),
        lines('speed [Variable]', 'f() [Function]'));
    });

    it('lists one entry per local declaration', () => {
      assert.strictEqual(outlineOf(lines('function f()', '  local x = 1', '  x = 2', '  do local x = 3 end', 'end')),
        lines('f() [Function]', '  x [Variable]', '  x [Variable]'));
    });

    it('keeps a local apart from a global with the same name', () => {
      assert.strictEqual(outlineOf('x = 1\nfunction f()\n  local x = 2\n  x = 3\nend'),
        lines('x [Variable]', 'f() [Function]', '  x [Variable]'));
    });

    it('lists local functions and functions assigned to locals', () => {
      assert.strictEqual(outlineOf('function f()\n  local function g() end\n  local h = function(a) end\nend'),
        lines('f() [Function]', '  g() [Function]', '  h(a) [Function]'));
    });

    it('lists a function assigned to a parameter', () => {
      assert.strictEqual(outlineOf('function f(cb)\n  cb = function() end\n  function cb(x) end\nend'),
        lines('f(cb) [Function]', '  cb() [Function]', '  cb(x) [Function]'));
    });

    it('lists callbacks as anonymous functions, with their locals', () => {
      assert.strictEqual(outlineOf(lines('function _update()', '  foreach(enemies, function(e)',
        '    local speed = 1', '  end)', 'end')),
      lines('_update() [Function]', '  <anonymous function>(e) [Function]', '    speed [Variable]'));
    });

    it('puts the locals of a function assigned to a global under it', () => {
      assert.strictEqual(outlineOf('x = function()\n  local y = 1\nend'), lines('x() [Function]', '  y [Variable]'));
    });

    it('does not see a local inside its own initializer', () => {
      assert.strictEqual(outlineOf('local co = cocreate(function()\n  co = nil\nend)'),
        lines('co [Variable]', '<anonymous function>() [Function]', 'co [Variable]'));
      assert.strictEqual(outlineOf('local f = function()\n  f = function() end\nend'),
        lines('f() [Function]', '  f() [Function]'));
    });

    it('falls back to the local it shadows in the same scope', () => {
      assert.strictEqual(outlineOf('local x = 1\nlocal x = function()\n  x = function() end\nend'),
        lines('x [Variable]', 'x() [Function]', '  x() [Function]'));
    });

    it('lets a local shadow a parameter', () => {
      assert.strictEqual(outlineOf('function f(p)\n  local p = {}\n  p.x = 1\nend'),
        lines('f(p) [Function]', '  p [Table]', '    x [Field]'));
    });
  });

  describe('table members', () => {
    it('groups constructor keys and later field assignments under the table, once each', () => {
      assert.strictEqual(outlineOf(lines('player = { x = 64, y = 64 }', 'function _init()',
        '  player.hp = 3', '  player.x = 10', 'end')),
      lines('player [Table]', '  x [Field]', '  y [Field]', '  hp [Field]', '_init() [Function]'));
    });

    it('creates intermediate members for nested paths', () => {
      assert.strictEqual(outlineOf('cfg = {}\ncfg.screen.w = 128\ncfg.screen.h = 128'),
        lines('cfg [Table]', '  screen [Table]', '    w [Field]', '    h [Field]'));
    });

    it('merges keys when a table is assigned again', () => {
      assert.strictEqual(outlineOf('t = { a = 1 }\nt = { b = 2 }\nt.c = 3'),
        lines('t [Table]', '  a [Field]', '  b [Field]', '  c [Field]'));
    });

    it('marks tables with only positional values as arrays', () => {
      assert.strictEqual(outlineOf('levels = { 1, 2, 3 }\nempty = {}\nmixed = { 1, k = 2 }'),
        lines('levels [Array]', 'empty [Table]', 'mixed [Table]', '  k [Field]'));
    });

    it('turns an array that gets a field into a table', () => {
      assert.strictEqual(outlineOf('a = { 1, 2 }\na.n = 2'), lines('a [Table]', '  n [Field]'));
    });

    it('nests table constructors inside table constructors', () => {
      assert.strictEqual(outlineOf('player = { pos = { x = 0, y = 0 } }'),
        lines('player [Table]', '  pos [Table]', '    x [Field]', '    y [Field]'));
    });

    it('groups members of local tables under them', () => {
      assert.strictEqual(outlineOf(lines('function spawn(x, y)', '  local e = { x = x, y = y }',
        '  e.hp = 2', '  add(enemies, e)', 'end')),
      lines('spawn(x,y) [Function]', '  e [Table]', '    x [Field]', '    y [Field]', '    hp [Field]'));
    });

    it('places a global table used through a field first at its first assignment', () => {
      assert.strictEqual(outlineOf('function _init()\n  player.hp = 3\nend\nplayer = { x = 1 }'),
        lines('_init() [Function]', 'player [Table]', '  hp [Field]', '  x [Field]'));
    });

    it('treats setmetatable(table, mt) as the table', () => {
      assert.strictEqual(outlineOf('obj = setmetatable({ x = 0 }, mt)'), lines('obj [Table]', '  x [Field]'));
      assert.strictEqual(outlineOf('function new()\n  local e = setmetatable({ x = 0 }, mt)\n  e.hp = 1\nend'),
        lines('new() [Function]', '  e [Table]', '    x [Field]', '    hp [Field]'));
    });

    it('puts fields set through a local alias under the alias', () => {
      assert.strictEqual(outlineOf('player = {}\nfunction f()\n  local p = player\n  p.hp = 3\nend'),
        lines('player [Table]', 'f() [Function]', '  p [Table]', '    hp [Field]'));
    });

    it('lists a global table first assigned inside a function at the top level', () => {
      assert.strictEqual(outlineOf('function _init()\n  player = { x = 64 }\nend'),
        lines('_init() [Function]', 'player [Table]', '  x [Field]'));
    });

    it('keeps fields of a local and a global with the same name apart', () => {
      assert.strictEqual(outlineOf(lines('function f()', '  local p = {}', '  p.x = 1', 'end',
        'function g()', '  p.y = 2', 'end')),
      lines('f() [Function]', '  p [Table]', '    x [Field]', 'g() [Function]', 'p [Table]', '  y [Field]'));
    });

    it('attaches each value of a multiple assignment to its own target', () => {
      assert.strictEqual(outlineOf('t = {}\na, t.k = function() end, { n = 1 }'),
        lines('t [Table]', '  k [Table]', '    n [Field]', 'a() [Function]'));
    });

    it('moves an implicit table to its first assignment of any value', () => {
      assert.strictEqual(outlineOf('function move()\n  player.x = 1\nend\nfunction _init()\n  player = new_player()\nend'),
        lines('move() [Function]', '_init() [Function]', 'player [Table]', '  x [Field]'));
    });

    it('does not create tables for a path that is assigned a function', () => {
      const outline = outlineOf('function _init()\nend\nui.on_click = function() end\ngame = {}\ngame.state.update = function() end');
      assert.ok(!outline.includes('ui ['), outline);
      assert.ok(!outline.includes('state ['), outline);
    });

    it('upgrades an existing field that receives a constructor in a constructor', () => {
      assert.strictEqual(outlineOf('t = { p = 1 }\nt = { p = { 1, 2 } }'),
        lines('t [Table]', '  p [Array]'));
    });
  });

  describe('functions in tables', () => {
    it('lists functions written in a table constructor under the table, as methods', () => {
      assert.strictEqual(outlineOf('player = { x = 64, update = function(self) end }'),
        lines('player [Table]', '  x [Field]', '  update(self) [Method]'));
    });

    it('groups methods written right after their table', () => {
      assert.strictEqual(outlineOf(lines('vector = {}', 'function vector:len() return 0 end',
        'function vector.add(a, b) return a end', 'vector.zero = 0', 'function vector:norm() end')),
      lines('vector [Table]', '  len() [Method]', '  add(a,b) [Method]', '  zero [Field]', '  norm() [Method]'));
    });

    it('groups methods of a table created by a call', () => {
      assert.strictEqual(outlineOf('cls = object:extend()\nfunction cls:init() end\nfunction cls:draw() end'),
        lines('cls [Table]', '  init() [Method]', '  draw() [Method]'));
    });

    it('stretches the table range over its grouped methods', () => {
      const [ vector ] = parse('vector = {}\nfunction vector:len() return 0 end\nfunction vector:add(b) return b end').symbols;
      assert.deepStrictEqual([ vector.loc.start.line, vector.loc.end.line, vector.selectionLoc.start.line ], [ 1, 3, 1 ]);
    });

    it('keeps methods in place when other code sits between them and their table', () => {
      assert.strictEqual(outlineOf('player = { x = 64 }\nenemies = {}\nfunction player:update() end'),
        lines('player [Table]', '  x [Field]', 'enemies [Table]', 'player:update() [Method]'));
    });

    it('keeps methods in place across a tab or region boundary', () => {
      assert.strictEqual(outlineOf('obj = {}\nfunction obj:a() end\n-->8\nfunction obj:b() end'),
        lines('obj [Table]', 'obj:a() [Method]', 'obj:b() [Method]'));
      assert.strictEqual(outlineOf('obj = {}\n-- #region\nfunction obj:a() end\n-- #endregion'),
        lines('obj [Table]', 'obj:a() [Method]'));
    });

    it('does not treat trailing or unspaced region comments as boundaries', () => {
      assert.strictEqual(outlineOf('obj = {}\nfunction obj:a() end -- #region trailing\nfunction obj:b() end'),
        lines('obj [Table]', '  a() [Method]', '  b() [Method]'));
      assert.strictEqual(outlineOf('obj = {}\nfunction obj:a() end\n--#regionfoo\nfunction obj:b() end'),
        lines('obj [Table]', '  a() [Method]', '  b() [Method]'));
      assert.strictEqual(outlineOf('obj = {}\nfunction obj:a() end -->8\nfunction obj:b() end'),
        lines('obj [Table]', '  a() [Method]', '  b() [Method]'));
    });

    it('groups methods of a local table inside a function', () => {
      assert.strictEqual(outlineOf(lines('function new_game()', '  local game = {}',
        '  function game.update() end', '  function game.draw() end', '  return game', 'end')),
      lines('new_game() [Function]', '  game [Table]', '    update() [Method]', '    draw() [Method]'));
    });

    it('groups methods assigned with = and lists each definition', () => {
      assert.strictEqual(outlineOf('t = {}\nt.f = function(a) end\nfunction t.f() end'),
        lines('t [Table]', '  f(a) [Method]', '  f() [Method]'));
    });

    it('keeps methods on deeper paths in place', () => {
      assert.strictEqual(outlineOf('t = { a = {} }\nfunction t.a.f() end'),
        lines('t [Table]', '  a [Table]', 't.a.f() [Method]'));
    });

    it('keeps methods in place when the table was first defined somewhere else', () => {
      assert.strictEqual(outlineOf('function _init()\n  t = {}\nend\nt = {}\nfunction t:a() end'),
        lines('_init() [Function]', 't [Table]', 't:a() [Method]'));
    });

    it('keeps methods in place when one comes before the table is assigned', () => {
      assert.strictEqual(outlineOf('t.x = 1\nfunction t:a() end\nt = {}\nfunction t:b() end'),
        lines('t:a() [Method]', 't [Table]', '  x [Field]', 't:b() [Method]'));
    });

    it('lists methods of a table that is not defined in this file', () => {
      assert.strictEqual(outlineOf('function player:draw() end\nplayer.speed = 2'),
        lines('player:draw() [Method]', 'player [Table]', '  speed [Field]'));
    });

    it('keeps methods in place when grouping would cover another entry', () => {
      assert.strictEqual(outlineOf('game = {}\ngame.co = cocreate(function() end)\nfunction game:update() end'),
        lines('game [Table]', '  co [Field]', '<anonymous function>() [Function]', 'game:update() [Method]'));
      assert.strictEqual(outlineOf('p = {}\np.anim = {}\nfunction p.anim.walk() end\nfunction p:update() end'),
        lines('p [Table]', '  anim [Table]', 'p.anim.walk() [Method]', 'p:update() [Method]'));
      assert.strictEqual(outlineOf('obj = {}\nfunction obj:a() end\nobj = function() end\nfunction obj:b() end'),
        lines('obj [Table]', 'obj:a() [Method]', 'obj() [Function]', 'obj:b() [Method]'));
    });

    it('keeps methods in place for a global table defined inside a function', () => {
      assert.strictEqual(outlineOf('function _init()\n  player = {}\n  function player:update() end\nend'),
        lines('_init() [Function]', '  player:update() [Method]', 'player [Table]'));
    });

    it('still groups when a method body assigns a global for the first time', () => {
      assert.strictEqual(outlineOf('vector = {}\nfunction vector:len()\n  count = 0\nend'),
        lines('vector [Table]', '  len() [Method]', 'count [Variable]'));
    });
  });

  describe('self', () => {
    it('puts self fields in colon methods under the table', () => {
      assert.strictEqual(outlineOf('player = {}\nfunction player:update()\n  self.x = 1\nend'),
        lines('player [Table]', '  update() [Method]', '  x [Field]'));
    });

    it('treats an explicit self parameter the same way', () => {
      assert.strictEqual(outlineOf('player = {}\nfunction player.update(self)\n  self.x = 1\nend'),
        lines('player [Table]', '  update(self) [Method]', '  x [Field]'));
    });

    it('resolves self in a function assigned to a field', () => {
      assert.strictEqual(outlineOf('player = {}\nplayer.update = function(self) self.x = 1 end'),
        lines('player [Table]', '  update(self) [Method]', '  x [Field]'));
    });

    it('resolves self in a method written in the constructor', () => {
      assert.strictEqual(outlineOf('player = { update = function(self) self.x = 1 end }'),
        lines('player [Table]', '  update(self) [Method]', '  x [Field]'));
    });

    it('resolves self inside a callback in a method', () => {
      assert.strictEqual(outlineOf(lines('player = {}', 'function player:update()',
        '  foreach(enemies, function(e) self.hits = 1 end)', 'end')),
      lines('player [Table]', '  update() [Method]', '    <anonymous function>(e) [Function]', '  hits [Field]'));
    });

    it('does not resolve self in a callback that has its own self parameter', () => {
      assert.strictEqual(outlineOf('player = {}\nfunction player:update()\n  foreach(es, function(self) self.x = 1 end)\nend'),
        lines('player [Table]', '  update() [Method]', '    <anonymous function>(self) [Function]'));
    });

    it('creates the deeper table of a method only when self assigns to it', () => {
      assert.strictEqual(outlineOf('game = {}\nfunction game.state:update() end'),
        lines('game [Table]', 'game.state:update() [Method]'));
      assert.strictEqual(outlineOf('game = {}\nfunction game.state:update()\n  self.t = 0\nend'),
        lines('game [Table]', '  state [Table]', '    t [Field]', 'game.state:update() [Method]'));
    });

    it('resolves self the same way in every deeper method form', () => {
      assert.strictEqual(outlineOf('T = {}\nfunction T.a.m(self)\n  self.x = 1\nend'),
        lines('T [Table]', '  a [Table]', '    x [Field]', 'T.a.m(self) [Method]'));
      assert.strictEqual(outlineOf('T = {}\nT.a.m = function(self) self.x = 1 end'),
        lines('T [Table]', '  a [Table]', '    x [Field]', 'T.a.m(self) [Method]'));
    });

    it('does not list self fields outside methods', () => {
      assert.strictEqual(outlineOf('function f()\n  self.x = 1\nend'), 'f() [Function]');
    });

    it('lists a function assigned to a self field under the method, by its path', () => {
      assert.strictEqual(outlineOf('T = {}\nfunction T:m()\n  self.cb = function() end\nend'),
        lines('T [Table]', '  m() [Method]', '    self.cb() [Method]'));
    });

    it('lists only the functions of a table assigned to self outside methods', () => {
      assert.strictEqual(outlineOf('function f()\n  self.h = { on = function() end, n = 1 }\nend'),
        lines('f() [Function]', '  self.h.on() [Method]'));
    });
  });

  describe('fields of parameters and unnamed tables', () => {
    it('does not list fields set through parameters or loop variables', () => {
      assert.strictEqual(outlineOf(lines('function _update()', '  for e in all(enemies) do', '    e.x -= 1',
        '  end', 'end', 'function hit(p) p.hp = 0 end')),
      lines('_update() [Function]', 'hit(p) [Function]'));
    });

    it('lists functions set through parameters by their path', () => {
      assert.strictEqual(outlineOf(lines('function init(p)', '  p.update = function() end',
        '  function p.draw() end', '  p.h = { on = function() end, n = 1 }', 'end')),
      lines('init(p) [Function]', '  p.update() [Method]', '  p.draw() [Method]', '  p.h.on() [Method]'));
    });

    it('lists functions set on fields of indexed tables as anonymous, and their tables by key', () => {
      assert.strictEqual(outlineOf(lines('function init()', '  for i = 1, #btns do',
        '    btns[i].press = function() local t = 0 end', '    btns[i].pos = { x = 0, f = function() end }',
        '  end', 'end')),
      lines('init() [Function]', '  <anonymous function>() [Function]', '    t [Variable]', '  f() [Method]'));
    });

    it('handles such a function before anything else is listed', () => {
      assert.strictEqual(outlineOf('es[1].draw = function() end'), '<anonymous function>() [Function]');
      assert.strictEqual(outlineOf('print("hi")\nbtns[1].press = function() end'), '<anonymous function>() [Function]');
    });

    it('lists only the functions of unnamed tables, by key name', () => {
      assert.strictEqual(outlineOf(lines('function new_bullet(start)', '  local speed = 2',
        '  local m = make_movement { angle = .25 }', '  return {', '    has_finished = function() return false end,',
        '    _update = m._update,', '    _draw = function() end,', '  }', 'end')),
      lines('new_bullet(start) [Function]', '  speed [Variable]', '  m [Variable]',
        '  has_finished() [Method]', '  _draw() [Method]'));
    });

    it('ranges and selects a function of an unnamed table from its key', () => {
      const [ f ] = parse('function f()\n  return {\n    has_finished = function() end,\n  }\nend').symbols;
      const { name, loc, selectionLoc } = f.children[0];
      assert.deepStrictEqual([ name, loc.start.column, selectionLoc.start.column ], [ 'has_finished', 4, 4 ]);
    });

    it('lists functions of tables nested in unnamed tables by key name', () => {
      assert.strictEqual(outlineOf('function f()\n  return { a = { g = function() end }, n = 1 }\nend'),
        lines('f() [Function]', '  g() [Method]'));
    });

    it('lists functions of tables passed as arguments, without resolving self', () => {
      assert.strictEqual(outlineOf('function spawn()\n  add(enemies, { hp = 3, update = function(self) self.hp -= 1 end })\nend'),
        lines('spawn() [Function]', '  update(self) [Method]'));
    });

    it('lists functions with positional or computed keys as anonymous', () => {
      assert.strictEqual(outlineOf('states = { function() end, [2] = function() end }\nhandlers = { function() end }'),
        lines('states [Table]', '  <anonymous function>() [Function]', '  <anonymous function>() [Function]',
          'handlers [Array]', '  <anonymous function>() [Function]'));
    });

    it('lists functions of tables nested in a known table under that table', () => {
      assert.strictEqual(outlineOf(lines('levels = {', '  { name = "a", init = function() end },',
        '  { name = "b", init = function() end },', '}')),
      lines('levels [Array]', '  init() [Method]', '  init() [Method]'));
    });

    it('treats a local or loop variable named self as an ordinary name', () => {
      assert.strictEqual(outlineOf('function new_enemy()\n  local self = { x = 1 }\n  self.hp = 3\n  return self\nend'),
        lines('new_enemy() [Function]', '  self [Table]', '    x [Field]', '    hp [Field]'));
      assert.strictEqual(outlineOf('player = {}\nfunction player:update()\n  for self in all(xs) do self.y = 1 end\nend'),
        lines('player [Table]', '  update() [Method]'));
    });

    it('does not see a local self inside its own initializer', () => {
      assert.strictEqual(outlineOf('T = {}\nfunction T:m()\n  local self = { cb = function() self.x = 1 end }\nend'),
        lines('T [Table]', '  m() [Method]', '    self [Table]', '      cb() [Method]', '  x [Field]'));
    });
  });

  describe('#include and odd input', () => {
    it('lists only definitions from the current file', () => {
      const resolver = new MockFileResolver();
      resolver.loadFileContents = () => 'helper = 1\nfunction lib_fn() end';
      assert.strictEqual(outlineOf('#include other.lua\nfunction main_fn() end', { includeFileResolver: resolver }),
        'main_fn() [Function]');
    });

    it('groups members added to a table from another file under a table entry in this file', () => {
      const resolver = new MockFileResolver();
      resolver.loadFileContents = () => 'player = { x = 1 }';
      const { symbols } = parse('#include other.lua\nplayer.hp = 3', { includeFileResolver: resolver });
      assert.deepStrictEqual(symbols.map(s => [ s.name, s.type, s.children.map(c => c.name) ]), [[ 'player', 'Table', [ 'hp' ]]]);
      assert.strictEqual(symbols[0].loc.start.line, 2);
    });

    it('nests the entries for members added to a table from another file', () => {
      const resolver = new MockFileResolver();
      resolver.loadFileContents = () => 'T = { a = {} }';
      const code = '#include other.lua\nT.y = 1\nT.a.b = 2';
      assert.strictEqual(outlineOf(code, { includeFileResolver: resolver }),
        lines('T [Table]', '  y [Field]', '  a [Table]', '    b [Field]'));
      assert.strictEqual(parse(code, { includeFileResolver: resolver }).symbols[0].loc.start.line, 2);
    });

    it('keeps the main file outline when an included file has a broken #include', () => {
      const resolver = new MockFileResolver();
      resolver.loadFileContents = () => '#include other.lua\nfunction a_fn() end';
      assert.strictEqual(outlineOf('#include other.lua\nfunction main_fn() end', { includeFileResolver: resolver }),
        'main_fn() [Function]');
    });

    it('keeps the main file comments and outline when an included file includes a missing file', () => {
      const resolver = new MockFileResolver();
      resolver.doesFileExist = p => !p.endsWith('missing.lua');
      resolver.loadFileContents = () => '#include missing.lua\n-- a comment\nfunction a_fn() end';
      const code = '#include a.lua\nfunction main_fn() end\n-- main comment';
      assert.deepStrictEqual(parse(code, { includeFileResolver: resolver }).comments!.map(c => c.value.trim()), [ 'main comment' ]);
      assert.strictEqual(outlineOf(code, { includeFileResolver: resolver }), 'main_fn() [Function]');
    });

    it('does not group methods with a table defined in another file', () => {
      const resolver = new MockFileResolver();
      resolver.loadFileContents = () => 'vector = {}';
      assert.strictEqual(outlineOf('#include other.lua\nfunction vector:len() end', { includeFileResolver: resolver }),
        'vector:len() [Method]');
    });

    it('handles assignments with missing or extra values', () => {
      assert.strictEqual(outlineOf('a, b = 1\nlocal x, y\nt = {}\nt.a, t.b = function() end'),
        lines('a [Variable]', 'b [Variable]', 'x [Variable]', 'y [Variable]', 't [Table]', '  a() [Method]', '  b [Field]'));
    });
  });
});
