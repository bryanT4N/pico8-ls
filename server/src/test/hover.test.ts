import { strictEqual } from 'assert';
import { hoverMarkdown } from '../hover';
import { analyzeCode, referenceAtPos } from '../parser/test/test-utils';

const lines = (...l: string[]) => l.join('\n');
const block = (declaration: string) => '```pico-8-lua\n' + declaration + '\n```';
function hoverAt(code: string, line: number, column: number, files?: Record<string, string>): string | undefined {
  const a = analyzeCode(code, files);
  return hoverMarkdown(a.analysis, referenceAtPos(a, line, column)!);
}

describe('hoverMarkdown', () => {
  it('shows the declaration of each kind of function', () => {
    strictEqual(hoverAt(lines('x = 1', '-- creates a deep copy', 'function deep_copy(obj) return obj end', 'deep_copy({})'), 4, 0),
      block('function deep_copy(obj)') + '\n\ncreates a deep copy');
    strictEqual(hoverAt(lines('local function handle_collisions() end', 'handle_collisions()'), 2, 0), block('local function handle_collisions()'));
    strictEqual(hoverAt(lines('vector = {}', '-- dot product', 'function vector:dot(v2) return 0 end', 'vector:dot(vector)'), 4, 7),
      block('function vector:dot(v2)') + '\n\ndot product');
    const fields = lines('game = {}', 'function game.start_boss_fight() end', 'player = { update = function(self, dt) end }', 'game.start_boss_fight()', 'player.update(player, 1)');
    strictEqual(hoverAt(fields, 4, 5), block('function game.start_boss_fight()'));
    strictEqual(hoverAt(fields, 5, 7), block('function player.update(self, dt)'));
    // With no doc, the function definition.
    strictEqual(hoverAt(lines('f = nil', 'function f(a) end', 'f(1)'), 3, 0), block('function f(a)'));
  });

  it('shows a function on a table no name holds as a method, and its self as a parameter', () => {
    const code = lines('add(es, { update = function(self, dt) return self end })', 'for e in all(es) do e:update(1) end');
    strictEqual(hoverAt(code, 1, 10), block('(method) update(self, dt)'));
    strictEqual(hoverAt(code, 1, 45), block('(parameter) self'));
    // e has no update of its own, so the call shows the methods of that name.
    strictEqual(hoverAt(code, 2, 22), block('(method) update(self, dt)'));
  });

  it('shows a global with its literal value', () => {
    const code = lines('g_debug = false', 'speed = -2', 'title = "mole mole"', 'long = "' + 'a'.repeat(40) + '"', 'player = player or {}', 'entity = make()',
      'print(g_debug, speed, title, long, player, entity)');
    strictEqual(hoverAt(code, 7, 6), block('(global) g_debug = false'));
    strictEqual(hoverAt(code, 7, 15), block('(global) speed = -2'));
    strictEqual(hoverAt(code, 7, 22), block('(global) title = "mole mole"'));
    // Its raw has 42 characters.
    strictEqual(hoverAt(code, 7, 29), block('(global) long'));
    strictEqual(hoverAt(code, 7, 35), block('(global) player = {\u2026}'));
    strictEqual(hoverAt(code, 7, 43), block('(global) entity'));
    // A string on several lines would break the code block.
    strictEqual(hoverAt(lines('s = [[', '```', ']]', 'print(s)'), 4, 6), block('(global) s'));
  });

  it('takes the value from a plain assignment, never from a compound one', () => {
    // Go to Definition goes nowhere for ent.vel, so no definition is shown either.
    strictEqual(hoverAt(lines('function move(ent)', '  ent.vel += 1', 'end'), 2, 6), block('(field) ent.vel'));
    strictEqual(hoverAt(lines('t.k += 1', 'print(t.k)'), 2, 8), block('(field) t.k'));
    const lib = { 'lib.lua': 'function hit() g.hp -= 1 end' };
    strictEqual(hoverAt(lines('#include lib.lua', 'g = {}', 'g.hp = 3', 'print(g.hp)'), 4, 8, lib), block('(field) g.hp = 3'));
  });

  it('shows locals, fields, parameters, loop variables and labels', () => {
    const locals = lines('local speed = 2', 'local name = nil', 'print(speed, name)');
    strictEqual(hoverAt(locals, 3, 6), block('local speed = 2'));
    strictEqual(hoverAt(locals, 3, 13), block('local name = nil'));
    const fields = lines('player = { hp = 3 }', 'player.pos = { x = 1 }', 'add(enemies, { hp = 5 })', 'print(player.hp, player.pos.x)');
    strictEqual(hoverAt(fields, 4, 13), block('(field) player.hp = 3'));
    strictEqual(hoverAt(fields, 4, 28), block('(field) player.pos.x = 1'));
    strictEqual(hoverAt(fields, 3, 15), block('(field) hp = 5'));
    strictEqual(hoverAt(lines('x = 1', '-- moves p', '-- @param p the thing', 'function move(p) return p end'), 4, 24), block('(parameter) p') + '\n\nthe thing');
    strictEqual(hoverAt('for i = 1, 3 do print(i) end', 1, 22), block('(loop variable) i'));
    strictEqual(hoverAt(lines('for i = 1, 3 do', '  goto continue', '  -- next round', '  ::continue::', 'end'), 2, 7), block('::continue::') + '\n\nnext round');
  });

  it('shows self as its table', () => {
    strictEqual(hoverAt(lines('x = 1', '-- the vector class', 'vector = {}', 'function vector:len() return self.x end'), 4, 29),
      block('(self) vector') + '\n\nthe vector class');
    strictEqual(hoverAt('function f() return self end', 1, 20), block('(parameter) self'));
    strictEqual(hoverAt(lines('a = { b = {} }', 'function a.b:m() return self end'), 2, 24), block('(self) a.b'));
  });

  it('shows the methods of that name for a method call the table does not define', () => {
    const one = lines('entity = {}', '-- changes state', 'function entity:become(state) end', 'guy = {}', 'function guy:update() self:become("idle") end');
    strictEqual(hoverAt(one, 5, 27), block('function entity:become(state)') + '\n\nchanges state');
    const two = lines('entity = {}', 'function entity:become(state) end', 'bee = {}', 'function bee:become(s) end', 'guy = {}', 'function guy:update() self:become("idle") end');
    strictEqual(hoverAt(two, 6, 27), block('function entity:become(state)') + '\n\n---\n\n' + block('function bee:become(s)'));
    // Not a call.
    strictEqual(hoverAt(lines('entity = {}', 'function entity:become(state) end', 'guy = {}', 'function guy:update() return self.become end'), 4, 34), undefined);
  });

  it('lets a user function shadow a builtin of the same name', () => {
    strictEqual(hoverAt(lines('function print(s) end', 'print(1)'), 2, 0), block('function print(s)'));
    strictEqual(hoverAt('cls()', 1, 0), undefined);
  });

  it('renders LDoc tags as TypeScript does', () => {
    const code = lines('x = 1', '--- Moves a thing.', '-- @param p the thing', '-- @param dx how far,', '--   in pixels', '-- @return the new x', '-- @return',
      'function move(p, dx) return p end');
    // The empty @return is left out.
    strictEqual(hoverAt(code, 8, 9),
      block('function move(p, dx)') + '\n\nMoves a thing.\n\n*@param* `p` \u2014 the thing  \n\n*@param* `dx`  \nhow far,\nin pixels  \n\n*@return* \u2014 the new x');
  });

  it('renders an @param with no name as the tag alone', () => {
    strictEqual(hoverAt(lines('x = 1', '-- moves', '-- @param', 'function move(p) end'), 4, 9), block('function move(p)') + '\n\nmoves\n\n*@param*');
  });
});
