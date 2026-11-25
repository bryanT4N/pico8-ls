import { deepStrictEqual, notStrictEqual, strictEqual } from 'assert';
import { analyzeCode, getTestFileContents, TEST_CARTS, testFile } from '../parser/test/test-utils';
import { CodeSymbol, CodeSymbolType, outlineFor } from '../parser/symbols';
import { AnonymousFunctionName } from '../parser/statements';
import { SymbolItem, searchSymbols, symbolItems } from '../workspace-symbols';

const lines = (...l: string[]) => l.join('\n');
const shown = (item: SymbolItem) => `${item.label} [${item.container}] ${item.selectionLoc.start.line}:${item.selectionLoc.start.column}`;
// The main file's items as `label [container] line:column`, by place.
function itemsIn(code: string, files?: Record<string, string>): string[] {
  const items = symbolItems(analyzeCode(code, files).analysis).get(testFile().fileURL) ?? [];
  return [ ...items ].sort((a, b) => a.selectionLoc.start.index - b.selectionLoc.start.index).map(shown);
}
const allItems = (code: string) => [ ...symbolItems(analyzeCode(code).analysis).values() ].flat();

describe('symbolItems', () => {
  it('names functions, methods and fields as the code writes them', () => {
    deepStrictEqual(itemsIn(lines('entity = {}', 'function entity:update() end', 'function entity.new() end', 'vector = { x = 0, add = function(a, b) end }',
      'function new_game()', '  local game = { health = 3 }', '  function game.enter_boss_phase() end', '  game.state = { level = 1 }', '  return game', 'end')),
    [ 'entity [] 1:0', 'entity:update() [] 2:16', 'entity.new() [] 3:16', 'vector [] 4:0', 'vector.x [] 4:11', 'vector.add() [] 4:18', 'new_game() [] 5:9',
      'game [new_game] 6:8', 'game.health [new_game] 6:17', 'game.enter_boss_phase() [new_game] 7:16', 'game.state [new_game] 8:7',
      'game.state.level [new_game] 8:17' ]);
  });

  it('names a method the same way whether or not it is grouped under its table', () => {
    deepStrictEqual(itemsIn(lines('entity = {}', 'function entity:update() end', 'function spawn()', '  function entity:draw() end', 'end')),
      [ 'entity [] 1:0', 'entity:update() [] 2:16', 'spawn() [] 3:9', 'entity:draw() [spawn] 4:18' ]);
  });

  it('leaves out anonymous functions, labels, tables only written to and a local that stands for a function', () => {
    deepStrictEqual(itemsIn(lines('t.k = 1', 'a.b.c = 2', 'local f', 'f = function() end', 'local g', 'g = function() end', 'g.x = 1',
      'local player = new_player { on_damaged = function() end }', 'function update_enemies()', '  foreach(es, function(e)', '    local d = 1',
      '    ::skip::', '  end)', 'end')),
    [ 't.k [] 1:2', 'a.b.c [] 2:4', 'f() [] 4:0', 'g() [] 6:0', 'g.x [] 7:2', 'player [] 8:6', 'on_damaged() [player] 8:28', 'update_enemies() [] 9:9',
      'd [update_enemies] 11:10' ]);
  });

  it('lists self\'s fields under the method\'s table', () => {
    deepStrictEqual(itemsIn(lines('guy = {}', 'function guy:init()', '  self.hp = 3', '  self.timer.float = 30', 'end')),
      [ 'guy [] 1:0', 'guy:init() [] 2:13', 'guy.hp [] 3:7', 'guy.timer.float [] 4:13' ]);
  });

  it('places items on their names in a CRLF .p8 cart', () => {
    deepStrictEqual(itemsIn('pico-8 cartridge // http://www.pico-8.com\r\nversion 42\r\n__lua__\r\nentity = {}\r\nfunction entity:update()\r\n  local speed = 2\r\nend\r\n__gfx__\r\n0000\r\n'),
      [ 'entity [] 4:0', 'entity:update() [] 5:16', 'speed [entity:update] 6:8' ]);
  });

  it('names a member of a function with the function\'s name', () => {
    deepStrictEqual(itemsIn(lines('function f() end', 'f.x = 1')), [ 'f() [] 1:9', 'f.x [] 2:2' ]);
  });

  it('lists a file included twice once', () => {
    deepStrictEqual([ ...symbolItems(analyzeCode(lines('#include lib.lua', '#include lib.lua'), { 'lib.lua': 'function helper() end' }).analysis).values() ]
      .map(items => items.map(shown)), [[ 'helper() [] 1:9' ]]);
  });

  it('keeps the items until the analysis is replaced', () => {
    const a = analyzeCode('x = 1').analysis;
    strictEqual(symbolItems(a), symbolItems(a));
    notStrictEqual(symbolItems(analyzeCode('x = 1').analysis), symbolItems(a));
  });

  it('lists each outline entry of the test carts once, on its own name', () => {
    let total = 0;
    for (const name of TEST_CARTS) {
      const code = getTestFileContents(name);
      const a = analyzeCode(code);
      const items = symbolItems(a.analysis).get(testFile().fileURL) ?? [];
      total += items.length;
      for (const item of items) {
        strictEqual(code.slice(item.selectionLoc.start.index, item.selectionLoc.end.index), item.own, `${name}: ${shown(item)}`);
      }
      const places = new Set<string>();
      for (const item of items) {
        const place = `${item.label} ${item.selectionLoc.start.index}`;
        strictEqual(places.has(place), false, `${name}: ${shown(item)} twice`);
        places.add(place);
      }
      const check = (symbols: CodeSymbol[]) => {
        for (const s of symbols) {
          if (s.name !== AnonymousFunctionName && s.type !== CodeSymbolType.Label) {
            const own = s.name.split(/[.:]/).pop();
            const found = items.filter(item => item.selectionLoc.start.index === s.selectionLoc.start.index && item.own === own);
            if (found.length === 0) {
              // A table this file only writes fields to.
              deepStrictEqual([ s.type, s.children.length > 0 ], [ CodeSymbolType.Table, true ], `${name}: ${s.name} not listed`);
            } else {
              strictEqual(found.length, 1, `${name}: ${s.name} listed ${found.length} times`);
            }
          }
          check(s.children);
        }
      };
      check(outlineFor(a.analysis, testFile()));
    }
    strictEqual(total, 1275);
  });
});

