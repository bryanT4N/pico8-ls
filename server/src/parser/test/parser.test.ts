import { strictEqual as eq } from 'assert';
import { Statement } from '../statements';
import { bounds, deepEquals, deepEqualsAST, formatError, getTestFileContents, MockFileResolver, parse, TestFilesResolver } from './test-utils';

describe('Parser', () => {
  it('parses basic assignment statement', () => {
    const { block: { body } } = parse('i = 1');
    deepEquals(body, [
      {
        type: 'AssignmentStatement',
        operator: '=',
        variables: [{
          type: 'Identifier',
          name: 'i',
          loc: bounds(1, 0, 1, 1),
        }],
        init: [{
          type: 'NumericLiteral',
          value: 1,
          loc: bounds(1, 4, 1, 5),
        }],
        loc: bounds(1, 0, 1, 5),
      },
    ]);
  });

  it('parses expression with parentheses', () => {
    const { block: { body } } = parse('a = 1 - (t + 2)^3');
    deepEquals(body, [
      {
        loc: bounds(1, 0, 1, 17),
        type: 'AssignmentStatement',
        operator: '=',
        init: [
          {
            loc: bounds(1, 4, 1, 17),
            type: 'BinaryExpression',
            operator: '-',
            left: {
              loc: bounds(1, 4, 1, 5),
              type: 'NumericLiteral',
              value: 1,
              raw: '1',
            },
            right: {
              loc: bounds(1, 8, 1, 17),
              type: 'BinaryExpression',
              operator: '^',
              left: {
                loc: bounds(1, 9, 1, 14),
                type: 'BinaryExpression',
                operator: '+',
                left: {
                  loc: bounds(1, 9, 1, 10),
                  type: 'Identifier',
                  name: 't',
                },
                right: {
                  loc: bounds(1, 13, 1, 14),
                  type: 'NumericLiteral',
                  value: 2,
                  raw: '2',
                },
              },
              right: {
                loc: bounds(1, 16, 1, 17),
                type: 'NumericLiteral',
                value: 3,
                raw: '3',
              },
            },
          },
        ],
      },
    ]);
  });

  it('parses basic function declaration', () => {
    const { block } = parse('function f(x)\nreturn x + 1\nend');
    deepEquals(block, {
      type: 'Block',
      body: [{
        type: 'FunctionDeclaration',
        isLocal: false,
        identifier: {
          type: 'Identifier',
          name: 'f',
          loc: bounds(1, 9, 1, 10),
        },
        parameters: [{
          type: 'Identifier',
          name: 'x',
          loc: bounds(1, 11, 1, 12),
        }],
        block: {
          type: 'Block',
          body: [{
            type: 'ReturnStatement',
            arguments: [{
              type: 'BinaryExpression',
              operator: '+',
              left: { type: 'Identifier', name: 'x', loc: bounds(2, 7, 2, 8) },
              right: { type: 'NumericLiteral', value: 1, loc: bounds(2, 11, 2, 12) },
              loc: bounds(2, 7, 2, 12),
            }],
            loc: bounds(2, 0, 2, 12),
          }],
        },
      }],
      loc: bounds(1, 0, 3, 3),
    });
  });

  it('parses function that returns another function', () => {
    const { block } = parse(`
function f(x)
  return function()
    print(x + 1)
  end
end
`.trim());

    deepEquals(block, {
      type: 'Block',
      body: [{
        type: 'FunctionDeclaration',
        isLocal: false,
        identifier: {
          type: 'Identifier',
          name: 'f',
          loc: bounds(1, 9, 1, 10),
        },
        parameters: [{
          type: 'Identifier',
          name: 'x',
          loc: bounds(1, 11, 1, 12),
        }],
        block: {
          type: 'Block',
          body: [{
            type: 'ReturnStatement',
            arguments: [{
              type: 'FunctionDeclaration',
              isLocal: false,
              parameters: [],
              block: {
                type: 'Block',
                body: [{
                  type: 'CallStatement',
                  expression: {
                    type: 'CallExpression',
                    base: { type: 'Identifier', name: 'print' },
                    arguments: [{
                      type: 'BinaryExpression',
                      operator: '+',
                      left: { type: 'Identifier', name: 'x' },
                      right: { type: 'NumericLiteral', value: 1 },
                    }],
                  },
                }],
              },
            }],
          }],
        },
      }],
    });
  });

  it('parses function declaration with multiple args', () => {
    deepEqualsAST('function fn(x, y, z) return end', [{
      type: 'FunctionDeclaration',
      isLocal: false,
      identifier: { name: 'fn' },
      parameters: [
        { type: 'Identifier', name: 'x' },
        { type: 'Identifier', name: 'y' },
        { type: 'Identifier', name: 'z' },
      ],
      block: {
        body: [{
          type: 'ReturnStatement',
          arguments: [],
        }],
      },
    }]);
  });

  it('parses statements ending in semicolon', () => {
    // This is a snippet from Celeste 2 that gave some parser issues. Semicolons
    // are supposed to be fine ... idk why PICO-8 allows them exactly but they
    // shouldn't mess up parsing.
    const text = `
object = {}
object.speed_x = 0;
object.speed_y = 0;
object.remainder_x = 0;
object.remainder_y = 0;
`.trim();
    const result = parse(text);
    deepEquals(result.errors, []);
  });

  it('parses call statement', () => {
    deepEqualsAST('print("hi")', [{
      type: 'CallStatement',
      expression: {
        type: 'CallExpression',
        base: { type: 'Identifier', name: 'print' },
        arguments: [{ type: 'StringLiteral', value: 'hi' }],
      },
    }]);
  });

  it('parses if ... then statement', () => {
    const printHiBlock = {
      type: 'Block',
      body: [{
        type: 'CallStatement',
        expression: {
          type: 'CallExpression',
          base: { type: 'Identifier', name: 'print' },
          arguments: [{ type: 'StringLiteral', value: 'hi' }],
        },
      }],
    };

    const input = `
if false then
  print("hi")
  -- end comment 1
elseif false then
  print("hi")
  -- end comment 2
else
  print("hi")
  -- end comment 3
end`.trim();
    deepEqualsAST(input, [{
      type: 'IfStatement',
      clauses: [
        {
          type: 'IfClause',
          condition: { type: 'BooleanLiteral', value: false },
          block: { ...printHiBlock, loc: bounds(2, 2, 4, 6) },
        },
        {
          type: 'ElseifClause',
          condition: { type: 'BooleanLiteral', value: false },
          block: { ...printHiBlock, loc: bounds(5, 2, 7, 4) },
        },
        {
          type: 'ElseClause',
          block: { ...printHiBlock, loc: bounds(8, 2, 10, 3) },
        },
      ],
    }]);
  });

  it('parses if ... do statement', () => {
    const printHiBlock = {
      type: 'Block',
      body: [{
        type: 'CallStatement',
        expression: {
          type: 'CallExpression',
          base: { type: 'Identifier', name: 'print' },
          arguments: [{ type: 'StringLiteral', value: 'hi' }],
        },
      }],
    };

    const input = `
if false do
  print("hi")
  -- end comment 1
elseif false do
  print("hi")
  -- end comment 2
else
  print("hi")
  -- end comment 3
end`.trim();
    deepEqualsAST(input, [{
      type: 'IfStatement',
      clauses: [
        {
          type: 'IfClause',
          condition: { type: 'BooleanLiteral', value: false },
          block: { ...printHiBlock, loc: bounds(2, 2, 4, 6) },
        },
        {
          type: 'ElseifClause',
          condition: { type: 'BooleanLiteral', value: false },
          block: { ...printHiBlock, loc: bounds(5, 2, 7, 4) },
        },
        {
          type: 'ElseClause',
          block: { ...printHiBlock, loc: bounds(8, 2, 10, 3) },
        },
      ],
    }]);
  });

  it('parses one-line if statement', () => {
    deepEqualsAST('if (false) print("hi")\ni = 1', [
      {
        type: 'IfStatement',
        clauses: [{
          type: 'IfClause',
          condition: { type: 'BooleanLiteral', value: false },
          block: {
            body: [{
              type: 'CallStatement',
              expression: {
                type: 'CallExpression',
                base: { type: 'Identifier', name: 'print' },
                arguments: [{ type: 'StringLiteral', value: 'hi' }],
              },
            }],
          },
        },
        ],
      },
      {
        type: 'AssignmentStatement',
        operator: '=',
        variables: [{
          type: 'Identifier',
          name: 'i',
        }],
        init: [{
          type: 'NumericLiteral',
          value: 1,
        }],
      },
    ]);
  });

  it('parses one-line if statement with a significant newline', () => {
    // If it doesn't treat the newline as significant, it'll interpret it as "return i" instead of just "return"
    deepEqualsAST('if (false) return\ni += 1', [
      {
        type: 'IfStatement',
        clauses: [{
          type: 'IfClause',
          condition: { type: 'BooleanLiteral', value: false },
          block: { body: [{ type: 'ReturnStatement', arguments: [] }] },
        }],
      },
      {
        type: 'AssignmentStatement',
        operator: '+=',
        variables: [{
          type: 'Identifier',
          name: 'i',
        }],
        init: [{
          type: 'NumericLiteral',
          value: 1,
        }],
      },
    ]);
  });

  it('parses one-line if statement with else', () => {
    const input = 'if (false) a() else b = 1';
    const { errors, block: { body } } = parse(input);

    deepEquals(errors, []);

    deepEquals(body, [{
      type: 'IfStatement',
      oneLine: true,
      clauses: [
        {
          type: 'IfClause',
          condition: {},
          block: { body: [{ type: 'CallStatement' }] },
        },
        {
          type: 'ElseClause',
          block: { body: [{ type: 'AssignmentStatement' }] },
        },
      ],
    }]);
  });

  it('parses multiple statements in each clause of a one-line if statement (#78)', () => {
    const input = 'if (a) b() c = 1 else d() e = 2\nf()';
    const { errors, block: { body } } = parse(input);

    deepEquals(errors, []);

    deepEquals(body, [
      {
        type: 'IfStatement',
        oneLine: true,
        clauses: [
          {
            type: 'IfClause',
            block: { body: [{ type: 'CallStatement' }, { type: 'AssignmentStatement' }] },
          },
          {
            type: 'ElseClause',
            block: { body: [{ type: 'CallStatement' }, { type: 'AssignmentStatement' }] },
          },
        ],
      },
      { type: 'CallStatement' },
    ]);
  });

  it('parses nested one-line statements, ending them all at the end of the line', () => {
    const input = 'if (a) b() if (c) d() e()\nf()';
    const { errors, block: { body } } = parse(input);

    deepEquals(errors, []);

    deepEquals(body, [
      {
        type: 'IfStatement',
        clauses: [{
          type: 'IfClause',
          block: {
            body: [
              { type: 'CallStatement' },
              {
                type: 'IfStatement',
                clauses: [{
                  type: 'IfClause',
                  block: { body: [{ type: 'CallStatement' }, { type: 'CallStatement' }] },
                }],
              },
            ],
          },
        }],
      },
      { type: 'CallStatement' },
    ]);
  });

  it('parses a one-line if statement containing a multi-line statement', () => {
    const input = 'if (a) if b then c() elseif d then e() end f()\ng()';
    const { errors, block: { body } } = parse(input);

    deepEquals(errors, []);

    deepEquals(body, [
      {
        type: 'IfStatement',
        oneLine: true,
        clauses: [{
          type: 'IfClause',
          block: { body: [{ type: 'IfStatement', oneLine: false }, { type: 'CallStatement' }] },
        }],
      },
      { type: 'CallStatement' },
    ]);
  });

  it('parses PICO-8 one-line if statement with significant newline and multiline `else`', () => {
    const input = `
if(v.x<-130) del(b,v) else
  v.x-=2
end
`.trim();

    const { errors, block: { body } } = parse(input);

    deepEquals(errors, []);

    deepEquals(body, [{
      type: 'IfStatement',
      oneLine: true,
      clauses: [
        {
          type: 'IfClause',
          condition: {},
          block: {},
        },
        {
          type: 'ElseClause',
          block: {},
        },
      ],
    }]);
  });

  it('parses a regular while statement', () => {
    deepEqualsAST('while a < 1 do a += 1 end', [
      {
        type: 'WhileStatement',
        condition: {
          type: 'BinaryExpression',
          operator: '<',
          left: { type: 'Identifier', name: 'a' },
          right: { type: 'NumericLiteral', value: 1 },
        },
        block: {
          type: 'Block',
          body: [
            {
              type: 'AssignmentStatement',
              variables: [{ type: 'Identifier', name: 'a' }],
              operator: '+=',
              init: [{ type: 'NumericLiteral', value: 1 }],
            },
          ],
        },
      }]);
  });

  it('parses a one-line while statement', () => {
    deepEqualsAST('while (a < 1) a += 1', [
      {
        type: 'WhileStatement',
        condition: {
          type: 'BinaryExpression',
          operator: '<',
          left: { type: 'Identifier', name: 'a' },
          right: { type: 'NumericLiteral', value: 1 },
        },
        block: {
          type: 'Block',
          body: [
            {
              type: 'AssignmentStatement',
              variables: [{ type: 'Identifier', name: 'a' }],
              operator: '+=',
              init: [{ type: 'NumericLiteral', value: 1 }],
            },
          ],
        },
      }]);
  });

  it('ends a one-line while statement at the end of the line (#80)', () => {
    const { block: { body }, errors } = parse('while (true) print("hello!")\notherstatement = 5');
    deepEquals(errors, []);
    deepEquals(body, [
      {
        type: 'WhileStatement',
        block: {
          type: 'Block',
          body: [{ type: 'CallStatement' }],
        },
      },
      {
        type: 'AssignmentStatement',
        variables: [{ type: 'Identifier', name: 'otherstatement' }],
      },
    ]);
  });

  it('parses multiple statements in a one-line while statement', () => {
    const { block: { body }, errors } = parse('while (a < 5) a += 1 print(a)\nb = 1');
    deepEquals(errors, []);
    deepEquals(body, [
      {
        type: 'WhileStatement',
        block: {
          type: 'Block',
          body: [{ type: 'AssignmentStatement' }, { type: 'CallStatement' }],
        },
      },
      { type: 'AssignmentStatement' },
    ]);
  });

  it('parses a PICO-8 "print" operator (?)', () => {
    // This is the same as print("hi")
    // (Note the argument must be on the same line as the ?)
    const { block: { body }, errors } = parse('?"hi"');
    deepEquals(errors, []);
    deepEquals(body, [
      {
        type: 'CallStatement', expression: {
          type: 'CallExpression',
          base: { type: 'Identifier', name: '?' },
          arguments: [{ type: 'StringLiteral', value: 'hi' }],
        },
      },
    ]);
  });

  it('parses PICO-8 arithmetic operators', () => {
    const code = `a = -a
a = a + b
a = a - b
a = a * b
a = a / b
a = a \\ b -- division + floor
a = a % b  -- modulo
a = a ^ b  -- exponentiation`;
    const { block: { body }, errors } = parse(code);
    deepEquals(errors, []);
    deepEquals(body, [
      { type: 'AssignmentStatement', init: [{ type: 'UnaryExpression', operator: '-' }] },
      { type: 'AssignmentStatement', init: [{ type: 'BinaryExpression', operator: '+' }] },
      { type: 'AssignmentStatement', init: [{ type: 'BinaryExpression', operator: '-' }] },
      { type: 'AssignmentStatement', init: [{ type: 'BinaryExpression', operator: '*' }] },
      { type: 'AssignmentStatement', init: [{ type: 'BinaryExpression', operator: '/' }] },
      { type: 'AssignmentStatement', init: [{ type: 'BinaryExpression', operator: '\\' }] },
      { type: 'AssignmentStatement', init: [{ type: 'BinaryExpression', operator: '%' }] },
      { type: 'AssignmentStatement', init: [{ type: 'BinaryExpression', operator: '^' }] },
    ]);
  });

  it('parses PICO-8 bitwise operators', () => {
    const code = `
a = ~a -- not
a = a | b -- or
a = a & b -- and
a = a ^^ b -- xor
a = a << b -- shift left
a = a >> b -- arithmetic shift right
a = a >>> b -- logical shift right
a = a <<> b -- rotate left
a = a >>< b -- rotate right`;
    const { block: { body }, errors } = parse(code);
    deepEquals(errors, []);
    deepEquals(body, [
      { type: 'AssignmentStatement', init: [{ type: 'UnaryExpression', operator: '~' }] },
      { type: 'AssignmentStatement', init: [{ type: 'BinaryExpression', operator: '|' }] },
      { type: 'AssignmentStatement', init: [{ type: 'BinaryExpression', operator: '&' }] },
      { type: 'AssignmentStatement', init: [{ type: 'BinaryExpression', operator: '^^' }] },
      { type: 'AssignmentStatement', init: [{ type: 'BinaryExpression', operator: '<<' }] },
      { type: 'AssignmentStatement', init: [{ type: 'BinaryExpression', operator: '>>' }] },
      { type: 'AssignmentStatement', init: [{ type: 'BinaryExpression', operator: '>>>' }] },
      { type: 'AssignmentStatement', init: [{ type: 'BinaryExpression', operator: '<<>' }] },
      { type: 'AssignmentStatement', init: [{ type: 'BinaryExpression', operator: '>><' }] },
    ]);
  });

  it('parses PICO-8 memory operators', () => {
    const code = `
a = @a -- peek()
a = %a -- peek2()
a = $a -- peek4()`;
    const { block: { body }, errors } = parse(code);
    deepEquals(errors, []);
    deepEquals(body, [
      { type: 'AssignmentStatement', init: [{ type: 'UnaryExpression', operator: '@' }] },
      { type: 'AssignmentStatement', init: [{ type: 'UnaryExpression', operator: '%' }] },
      { type: 'AssignmentStatement', init: [{ type: 'UnaryExpression', operator: '$' }] },
    ]);
  });

  it('parses PICO-8 relational and misc operators', () => {
    const code = `
a = a < b
a = a > b
a = a <= b
a = a >= b
a = a == b
a = a ~= b
a = a != b -- PICO-8 alias for 'not equals'
a = a and b
a = a or b
a = not a
a = a .. b`;
    const { block: { body }, errors } = parse(code);
    deepEquals(errors, []);
    deepEquals(body, [
      { type: 'AssignmentStatement', init: [{ type: 'BinaryExpression', operator: '<' }] },
      { type: 'AssignmentStatement', init: [{ type: 'BinaryExpression', operator: '>' }] },
      { type: 'AssignmentStatement', init: [{ type: 'BinaryExpression', operator: '<=' }] },
      { type: 'AssignmentStatement', init: [{ type: 'BinaryExpression', operator: '>=' }] },
      { type: 'AssignmentStatement', init: [{ type: 'BinaryExpression', operator: '==' }] },
      { type: 'AssignmentStatement', init: [{ type: 'BinaryExpression', operator: '~=' }] },
      { type: 'AssignmentStatement', init: [{ type: 'BinaryExpression', operator: '!=' }] },
      { type: 'AssignmentStatement', init: [{ type: 'LogicalExpression', operator: 'and' }] },
      { type: 'AssignmentStatement', init: [{ type: 'LogicalExpression', operator: 'or' }] },
      { type: 'AssignmentStatement', init: [{ type: 'UnaryExpression', operator: 'not' }] },
      { type: 'AssignmentStatement', init: [{ type: 'BinaryExpression', operator: '..' }] },
    ]);
  });

  it('parses PICO-8 assignment operators', () => {
    const code = `
a += b
a -= b
a *= b
a /= b
a \\= b
a %= b
a ^= b
a ..= b
a |= b
a &= b
a ^^= b
a <<= b
a >>= b
a >>>= b
a <<>= b
a >><= b`;
    const { block: { body }, errors } = parse(code);
    deepEquals(errors, []);
    deepEquals(body, [
      { type: 'AssignmentStatement', operator: '+=' },
      { type: 'AssignmentStatement', operator: '-=' },
      { type: 'AssignmentStatement', operator: '*=' },
      { type: 'AssignmentStatement', operator: '/=' },
      { type: 'AssignmentStatement', operator: '\\=' },
      { type: 'AssignmentStatement', operator: '%=' },
      { type: 'AssignmentStatement', operator: '^=' },
      { type: 'AssignmentStatement', operator: '..=' },
      { type: 'AssignmentStatement', operator: '|=' },
      { type: 'AssignmentStatement', operator: '&=' },
      { type: 'AssignmentStatement', operator: '^^=' },
      { type: 'AssignmentStatement', operator: '<<=' },
      { type: 'AssignmentStatement', operator: '>>=' },
      { type: 'AssignmentStatement', operator: '>>>=' },
      { type: 'AssignmentStatement', operator: '<<>=' },
      { type: 'AssignmentStatement', operator: '>><=' },
    ]);
  });

  describe('? print shorthand', () => {
    it('parses ? with one argument', () => {
      const { block: { body }, errors } = parse('?abc');
      deepEquals(errors, []);
      deepEquals(body, [
        {
          type: 'CallStatement',
          expression: {
            type: 'CallExpression',
            base: {
              type: 'Identifier',
              name: '?',
            },
            arguments: [{
              type: 'Identifier',
              name: 'abc',
            }],
          },
        },
      ]);
    });

    it('parses ? with multiple arguments', () => {
      const { block: { body }, errors } = parse('?abc,\'def\'');
      deepEquals(errors, []);
      deepEquals(body, [
        {
          type: 'CallStatement',
          expression: {
            type: 'CallExpression',
            base: {
              type: 'Identifier',
              name: '?',
            },
            arguments: [
              { type: 'Identifier', name: 'abc' },
              { type: 'StringLiteral', value: 'def' },
            ],
          },
        },
      ]);
    });

    it('parses ? with more complicated args, in context of a function', () => {
      const code = `debug,lmb,rmb=1,0,0
function debug_draw()
  circfill(mx,my,lmb>0 and 2 or 1,7)
  local f,g = flags[fmx+fmy*128], switch[fmx+fmy*128]
  ?fmx.." "..fmy,1,122,12
end`;
      const { errors } = parse(code);
      deepEquals(errors, []);
    });
  });

  it('parses a complicated member expression', () => {
    const { block: { body } } = parse('getInstance().field = "blah"');
    deepEquals(body, [
      {
        type: 'AssignmentStatement', variables: [
          {
            type: 'MemberExpression',
            base: {
              type: 'CallExpression',
              base: { type: 'Identifier', name: 'getInstance' },
              arguments: [],
            },
            indexer: '.',
            identifier: { type: 'Identifier', name: 'field' },
          },
        ], init: [{ type: 'StringLiteral', value: 'blah' }],
      },
    ]);
  });

  it('skips header and footer sections', () => {
    const code = `pico-8 cartridge // http://www.pico-8.com
version 29
__lua__

__gfx__
0000000000001156eed0ed0eeeeeee`;
    deepEqualsAST(code, []);
  });

  it('skips __sfx__ section', () => {
    const code = `pico-8 cartridge // http://www.pico-8.com
version 42
__lua__

__sfx__
013c01001815000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
`;
    deepEqualsAST(code, []);
  });

  it('skips __music__ section', () => {
    const code = `pico-8 cartridge // http://www.pico-8.com
version 42
__lua__

__music__
00 01424344
`;
    deepEqualsAST(code, []);
  });

  it('parses low.p8', () => {
    const { errors } = parse(getTestFileContents('low.p8'));
    eq(errors.length, 0, 'Unexpected errors: ' + errors.map(e => `[${e.bounds.start.line}:${e.bounds.end.column}] ${e.message}`).join(','));
  });

  it('parses minified pico-8 code without errors - fly', () => {
    const { errors } = parse(getTestFileContents('tweettweetjam-fly.p8'));
    eq(errors.length, 0, 'Unexpected errors: ' + errors.map(e => `[${e.bounds.start.line}:${e.bounds.end.column}] ${e.message}`).join(','));
  });

  it('parses minified pico-8 code without errors - hop', () => {
    const { errors } = parse(getTestFileContents('tweettweetjam-hop.p8'));
    eq(errors.length, 0, 'Unexpected errors: ' + errors.map(e => `[${e.bounds.start.line}:${e.bounds.end.column}] ${e.message}`).join(','));
  });

  it('parses minified pico-8 code without errors - xtris', () => {
    const { errors } = parse(getTestFileContents('tweettweetjam-tet.p8'));
    eq(errors.length, 0, 'Unexpected errors: ' + errors.map(e => `[${e.bounds.start.line}:${e.bounds.end.column}] ${e.message}`).join(','));
  });

  it('parses a binary literal', () => {
    const { block: { body }, errors } = parse('a = 0b0101101001011010.1');
    deepEquals(errors, []);
    deepEquals(body, [
      { type: 'AssignmentStatement', init: [{ type: 'NumericLiteral', raw: '0b0101101001011010.1' }] },
    ]);
  });

  describe('error handling', () => {
    it('handles malformed function definition', () => {
      const { errors } = parse('function[] end');
      deepEquals(errors, [{ message: '<name> expected near \'[\'' }]);
    });

    it('if an error occurs inside a block, it breaks out of the block and continues parsing', () => {
      const { block: { body }, errors } = parse(`
      i = 1
      function somefn()
        blah blah blah
      end
      i = 2
      `);

      deepEquals(errors, [{ message: 'assignment operator expected near \'blah\'' }]);
      deepEquals(body, [{ type: 'AssignmentStatement' }, { type: 'FunctionDeclaration' }, { type: 'AssignmentStatement' }]);
    });

    it('finds multiple errors on different lines in a block', () => {
      const { errors } = parse(`
      blah blah blah
      blah blah blah
      blah blah blah
      `);

      deepEquals(errors, [
        { message: 'assignment operator expected near \'blah\'' },
        { message: 'assignment operator expected near \'blah\'' },
        { message: 'assignment operator expected near \'blah\'' },
      ]);
    });

    it('can catch an error in both the function parameters and function body', () => {
      const { errors } = parse(`
      function somefn(i + 1, i + 2, i + 3)
        blah() * 3
      end
      `);
      deepEquals(errors, [
        { message: '\')\' expected near \'+\'' },
        { message: 'unexpected symbol \'*\' near \'3\'' },
      ]);
    });
  });

  describe('lexical errors', () => {
    const lines = (...l: string[]) => l.join('\n');
    const statementsOf = (body: Statement[]) => body.map(s => `${s.type}${s.included ? '*' : ''} ${s.loc!.start.line}`);
    const unfinishedStringLines = [ 'a = 1', 's = "abc', 'function f()', '  return 1', 'end', 'b = 2' ];

    it('skips an unknown character', () => {
      const { errors, block } = parse(lines('x = 1', 'b = 2 `', 'c = 3'));
      deepEquals(errors.map(formatError), [ 'main_test_file 2:6 unexpected symbol \'`\'' ]);
      deepEquals(statementsOf(block.body), [ 'AssignmentStatement 1', 'AssignmentStatement 2', 'AssignmentStatement 3' ]);
    });

    it('ends an unfinished string at the end of its line', () => {
      const { errors, block } = parse(unfinishedStringLines.join('\n'));
      deepEquals(errors.map(formatError), [ 'main_test_file 2:4 unfinished string near \'"abc\'' ]);
      deepEquals(statementsOf(block.body), [ 'AssignmentStatement 1', 'AssignmentStatement 2', 'FunctionDeclaration 3', 'AssignmentStatement 6' ]);
    });

    it('keeps line numbers after an unfinished string in a CRLF file', () => {
      const { errors, block } = parse(unfinishedStringLines.join('\r\n'));
      deepEquals(errors.map(formatError), [ 'main_test_file 2:4 unfinished string near \'"abc\'' ]);
      deepEquals(statementsOf(block.body), [ 'AssignmentStatement 1', 'AssignmentStatement 2', 'FunctionDeclaration 3', 'AssignmentStatement 6' ]);
    });

    it('keeps the statement before an unclosed long comment', () => {
      const { errors, block } = parse(lines('a = 1', 'b = 2', '--[[ open', 'c = 3'));
      deepEquals(errors.map(formatError), [ 'main_test_file 3:0 unfinished long comment (starting at line 3) near \'<eof>\'' ]);
      deepEquals(statementsOf(block.body), [ 'AssignmentStatement 1', 'AssignmentStatement 2' ]);
    });

    it('skips a lone !', () => {
      const { errors, block } = parse('x = 1 !\ny = 2');
      deepEquals(errors.map(formatError), [ 'main_test_file 1:6 unexpected symbol \'!\'' ]);
      deepEquals(statementsOf(block.body), [ 'AssignmentStatement 1', 'AssignmentStatement 2' ]);
    });

    it('sorts lexical and syntax errors by position', () => {
      const { errors, block } = parse('x = ) "abc');
      deepEquals(errors.map(formatError), [
        'main_test_file 1:4 <expression> expected near \')\'',
        'main_test_file 1:6 unfinished string near \'"abc\'',
      ]);
      deepEquals(statementsOf(block.body), []);
    });

    it('merges the lexical errors of an included file', () => {
      const { errors, block } = parse('#include inc.lua\nx = 1', {
        includeFileResolver: new TestFilesResolver({ 'inc.lua': 's = "abc' }),
      });
      deepEquals(errors.map(formatError), [ 'inc.lua 1:4 unfinished string near \'"abc\'' ]);
      deepEquals(statementsOf(block.body), [ 'IncludeStatement 1', 'AssignmentStatement* 1', 'AssignmentStatement 2' ]);
    });

    it('puts the main file\'s errors first, then each included file\'s by path', () => {
      const { errors } = parse(lines('#include b.lua', '#include a.lua', 's = "abc', 'x = )'), {
        includeFileResolver: new TestFilesResolver({ 'b.lua': 'y = )', 'a.lua': 't = "a' }),
      });
      deepEquals(errors.map(formatError), [
        'main_test_file 3:4 unfinished string near \'"abc\'',
        'main_test_file 4:4 <expression> expected near \')\'',
        'a.lua 1:4 unfinished string near \'"a\'',
        'b.lua 1:4 <expression> expected near \')\'',
      ]);
    });
  });

  describe('include statement', () => {
    it('parses correct include statement', () => {
      const fileResolver = new MockFileResolver();
      fileResolver.loadFileContents = () => 'local a = 1';

      const { block: { body }, errors } = parse('#include other_file.lua', { includeFileResolver: fileResolver });
      deepEquals(errors, []);
      deepEquals(body, [{ type: 'IncludeStatement' }, { type: 'LocalStatement' }]);
    });

    it('returns error when include statement refers to a file that doesn\'t exist', () => {
      const fileResolver = new MockFileResolver();
      fileResolver.doesFileExist = () => false;

      const { errors } = parse('#include other_file.lua', { includeFileResolver: fileResolver });
      deepEquals(errors, [{ type: 'ParseError' }]);
    });

    it('returns error when include statement refers to a directory', () => {
      const fileResolver = new MockFileResolver();
      fileResolver.isFile = () => false;

      const { errors } = parse('#include other_file.lua', { includeFileResolver: fileResolver });
      deepEquals(errors, [{ type: 'ParseError' }]);
    });

    it('reports a statement split across an #include in both files', () => {
      const fileResolver = new MockFileResolver();
      fileResolver.loadFileContents = () => 'a';

      const { block: { body }, errors } = parse('#include other_file.lua\n= 1', { includeFileResolver: fileResolver });
      deepEquals(errors.map(formatError).sort(), [
        'main_test_file 2:0 unexpected symbol \'=\' near \'1\'',
        'other_file.lua 1:0 assignment operator expected near \'<eof>\'',
      ]);
      deepEquals(body, [{ type: 'IncludeStatement' }]);
    });

    it('keeps the line numbers after a lone #', () => {
      const { block: { body }, comments, errors } = parse([ 'x = 1', '#', '-->8', 'function f()', 'end', 'y = 2' ].join('\n'));
      deepEquals(comments!.map(c => c.loc!.start.line), [ 3 ]);
      deepEquals(body.map(s => s.loc!.start.line), [ 1, 4, 6 ]);
      deepEquals(errors.map(formatError), [ 'main_test_file 2:0 #include <filename> expected near \'#\'' ]);
    });

    it('keeps a comment between a lone # and the end of a cart\'s code', () => {
      const p8 = 'pico-8 cartridge // http://www.pico-8.com\nversion 43\n__lua__\n';
      const { comments } = parse(p8 + [ 'x = 1', '#', '-- c', '__gfx__', '0000' ].join('\n'));
      deepEquals(comments!.map(c => `${c.loc!.start.line} ${c.raw}`), [ '6 -- c' ]);
    });

    it('reports a lexical error on the line after a lone # once', () => {
      const { block: { body }, errors } = parse('#\n` x = 1');
      deepEquals(errors.map(formatError), [
        'main_test_file 1:0 #include <filename> expected near \'#\'',
        'main_test_file 2:0 unexpected symbol \'`\'',
      ]);
      deepEquals(body.map(s => `${s.type} ${s.loc!.start.line}`), [ 'AssignmentStatement 2' ]);
    });

    it('contains no warnings for symbols defined in included files', () => {
      const fileResolver = new MockFileResolver();
      fileResolver.loadFileContents = () => 'local a = 5';

      const { errors, warnings } = parse('#include other_file.lua \n print(a)', { includeFileResolver: fileResolver });
      deepEquals(errors, []);
      deepEquals(warnings, []);
    });
  });

});
