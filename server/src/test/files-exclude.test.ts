import { deepStrictEqual, strictEqual as eq } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { excludeOf } from '../files-exclude';

describe('excludeOf', () => {
  const hiddenBy = (setting: unknown) => {
    const exclude = excludeOf(setting)!;
    return (relativePath: string) => exclude(relativePath, path.join(path.resolve('/ws'), ...relativePath.split('/')));
  };

  it('reads a pattern as VS Code does: ** for any number of folders, * within a name, relative to the workspace folder', () => {
    const hidden = hiddenBy({ '**/runs': true, 'build': true, '**/*.tmp.lua': true, 'gen/**': true, 'off': false });
    deepStrictEqual([ 'runs', 'a/runs', 'a/b/runs', 'build', 'x.tmp.lua', 'a/x.tmp.lua', 'gen', 'gen/a.lua' ].map(hidden),
      [ true, true, true, true, true, true, true, true ]);
    deepStrictEqual([ 'off', 'a/build', 'runs2', 'a/runsx', 'x.lua', 'general' ].map(hidden), [ false, false, false, false, false, false ]);
  });

  it('reads ?, {a,b}, [a-z] and [!a], and takes other characters as they are', () => {
    const hidden = hiddenBy({ 'a?.lua': true, '{x,y}.p8': true, 'n[0-9].lua': true, 'm[!a].lua': true, 'f(1).lua': true });
    deepStrictEqual([ 'ab.lua', 'a.lua', 'x.p8', 'y.p8', 'z.p8', 'n5.lua', 'nx.lua', 'mb.lua', 'ma.lua', 'f(1).lua', 'f1.lua' ].map(hidden),
      [ true, false, true, true, false, true, false, true, false, true, false ]);
  });

  it('hides a file by a when clause only when the sibling it names is there', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pico8-ls-exclude-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.lua'), '');
      fs.writeFileSync(path.join(dir, 'a.p8'), '');
      fs.writeFileSync(path.join(dir, 'b.lua'), '');
      const exclude = excludeOf({ '**/*.lua': { when: '$(basename).p8' } })!;
      eq(exclude('a.lua', path.join(dir, 'a.lua')), true);
      eq(exclude('b.lua', path.join(dir, 'b.lua')), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives nothing for a setting that hides nothing', () => {
    deepStrictEqual([ undefined, null, 1, {}, { '**/runs': false }].map(excludeOf), [ undefined, undefined, undefined, undefined, undefined ]);
  });
});
