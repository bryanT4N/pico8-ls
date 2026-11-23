import * as assert from 'assert';
import { parse, getTestFileContents, TEST_CARTS } from './test-utils';
import { outlineOf, allSymbols } from './outline-utils';
import { CodeSymbolType } from '../symbols';

describe('outline on the test carts', () => {
  for (const name of TEST_CARTS) {
    it(`builds a valid outline for ${name}`, () => {
      const { symbols } = parse(getTestFileContents(name));
      assert.ok(symbols.length > 0, 'the outline is empty');
      for (const s of allSymbols(symbols)) {
        assert.ok(s.loc.start.index <= s.selectionLoc.start.index && s.selectionLoc.end.index <= s.loc.end.index,
          `${s.name}: selection outside range`);
        if (s.type === CodeSymbolType.Table || s.type === CodeSymbolType.Array) {
          const data = s.children.filter(c => c.type !== CodeSymbolType.Method && c.type !== CodeSymbolType.Function);
          assert.strictEqual(new Set(data.map(c => c.name)).size, data.length, `${s.name}: a member is listed twice`);
        }
      }
    });
  }

  it('matches the design example', () => {
    assert.strictEqual(outlineOf([
      'player = { x = 64, y = 64 }', 'enemies = {}',
      'function _init()  score = 0  player.hp = 3  end',
      'function player:update()  self.x += 1  end',
      'function spawn(x, y)  local e = { x = x, y = y }  e.hp = 2  add(enemies, e)  end',
      'function _update()  for e in all(enemies) do e.x -= 1 end  end' ].join('\n')),
    [ 'player [Table]', '  x [Field]', '  y [Field]', '  hp [Field]', 'enemies [Table]', '_init() [Function]',
      'score [Variable]', 'player:update() [Method]', 'spawn(x,y) [Function]', '  e [Table]', '    x [Field]',
      '    y [Field]', '    hp [Field]', '_update() [Function]' ].join('\n'));
  });

  it('lists the closures of the player_bullet factory', () => {
    const { symbols } = parse(getTestFileContents('beetrootpaul-dart-07/player_bullet.lua'));
    const factory = symbols.find(s => s.name === 'new_player_bullet')!;
    assert.deepStrictEqual(factory.children.map(c => `${c.name}${c.detail ?? ''} [${c.type}]`),
      [ 'is_destroyed [Variable]', 'bullet_sprite [Variable]', 'movement [Variable]', 'has_finished() [Method]',
        'collision_circle() [Method]', 'destroy() [Method]', '_draw() [Method]' ]);
  });

  it('groups the vector methods of low.lua under vector, and keeps slash methods in place', () => {
    const { symbols } = parse(getTestFileContents('low.lua'));
    const vector = symbols.find(s => s.name === 'vector')!;
    assert.deepStrictEqual(vector.children.filter(c => c.type === CodeSymbolType.Method).map(c => c.name + c.detail),
      [ '__add(b)', '__sub(b)', '__mul(m)', '__div(d)', '__unm()', 'dot(v2)', 'norm()', 'rot()', 'round()', 'len()', '__len()', 'str()' ]);
    assert.ok(!symbols.some(s => s.name.startsWith('vector:')));
    assert.deepStrictEqual(symbols.filter(s => s.name.startsWith('slash:')).map(s => s.name + s.detail),
      [ 'slash:idle(t)', 'slash:render(p)', 'slash:collide(o)' ]);
  });

  it('groups the methods of 31 of the 36 classes in low.lua', () => {
    const { symbols } = parse(getTestFileContents('low.lua'));
    const cbox = symbols.find(s => s.name === 'cbox')!;
    assert.strictEqual(cbox.type, CodeSymbolType.Table);
    assert.strictEqual(cbox.children.filter(c => c.type === CodeSymbolType.Method).length, 6);
    const inPlace = symbols.filter(s => s.type === CodeSymbolType.Method && /[:.]/.test(s.name));
    assert.strictEqual(inPlace.length, 13);
    assert.deepStrictEqual([ ...new Set(inPlace.map(s => s.name.split(/[:.]/)[0])) ],
      [ 'water', 'slash', 'title', 'item', 'bench' ]);
    const g = symbols.filter(s => s.children.some(c => c.type === CodeSymbolType.Method));
    assert.strictEqual(g.length, 31);
    assert.strictEqual(g.flatMap(s => s.children).filter(c => c.type === CodeSymbolType.Method).length, 91);
  });
});
