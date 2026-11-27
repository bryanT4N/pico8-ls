import * as fs from 'fs';
import * as path from 'path';

// Whether files.exclude hides a file or folder: its path relative to the workspace folder, written with /, and its path.
export type Exclude = (relativePath: string, fullPath: string) => boolean;

// A workspace folder's files.exclude, as VS Code applies it to its own file search: each pattern set to true, or to a
// when clause that names a sibling that exists, hides what it matches, a folder with all it holds. A pattern is a glob
// over the path relative to the workspace folder: ** for any number of folders, * for any characters within a name, ?
// for one, {a,b} for either, [a-z] for one of a range. Undefined when nothing is hidden.
export function excludeOf(setting: unknown): Exclude | undefined {
  if (typeof setting !== 'object' || setting === null) {
    return undefined;
  }
  const rules: { pattern: RegExp, when?: string }[] = [];
  for (const [ glob, value ] of Object.entries(setting)) {
    const when = typeof value === 'object' && value !== null ? (value as { when?: unknown }).when : undefined;
    if (value === true || typeof when === 'string') {
      rules.push({ pattern: globPattern(glob), when: typeof when === 'string' ? when : undefined });
    }
  }
  if (rules.length === 0) {
    return undefined;
  }
  return (relativePath, fullPath) => rules.some(({ pattern, when }) => pattern.test(relativePath)
    && (when === undefined || fs.existsSync(path.join(path.dirname(fullPath), when.replace(/\$\(basename\)/g, path.parse(fullPath).name)))));
}

export function globPattern(glob: string): RegExp {
  return new RegExp(`^${globSource(glob.trim().replace(/^\.\//, '').replace(/\/+$/, ''))}$`);
}

function globSource(glob: string): string {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        source += '(?:.*/)?';
      } else {
        // At the end, as in a/**, the folder itself too.
        source = i === glob.length - 1 && source.endsWith('/') ? `${source.slice(0, -1)}(?:/.*)?` : `${source}.*`;
      }
    } else if (c === '*') {
      source += '[^/]*';
    } else if (c === '?') {
      source += '[^/]';
    } else if (c === '{' && glob.indexOf('}', i) > i) {
      const end = glob.indexOf('}', i);
      source += `(?:${glob.slice(i + 1, end).split(',').map(globSource).join('|')})`;
      i = end;
    } else if (c === '[' && glob.indexOf(']', i + 1) > i + 1) {
      const end = glob.indexOf(']', i + 1);
      const range = glob.slice(i + 1, end);
      source += `[${range.startsWith('!') ? `^${range.slice(1)}` : range}]`;
      i = end;
    } else {
      source += c.replace(/[.+^$(){}|[\]\\]/g, '\\$&');
    }
  }
  return source;
}
