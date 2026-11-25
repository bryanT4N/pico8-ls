import { deepStrictEqual, strictEqual as eq } from 'assert';
import { guarded } from '../guarded';

describe('guarded', () => {
  it('gives what the handler gives', () => {
    eq(guarded('add one', () => 0, (n: number) => n + 1)(1), 2);
  });

  it('gives the fallback and logs what threw', () => {
    const logged: unknown[][] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      eq(guarded('add one', (n: number) => -n, (n: number): number => {
        throw new RangeError(`too deep at ${n}`);
      })(3), -3);
    } finally {
      console.error = consoleError;
    }
    deepStrictEqual(logged.map(args => [ args[0], (args[1] as Error).message ]), [[ 'Failed to add one', 'too deep at 3' ]]);
  });
});
