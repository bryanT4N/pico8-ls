import * as util from 'util';

// Helpers
// -------

// A sprintf implementation using %index (beginning at 1) to input
// arguments in the format string.
//
// Example:
//
//     // Unexpected function in token
//     sprintf('Unexpected %2 in %1.', 'token', 'function');

export function sprintf(format: string, ...args: any[]): string {
  format = format.replace(/%(\d)/g, function (match, index) {
    return '' + args[index - 1] || '';
  });
  return format;
}

// equivalent to console.log(x), BUT with a really big depth. (default depth for
// console.log is 2.)
// Comes with optional label.
export function logObj(x: any, label?: string): void {
  const inspected = util.inspect(x, { depth: 90 });
  console.log(label ? `${label}: ${inspected}` : inspected);
}

export function compareStrings(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

export function groupBy<T, K>(items: Iterable<T>, keyOf: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}
