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

// On a disk that ignores case, #include Lib.lua finds lib.lua, and the file must get the URI the editor and the scan
// give lib.lua. A name the resolver already knows the file by is taken whole. Otherwise only the names the #include
// itself adds take the disk's spelling: the includer's folder comes from VS Code's URI, which the disk can spell its
// own way, as through a junction, a subst drive or a short name. When the disk spells an added name otherwise than in
// case, as through a link, the #include is taken as written.
export function resolveIncludeFile(currFile: ResolvedFile, includeFilename: string, resolver?: FileResolver): ResolvedFile {
  const currFileDir = path.dirname(currFile.path);
  const name = process.platform === 'win32' ? asWindowsReads(includeFilename) : includeFilename;
  const resolvedPath = path.normalize(path.join(currFileDir, name));
  const real = resolver?.onDiskName?.(resolvedPath);
  if (real === undefined) {
    return ResolvedFile.fromPath(resolvedPath);
  }
  if (resolver?.isNamed?.(real)) {
    return ResolvedFile.fromPath(real);
  }
  const written = resolvedPath.split(path.sep);
  const dir = path.normalize(currFileDir).split(path.sep);
  let keep = 0;
  while (keep < dir.length && keep < written.length && written[keep] === dir[keep]) {
    keep++;
  }
  const added = written.slice(keep);
  const onDisk = real.split(path.sep);
  const spelled = onDisk.slice(onDisk.length - added.length);
  if (spelled.length !== added.length || added.some((part, i) => part.toLowerCase() !== spelled[i].toLowerCase())) {
    return ResolvedFile.fromPath(resolvedPath);
  }
  return ResolvedFile.fromPath([ ...written.slice(0, keep), ...spelled ].join(path.sep));
}

// Windows drops a single period that ends a folder of a path, and the periods and spaces that end the path, so PICO-8
// there opens lib.lua for lib.lua. and sub/lib.lua for sub./lib.lua. A folder that ends in a space, or in two periods,
// keeps them (3.colon-win-dot, 3.colon-win-folder-dot, 3.colon-space, 3.colon-win-folder-space).
function asWindowsReads(name: string): string {
  const parts = name.split(/[\\/]/);
  return parts.map((part, i) => {
    if (part === '.' || part === '..') {
      return part;
    }
    return i < parts.length - 1 ? part.replace(/([^.])\.$/, '$1') : part.replace(/[. ]+$/, '');
  }).join('\\');
}

export interface FileResolver {
  doesFileExist: (filepath: string) => boolean;
  isFile: (filepath: string) => boolean;
  loadFileContents: (filepath: string) => string;
  // The path of an existing file, by a name the resolver knows, else as the disk spells it; undefined if unknown.
  onDiskName?: (filepath: string) => string | undefined;
  // Whether the resolver already knows a file by this path, which an #include then takes whole.
  isNamed?: (filepath: string) => boolean;
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

  onDiskName(filepath: string): string | undefined {
    try {
      return fs.realpathSync.native(filepath);
    } catch {
      return undefined;
    }
  }
}