describe('searchSymbols', () => {
  it('matches the query\'s characters in order and ranks exact, then prefix, then substring matches', () => {
    const pool = allItems(lines('function update() end', 'player = {}', 'function player:update() end', 'function player:upd_pos() end',
      'function draw_update_bar() end', 'function do_update() end', 'function up() end', 'uprate = 1', 'function u_p_d() end'));
    const labels = (q: string) => searchSymbols(pool, q).map(item => item.label);
    for (const q of [ 'upd', 'UPD' ]) {
      deepStrictEqual(labels(q), [ 'update()', 'player:update()', 'player:upd_pos()', 'do_update()', 'draw_update_bar()', 'u_p_d()' ], q);
    }
    deepStrictEqual(labels('player:upd'), [ 'player:update()', 'player:upd_pos()' ]);
    for (const q of [ 'u p', 'up\u2026', '"up"' ]) {
      deepStrictEqual(labels(q), [ 'up()', 'update()', 'uprate', 'player:update()', 'player:upd_pos()', 'do_update()', 'draw_update_bar()', 'u_p_d()' ], q);
    }
    for (const q of [ '', '  ', '*' ]) {
      deepStrictEqual(labels(q), [], q);
    }
  });

  it('keeps the best 1000', () => {
    const many = allItems(Array.from({ length: 1100 }, (_, i) => `v${i} = ${i}`).join('\n') + '\nfunction v() end');
    const found = searchSymbols(many, 'v');
    strictEqual(found.length, 1000);
    deepStrictEqual(found.slice(0, 3).map(i => i.label), [ 'v()', 'v0', 'v1' ]);
    deepStrictEqual(found.slice(-2).map(i => i.label), [ 'v997', 'v998' ]);
  });
});
