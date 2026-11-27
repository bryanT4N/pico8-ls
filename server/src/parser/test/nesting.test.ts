import * as assert from 'assert';
import { formatError, parse, TestFilesResolver } from './test-utils';

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

const list = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => prefix + i);
const names = (prefix: string, n: number) => list(prefix, n).join(', ');
const cartErrors = (code: string, files: Record<string, string> = {}) =>
  parse(code, { filename: 'main.p8', includeFileResolver: new TestFilesResolver(files) }).errors.map(formatError);

// PICO-8, as Lua 5.2, allows 200 local variables in scope at once in a function and 255 upvalues; the main function of
// a cart starts with 59 locals of PICO-8's.
describe('local variable and upvalue limits', () => {
  it('reports more than 200 local variables in scope in a function at once, and more than 141 in a cart\'s main function, as PICO-8 does', () => {
    assert.deepStrictEqual(cartErrors('local ' + names('a', 141) + ' = 1'), []);
    assert.deepStrictEqual(cartErrors('local ' + names('a', 142) + ' = 1'), [ 'main.p8 1:742 too many local variables (limit is 200) in main function near \'=\'' ]);
    assert.deepStrictEqual(cartErrors(list('a', 142).map(name => 'local ' + name + ' = 1').join('\n')),
      [ 'main.p8 142:6 too many local variables (limit is 200) in main function near \'=\'' ]);
    assert.deepStrictEqual(cartErrors('function f()\n  local ' + names('a', 200) + '\nend'), []);
    assert.deepStrictEqual(cartErrors('function f()\n  local ' + names('a', 201) + '\nend'), [ 'main.p8 2:1098 too many local variables (limit is 200) in function at line 1 near \'end\'' ]);
    assert.deepStrictEqual(cartErrors('local function g() end\nlocal ' + names('a', 141)), [ 'main.p8 2:736 too many local variables (limit is 200) in main function near \'<eof>\'' ]);
    assert.deepStrictEqual(cartErrors('local ' + names('a', 142) + '\nlocal ' + names('b', 5)), [ 'main.p8 1:742 too many local variables (limit is 200) in main function near \'local\'' ]);
    assert.deepStrictEqual(errorsOf('local ' + names('a', 200) + ' = 1'), []);
    assert.deepStrictEqual(errorsOf('local ' + names('a', 201) + ' = 1'), [ 'main_test_file 1:1096 too many local variables (limit is 200) in main function near \'=\'' ]);
  });

  it('counts each parameter, and self, as a local variable, but not ...', () => {
    assert.deepStrictEqual(cartErrors('function f(' + names('p', 200) + ', ...)\nend'), []);
    assert.deepStrictEqual(cartErrors('function f(' + names('p', 201) + ')\nend'), [ 'main.p8 1:1101 too many local variables (limit is 200) in function at line 1 near \')\'' ]);
    assert.deepStrictEqual(cartErrors('t = {}\nfunction t:m(' + names('p', 199) + ')\nend'), []);
    assert.deepStrictEqual(cartErrors('t = {}\nfunction t:m(' + names('p', 200) + ')\nend'), [ 'main.p8 2:1097 too many local variables (limit is 200) in function at line 2 near \')\'' ]);
  });

  it('counts 3 hidden variables for a for loop besides its names, and frees a block\'s variables at its end', () => {
    assert.deepStrictEqual(cartErrors('local ' + names('a', 137) + '\nfor i = 1, 2 do end'), []);
    assert.deepStrictEqual(cartErrors('local ' + names('a', 138) + '\nfor i = 1, 2 do end'), [ 'main.p8 2:4 too many local variables (limit is 200) in main function near \'=\'' ]);
    assert.deepStrictEqual(cartErrors('local ' + names('a', 136) + '\nfor k, v in pairs(t) do end'), []);
    assert.deepStrictEqual(cartErrors('local ' + names('a', 137) + '\nfor k, v in pairs(t) do end'), [ 'main.p8 2:7 too many local variables (limit is 200) in main function near \'in\'' ]);
    assert.deepStrictEqual(cartErrors('do\n  local ' + names('a', 100) + '\nend\nlocal ' + names('b', 100)), []);
    assert.deepStrictEqual(cartErrors('for i = 1, 2 do\n  local ' + names('a', 137) + '\nend\nlocal ' + names('b', 141)), []);
  });

  it('names the file of a function that starts in another file than the variable one too many', () => {
    assert.deepStrictEqual(cartErrors('#include f.lua\n  local ' + names('a', 201) + '\nend', { 'f.lua': 'function f()\n' }),
      [ 'main.p8 2:1098 too many local variables (limit is 200) in function at line 1 in f.lua near \'end\'' ]);
  });

  // PICO-8 holds a register of the target in a hidden local until the end of the block.
  it('counts the hidden local variables of a compound assignment as PICO-8 does', () => {
    const inFunction = (n: number, statement: string) => `local u\nfunction f()\nlocal t, k\nlocal ${names('a', n - 2)}\n${statement}\nend`;
    for (const free of [ 'a += 1', 'u += 1', 'g += 1', 't.x += 1', 'u.x += 1', 't[k] += 1', 'u[k] += 1', 't[1 + 1] += 1', 't["s"] += 1', '(t).x += 1', '(t) += 1' ]) {
      assert.deepStrictEqual(cartErrors(inFunction(200, free)), [], free);
    }
    for (const one of [ 'g.x += 1', 't.x.y += 1', 't[k].y += 1', 'h().x += 1', 'h() += 1', 't:m() += 1', 't[k + 1] += 1', 't[u] += 1', 't[g] += 1', 't[#t] += 1' ]) {
      assert.deepStrictEqual(cartErrors(inFunction(199, one)), [], one);
      assert.deepStrictEqual(cartErrors(inFunction(200, one)), [ `main.p8 5:${one.indexOf('=') - 1} too many local variables (limit is 200) in function at line 2 near '${one.slice(one.indexOf('=') - 1, one.indexOf('=') + 1)}'` ], one);
    }
    assert.deepStrictEqual(cartErrors(inFunction(198, 'g[g] += 1')), [], 'g[g]');
    assert.deepStrictEqual(cartErrors(inFunction(199, 'g[g] += 1')), [ 'main.p8 5:5 too many local variables (limit is 200) in function at line 2 near \'+=\'' ], 'g[g]');
    assert.deepStrictEqual(cartErrors(inFunction(199, 'g.x += 1\ng.y ..= "s"')), [ 'main.p8 6:4 too many local variables (limit is 200) in function at line 2 near \'..=\'' ]);
    assert.deepStrictEqual(cartErrors(inFunction(199, 'do g.x += 1 end\nif (k) g.y += 1\ng.z += 1')), []);
  });

  it('reports more than 255 upvalues in a function, as PICO-8 does', () => {
    const counted = (from: number, n: number) => Array.from({ length: n }, (_, i) => 'u' + (from + i));
    const reading = (n: number, between = '', more = '') => 'function o1()\nlocal ' + counted(1, 100).join(',') + '\nfunction o2()\nlocal ' + counted(101, 100).join(',')
      + '\nfunction o3()\nlocal ' + counted(201, 100).join(',') + `\n${between}function inner()\nreturn ` + counted(1, n).join('+') + `${more}\nend\nend\nend\nend${between ? '\nend' : ''}`;
    assert.deepStrictEqual(cartErrors(reading(255)), []);
    assert.deepStrictEqual(cartErrors(reading(256)), [ 'main.p8 8:1174 too many upvalues (limit is 255) in function at line 7 near \'end\'' ]);
    assert.deepStrictEqual(cartErrors(reading(254, '', '+x+y')), []);
    assert.deepStrictEqual(cartErrors(reading(255, '', '+x')), [ 'main.p8 8:1174 too many upvalues (limit is 255) in function at line 7 near \'end\'' ]);
    assert.deepStrictEqual(cartErrors(reading(255, 'function m()\n')), [ 'main.p8 9:1169 too many upvalues (limit is 255) in function at line 7 near \'end\'' ]);
  });

  it('takes the API functions PICO-8 makes locals of a cart\'s main function as upvalues of a function that uses them', () => {
    const reading = (n: number, more: string) => 'local ' + names('a', 141) + '\nfunction f()\nlocal ' + names('b', 200) + '\nfunction g()\nreturn '
      + [ ...list('a', 141), ...list('b', n - 141) ].join('+') + more + '\nend\nend';
    assert.deepStrictEqual(cartErrors(reading(254, '+sin')), []);
    assert.deepStrictEqual(cartErrors(reading(254, '+sin+cos')), [ 'main.p8 5:1061 too many upvalues (limit is 255) in function at line 4 near \'end\'' ]);
    assert.deepStrictEqual(parse('local ' + names('a', 141) + '\nfunction f()\nlocal ' + names('b', 200) + '\nfunction g()\nreturn '
      + [ ...list('a', 141), ...list('b', 113) ].join('+') + '+sin+cos\nend\nend').errors.map(formatError), []);
  });
});
