import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';

export default class ResolvedFile {
  path: string;
  fileURL: string;

  constructor(path: string, fileURL: string) {
    this.path = path;
    this.fileURL = fileURL;
  }

  static fromFileURL(fileURL: string): ResolvedFile {
    return new ResolvedFile(
      fileURLToPath(fileURL),
      fileURL,
    );
  }

  static fromPath(path: string): ResolvedFile {
    return new ResolvedFile(
      path,
      pathToFileURL(path),
    );
  }

  equals(other: ResolvedFile): boolean {
    return this.path === other.path && this.fileURL === other.fileURL;
  }

  toString(): string {
    return `ResolvedFile(path=${this.path},fileURL=${this.fileURL})`;
  }
}

export function fileURLToPath(fileUrl: string): string {
  return url.fileURLToPath(fileUrl);
}

// The URI as VS Code writes it, which is how the editor and the file watcher name the file: every character but
// letters, digits, - . _ ~ and the slashes is percent-encoded, the drive's colon too. Node's url.pathToFileURL leaves
// ( ) ' ! & and others as they are. Unlike VS Code, the drive letter keeps its case, so that the URI reads back to
// the same path; the paths here come from VS Code's URIs, where it is lower case.
export function pathToFileURL(filePath: string): string {
  let rest = path.resolve(filePath);
  let authority = '';
  if (path.sep === '\\') {
    rest = rest.replace(/\\/g, '/');
    if (rest.startsWith('//')) {
      // A UNC path: \\server\share\...
      const end = rest.indexOf('/', 2);
      authority = (end === -1 ? rest.slice(2) : rest.slice(2, end)).toLowerCase();
      rest = end === -1 ? '/' : rest.slice(end);
    } else {
      rest = '/' + rest;
    }
  }
  return `file://${percentEncode(authority, /[\w.~:[\]-]/)}${percentEncode(rest, /[\w.~/-]/)}`;
}

function percentEncode(text: string, keep: RegExp): string {
  let encoded = '';
  for (const char of text) {
    encoded += keep.test(char) ? char : [ ...Buffer.from(char) ].map(byte => '%' + byte.toString(16).toUpperCase().padStart(2, '0')).join('');
  }
  return encoded;
}

export function resolveIncludeFile(currFile: ResolvedFile, includeFilename: string): ResolvedFile {
  const currFileDir = path.dirname(currFile.path);
  const resolvedPath = path.normalize(path.join(currFileDir, includeFilename));
  return ResolvedFile.fromPath(resolvedPath);
}

export interface FileResolver {
  doesFileExist: (filepath: string) => boolean;
  isFile: (filepath: string) => boolean;
  loadFileContents: (filepath: string) => string;
}

export class RealFileResolver implements FileResolver {
  doesFileExist(filepath: string): boolean {
    return fs.existsSync(filepath);
  }

  isFile(filepath: string): boolean {
    return fs.statSync(filepath).isFile();
  }

  loadFileContents(filepath: string): string {
    return fs.readFileSync(filepath).toString();
  }
}
