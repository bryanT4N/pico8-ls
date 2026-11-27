import * as fs from 'fs';
import * as path from 'path';

// Whether files.exclude hides a file or folder: its path relative to the workspace folder, written with /, and its path.
export type Exclude = (relativePath: string, fullPath: string) => boolean;

// A workspace folder's files.exclude, read as VS Code's glob library reads it: each pattern hides what it matches, a
// folder with all it holds, unless it is set to false, or to a when clause that names no sibling that exists, the first
// $(basename) in it standing for the file's name without its extension. A pattern is split at each / outside braces
// and brackets, such a / matching / or \, a part ** is any number of folders, and within a part * is any characters but
// / and \, ? one of them, {a,b} either and [a-z] one of a range. It is matched over the path relative to the workspace
// folder or, when it is absolute, over the whole path as the system writes it, with a drive letter in either case.
// Undefined when nothing is hidden.
export function excludeOf(setting: unknown): Exclude | undefined {
  if (typeof setting !== 'object' || setting === null) {
    return undefined;
  }
  const rules: { pattern: RegExp, absolute: boolean, when?: string }[] = [];
  for (const [ glob, value ] of Object.entries(setting)) {
    const when = typeof value === 'object' && value !== null ? (value as { when?: unknown }).when : undefined;
    if (value !== false) {
      const written = glob.trim();
      const absolute = path.isAbsolute(written);
      rules.push({ pattern: new RegExp(`^${globSource(absolute ? lowerDrive(written) : written)}$`), absolute,
        when: typeof when === 'string' ? when : undefined });
    }
  }
  if (rules.length === 0) {
    return undefined;
  }
  return (relativePath, fullPath) => rules.some(({ pattern, absolute, when }) => pattern.test(absolute ? lowerDrive(fullPath) : relativePath)
    && (when === undefined || fs.existsSync(path.join(path.dirname(fullPath), when.replace('$(basename)', () => path.parse(fullPath).name)))));
}

function lowerDrive(text: string): string {
  return text.replace(/^[A-Za-z]:/, drive => drive.toLowerCase());
}

const SEPARATOR = '[/\\\\]';
const NOT_SEPARATOR = '[^/\\\\]';

function globSource(glob: string): string {
  const parts = splitOutside(glob, '/');
  if (parts.length > 0 && parts.every(part => part === '**')) {
    return '.*';
  }
  let source = '';
  parts.forEach((part, index) => {
    if (part === '**') {
      if (parts[index - 1] !== '**') {
        const last = index === parts.length - 1 ? `|${SEPARATOR}${NOT_SEPARATOR}+` : '';
        source += `(?:${SEPARATOR}|${NOT_SEPARATOR}+${SEPARATOR}${last})*?`;
      }
      return;
    }
    // A brace or bracket left open takes the rest of the part, and gives nothing.
    let braces: string | undefined;
    let range: string | undefined;
    for (const c of part) {
      if (braces !== undefined && c !== '}') {
        braces += c;
      } else if (range !== undefined && (c !== ']' || range === '')) {
        range += c === '-' ? c : (c === '^' || c === '!') && range === '' ? '^' : c === '/' ? '' : escape(c);
      } else if (c === '{') {
        braces = '';
      } else if (c === '[') {
        range = '';
      } else if (c === '}') {
        source += `(?:${splitOutside(braces ?? '', ',').map(globSource).join('|')})`;
        braces = undefined;
      } else if (c === ']') {
        source += `[${range ?? ''}]`;
        range = undefined;
      } else {
        source += c === '?' ? NOT_SEPARATOR : c === '*' ? `${NOT_SEPARATOR}*?` : escape(c);
      }
    }
    if (index < parts.length - 1 && (parts[index + 1] !== '**' || index + 2 < parts.length)) {
      source += SEPARATOR;
    }
  });
  return source;
}

function escape(c: string): string {
  return c.replace(/[\\{}*+?|^$.[\]()]/g, '\\$&');
}

// The text split at each separator outside braces and brackets, without a last empty part.
function splitOutside(text: string, separator: string): string[] {
  const parts: string[] = [];
  let inBraces = false;
  let inBrackets = false;
  let part = '';
  for (const c of text) {
    if (c === separator && !inBraces && !inBrackets) {
      parts.push(part);
      part = '';
      continue;
    }
    inBraces = c === '{' ? true : c === '}' ? false : inBraces;
    inBrackets = c === '[' ? true : c === ']' ? false : inBrackets;
    part += c;
  }
  if (part !== '') {
    parts.push(part);
  }
  return parts;
}
