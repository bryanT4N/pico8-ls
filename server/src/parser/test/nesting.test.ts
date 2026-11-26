import * as assert from 'assert';
import { formatError, parse } from './test-utils';

const errorsOf = (code: string) => parse(code).errors.map(formatError);
const nested = (open: string, inner: string, close: string, n: number) => open.repeat(n) + inner + close.repeat(n);

// PICO-8, as Lua 5.2, counts a level for each statement and each subexpression, and allows 200.
describe('nesting limit', () => {
  it('takes 198 parentheses around a value and reports 199', () => {
    assert.deepStrictEqual(errorsOf('x = ' + nested('(', '1', ')', 198)), []);
    assert.deepStrictEqual(errorsOf('x = ' + nested('(', '1', ')', 199)), [ 'main_test_file 1:203 too many nested levels (limit is 200) near \'1\'' ]);
  });

  it('counts a level for each .. of a chain', () => {
    const joined = (n: number) => 'x = ' + Array.from({ length: n }, () => 'a').join('..');
    assert.deepStrictEqual(errorsOf(joined(199)), []);
    assert.deepStrictEqual(errorsOf(joined(200)), [ 'main_test_file 1:601 too many nested levels (limit is 200) near \'a\'' ]);
  });

  it('counts a level for each nested statement', () => {
    assert.deepStrictEqual(errorsOf(nested('if a then\n', 'x = 1\n', 'end\n', 198)), []);
    assert.deepStrictEqual(errorsOf(nested('if a then\n', 'x = 1\n', 'end\n', 199)), [ 'main_test_file 200:4 too many nested levels (limit is 200) near \'1\'' ]);
    assert.deepStrictEqual(errorsOf(nested('function f()\n', '', 'end\n', 200)), []);
    assert.deepStrictEqual(errorsOf(nested('function f()\n', '', 'end\n', 201)), [
      'main_test_file 201:0 too many nested levels (limit is 200) near \'function\'',
      'main_test_file 402:0 unexpected keyword \'end\' near \'<eof>\'',
    ]);
  });

  // Lua 5.2 looks for `)`, `}` or the end of the block before it parses an
  // expression there, so an empty argument list, an empty table or a bare
  // `return` adds no level.
  it('counts no level for an expression that is not there', () => {
    assert.deepStrictEqual(errorsOf(nested('if a then\n', 'f()\n', 'end\n', 199)), []);
    assert.deepStrictEqual(errorsOf(nested('if a then\n', 'f{}\n', 'end\n', 199)), []);
    assert.deepStrictEqual(errorsOf('x = ' + nested('(', '{}', ')', 198)), []);
    assert.deepStrictEqual(errorsOf('x = ' + Array.from({ length: 198 }, () => 'a').join('..') + '..f()'), []);
    assert.deepStrictEqual(errorsOf(nested('if a then\n', 'repeat return until a\n', 'end\n', 198)), []);
    assert.deepStrictEqual(errorsOf(nested('if a then\n', 'if b then return else y() end\n', 'end\n', 198)), []);
    assert.deepStrictEqual(errorsOf(nested('if a then\n', 'f(1)\n', 'end\n', 199)), [ 'main_test_file 200:2 too many nested levels (limit is 200) near \'1\'' ]);
  });

  it('counts a level for each target of an assignment after the first', () => {
    const targets = (n: number) => Array.from({ length: n }, (_, i) => 'a' + i).join(', ') + ' = 1';
    assert.deepStrictEqual(errorsOf(targets(200)), []);
    assert.deepStrictEqual(errorsOf(targets(201)), [ 'main_test_file 1:1095 too many nested levels (limit is 200) near \'=\'' ]);
    assert.deepStrictEqual(errorsOf('function f()\n' + targets(199) + '\nend'), []);
    assert.deepStrictEqual(errorsOf('function f()\n' + targets(200) + '\nend'), [ 'main_test_file 2:1089 too many nested levels (limit is 200) near \'=\'' ]);
  });
});
