import { Location, SignatureHelp, SymbolInformation } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Chunk } from './parser/statements';
import * as url from 'url';
import * as fs from 'fs';
import * as path from 'path';
import { ParseError, Warning } from './parser/errors';
import ResolvedFile, { FileResolver, hasP8Extension, RealFileResolver } from './parser/file-resolver';
import { analyze, emptyAnalysis } from './parser/analysis/binder';
import { Analysis, Reference } from './parser/analysis/model';
import { definitionsAt, referenceAt, referencesOf, warningsOf } from './parser/analysis/queries';
import { CodeSymbol, outlineFor } from './parser/symbols';
import { NO_OUTLINE_OPTIONS, OutlineOptions } from './parser/outline/model';
import { Bounds, containsIndex } from './parser/types';
import { compareStrings } from './parser/util';
import { errorsInFile, FileDiagnostics, inThisFile, mergeDiagnostics } from './diagnostics';
import { hoverMarkdown } from './hover';
import { rangeOf } from './ranges';
import { CallContext, signatureHelpFor } from './signature-help';
import { searchSymbols, SymbolItem, symbolItems, toSymbolInformation } from './workspace-symbols';

export type ProjectDocument = { textDocument: TextDocument, chunk: Chunk, errors: ParseError[] };

// Any folder whose scan reaches the file will do: with C:\ and C:\.proj\game both open, the second one's scan reaches
// its files although the first one's does not.
export function isTrackedPath(filePath: string, roots: string[]): boolean {
  if (!(/\.(p8|lua)$/i.test(filePath))) {
    return false;
  }
  const normalizedFile = path.normalize(filePath);
  const holding = roots.map(r => path.normalize(r))
    .filter(r => isUnder(normalizedFile, r) || normalizedFile === r);
  return holding.length === 0 || holding.some(root => reaches(root, path.dirname(normalizedFile)));
}

export function scansFolder(folder: string, roots: string[]): boolean {
  return roots.some(root => (isUnder(folder, root) || path.relative(root, folder) === '') && reaches(root, folder));
}

export function isScanned(filePath: string, roots: string[]): boolean {
  return roots.some(root => isUnder(filePath, root)) && isTrackedPath(filePath, roots);
}

// A cart takes in the .lua files of its folder and the folders below, as a tsconfig.json does. hasCart gets folders as
// path.dirname gives them.
export function nearCart(filePath: string, roots: string[], hasCart: (folder: string) => boolean): boolean {
  const holding = roots.filter(root => isUnder(filePath, root));
  const tracking = holding.filter(root => reaches(root, path.dirname(filePath)));
  if (holding.length > 0 && tracking.length === 0) {
    return false;
  }
  const top = tracking.length === 0
    ? path.dirname(filePath)
    : tracking.reduce((outer, root) => path.normalize(root).length < path.normalize(outer).length ? root : outer);
  for (let folder = path.dirname(filePath); ; folder = path.dirname(folder)) {
    if (hasCart(folder)) {
      return true;
    }
    if (path.relative(top, folder) === '' || path.dirname(folder) === folder) {
      return false;
    }
  }
}

// The scan of a workspace folder does not go into folders whose names start with a dot; folder is root or under it.
function reaches(root: string, folder: string): boolean {
  return path.relative(root, folder).split(path.sep).every(part => !part.startsWith('.'));
}

// A drive or share root, such as c:\ or \\server\share\, already ends in a separator.
export function isUnder(filePath: string, folder: string): boolean {
  const dir = path.normalize(folder);
  return path.normalize(filePath).startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

// The answers of isWatched, which looks at each folder on the file's path on the disk: the server asks it each time it
// reads a file it does not keep, as one reached through a link, at each parse of a file that includes it.
const watchedAnswers = new Map<string, boolean>();

// For a file or folder created or deleted, which can put a link where a folder was.
export function forgetWatched(): void {
  watchedAnswers.clear();
}

// Whether the file watcher reports the file's changes, files.watcherExclude aside. It watches the workspace folders,
// also one that is a link, and reports nothing under a link inside them, a junction among them.
export function isWatched(filePath: string, roots: string[]): boolean {
  const key = [ ...roots, filePath ].join('\n');
  let answer = watchedAnswers.get(key);
  if (answer === undefined) {
    answer = roots.some(root => {
      if (!isUnder(filePath, root)) {
        return false;
      }
      const parts = path.relative(root, filePath).split(path.sep);
      try {
        return parts.every((_, i) => !fs.lstatSync(path.join(root, ...parts.slice(0, i + 1))).isSymbolicLink());
      } catch {
        return false;
      }
    });
    watchedAnswers.set(key, answer);
  }
  return answer;
}

type Kind = { isDirectory(): boolean, isFile(): boolean };
type Entry = Kind & { name: string, isSymbolicLink(): boolean };

export type FolderReader = {
  readdir: (folder: string) => Promise<Entry[]>,
  stat: (file: string) => Promise<Kind>,
  realpath: (file: string) => Promise<string>,
};

const DISK: FolderReader = {
  readdir: folder => fs.promises.readdir(folder, { withFileTypes: true }),
  stat: file => fs.promises.stat(file),
  realpath: file => new Promise((resolve, reject) => fs.realpath.native(file, (e, real) => e ? reject(e) : resolve(real))),
};

// Links, junctions among them, are followed, as VS Code's search does, but not a link back to a folder the listing
// came through from the workspace folder `from`, which would never end.
export async function listCartFiles(folder: string, from = folder, reader: FolderReader = DISK): Promise<string[]> {
  const between = path.relative(from, folder).split(path.sep).filter(part => part !== '');
  const above = between.map((_, i) => path.join(from, ...between.slice(0, i)));
  const chain = await Promise.all([ ...above, folder ].map(dir => reader.realpath(dir).catch(() => dir)));
  if (chain.slice(0, -1).includes(chain[chain.length - 1])) {
    return [];
  }
  const found: string[] = [];
  const list = async (dir: string, realDirs: string[]): Promise<void> => {
    let entries: Entry[];
    try {
      entries = await reader.readdir(dir);
    } catch (e) {
      console.error('Error when scanning workspace folder ' + dir, e);
      return;
    }
    await Promise.all(entries.map(async entry => {
      const entryPath = path.join(dir, entry.name);
      let kind: Kind = entry;
      let real = path.join(realDirs[realDirs.length - 1], entry.name);
      if (entry.isSymbolicLink()) {
        try {
          kind = await reader.stat(entryPath);
          real = await reader.realpath(entryPath);
        } catch {
          return;
        }
      }
      if (kind.isDirectory()) {
        if (!entry.name.startsWith('.') && !realDirs.includes(real)) {
          await list(entryPath, [ ...realDirs, real ]);
        }
      } else if (kind.isFile() && /\.(p8|lua)$/i.test(entry.name)) {
        found.push(entryPath);
      }
    }));
  };
  await list(folder, chain);
  return found;
}

export type ParsedDocumentsMap = Map<string, ProjectDocument>;

// Reads a file through the URI form VS Code uses (ResolvedFile.fromPath(p).fileURL). Whether a file that is not open
// exists is asked of the disk, whatever the cache holds, and one found missing leaves the cache: the file watcher's
// events come in batches after the change, and a parse in between would read a file that is gone. The parser asks that
// before reading an #include, and so does the server before reading a file, so a read takes the cached text as it is.
export function makeFileResolver(editorText: (uri: string) => string | undefined, cache: Map<string, string>,
  disk: FileResolver = new RealFileResolver()): FileResolver {
  const named = (uri: string) => editorText(uri) !== undefined || cache.has(uri);
  return {
    doesFileExist: filepath => {
      const uri = ResolvedFile.fromPath(filepath).fileURL;
      if (editorText(uri) !== undefined || disk.doesFileExist(filepath)) {
        return true;
      }
      cache.delete(uri);
      return false;
    },
    isFile: filepath => {
      const uri = ResolvedFile.fromPath(filepath).fileURL;
      return named(uri) || disk.isFile(filepath);
    },
    loadFileContents: filepath => {
      const uri = ResolvedFile.fromPath(filepath).fileURL;
      return editorText(uri) ?? cache.get(uri) ?? disk.loadFileContents(filepath);
    },
    // The name the editor or the cache has for a file is the one its #includes take. The scan spells a workspace folder
    // as its URI does, which can differ in case from the disk, so a cached file is also looked for in another case.
    onDiskName: filepath => {
      const uri = ResolvedFile.fromPath(filepath).fileURL;
      if (named(uri)) {
        return filepath;
      }
      const real = disk.onDiskName?.(filepath);
      if (real === undefined) {
        return undefined;
      }
      // Comparing URIs spares turning every cached URI into a path. A letter outside ASCII that has a case is escaped,
      // and its escape changes with its case, so a path with one is compared as a path.
      const lower = filepath.toLowerCase();
      const lowerUri = uri.toLowerCase();
      const byUri = [ ...filepath ].every(char => char.charCodeAt(0) < 128 || char.toLowerCase() === char && char.toUpperCase() === char);
      return [ ...cache.keys() ].filter(other => byUri ? other.toLowerCase() === lowerUri : url.fileURLToPath(other).toLowerCase() === lower)
        .map(other => url.fileURLToPath(other)).find(other => disk.onDiskName?.(other) === real) ?? real;
    },
    isNamed: filepath => named(ResolvedFile.fromPath(filepath).fileURL),
  };
}

export type ParseFile = (uri: string) => ProjectDocument | undefined;

type IndexedProject = { root: string, files: string[], analysis: Analysis, warnings: Warning[], analysed?: ProjectDocument, failed: boolean };

// One analysis per project, of its root's syntax tree, into which the parser has pasted every #include. Each file takes
// its outline, lookups and warnings from the projects that contain it. Every change is analysed before the call
// returns, so a request that comes after it sees the new text.
//
// The index holds the members, which the server names, and the files in their projects, wherever those are, as PICO-8
// reads them. A project is a root, which is a member (findRoots says which), and the files the root #includes. A file
// that is neither a member nor in a project leaves the index, and its diagnostics are cleared.
export class ProjectIndex {
  private readonly documents: ParsedDocumentsMap = new Map();
  // Sorted by root URI.
  private projects: IndexedProject[] = [];
  private joined = 0;
  private readonly arrived = new Set<string>();
  private awaited: Set<string> | undefined;
  private settledMembers = new Set<string>();

  constructor(private readonly parseFile: ParseFile, private readonly isMember: (uri: string) => boolean = () => true) {}

  document(uri: string): ProjectDocument | undefined {
    return this.documents.get(uri);
  }

  // Returns every known URI, and those it dropped or that left, so that their old diagnostics are cleared.
  scan(uris: string[]): string[] {
    const { dropped } = this.reparse(uris);
    this.buildProjects();
    // An includer can have read one of these files before its folder was in the workspace, when no file watcher
    // reported its changes, or before a folder was renamed to the name its #include writes: the other roots that
    // contain one, and the files that wait for one, are parsed again.
    const scanned = new Set(uris);
    const names = new Set(uris.map(caseless));
    const again = unique([
      ...this.projectsHolding(uris).map(project => project.root),
      ...[ ...this.documents ].filter(([ , document ]) => (document.chunk.unresolvedIncludes ?? []).some(file => names.has(caseless(file.fileURL))))
        .map(([ uri ]) => uri),
    ]).filter(uri => !scanned.has(uri));
    if (again.length > 0) {
      dropped.push(...this.reparse(again).dropped);
      this.buildProjects();
    }
    const { left } = this.settle();
    this.analyseChanged();
    return unique([ ...this.documents.keys(), ...dropped, ...left ]);
  }

  // Returns the URIs whose diagnostics to send again. After the projects are rebuilt, that is every known one, so that
  // a file that left a project loses that project's warnings, and every dropped one and every one that left the index.
  update(uri: string): string[] {
    const before = this.documents.get(uri);
    const document = this.parseFile(uri);
    if (!document) {
      return this.remove(uri);
    }
    const isNew = this.store(uri, document);
    const stopped = this.reparse(stoppedIncluding(before, document, this.documents));
    return isNew ? this.joinNew(uri, stopped) : this.updateKnown(uri, before, document, stopped);
  }

  remove(uri: string): string[] {
    return this.removeAll([ uri ]);
  }

  // All the files leave before any is parsed again. One at a time, a root would be parsed again for each of its files
  // that goes, and a file that goes later for an includer that went first.
  removeAll(uris: string[]): string[] {
    const gone = new Set(uris);
    const roots = unique(uris.flatMap(uri => this.projectsOf(uri).map(project => project.root))).filter(root => !gone.has(root));
    const before = uris.map(uri => this.documents.get(uri));
    for (const uri of uris) {
      this.drop(uri);
    }
    const stopped = before.flatMap(document => stoppedIncluding(document, undefined, this.documents));
    const { dropped } = this.reparse([ ...roots, ...stopped ]);
    this.buildProjects();
    const { left } = this.settle();
    this.analyseChanged();
    return unique([ ...this.documents.keys(), ...uris, ...dropped, ...left ]);
  }

  // After what the server counts as a member changed, as when a cart that another cart includes stops being a member,
  // every file's diagnostics are to be sent again.
  prune(): string[] {
    const { left, regrouped } = this.settle();
    this.analyseChanged();
    return regrouped ? unique([ ...this.documents.keys(), ...left ]) : left;
  }

  // How many files have joined the index and are still in it, counted when this is read. A file that joins can be one
  // that the client should now open as PICO-8 Lua, so the server compares the count before and after a change; one that
  // joined and left in between does not count.
  joins(): number {
    this.joined += this.arrived.size;
    this.arrived.clear();
    return this.joined;
  }

  // Whether a project root #includes uri, as only such an #include brings a file into the index.
  isIncluded(uri: string): boolean {
    return this.projects.some(({ root }) => root !== uri && includedUris(this.documents.get(root)).has(uri));
  }

  // Whether a project root has an #include of uri that it could not find, so that the file joins when it appears
  // although it is not a member.
  isAwaited(uri: string): boolean {
    return this.awaitedFiles().has(uri);
  }

  awaitedUnder(folder: string): string[] {
    return [ ...this.awaitedFiles() ].filter(uri => uri.startsWith(folder + '/'));
  }

  uris(): string[] {
    return [ ...this.documents.keys() ];
  }

  outline(uri: string, options: OutlineOptions = NO_OUTLINE_OPTIONS): CodeSymbol[] {
    const project = this.sourceProject(uri);
    return project
      ? outlineFor(project.analysis, ResolvedFile.fromFileURL(uri), options, this.documents.get(uri)?.textDocument.getText() ?? '')
      : [];
  }

  definitions(uri: string, index: number): Location[] {
    const file = ResolvedFile.fromFileURL(uri);
    const include = this.documents.get(uri)?.chunk.includes?.find(({ stmt }) => containsIndex(stmt.loc!, file, index));
    if (include) {
      return [{
        uri: include.resolvedFile.fileURL,
        range: { start: { line: 0, character: 0 }, end: { line: Number.MAX_SAFE_INTEGER, character: 0 } },
      }];
    }
    return this.lookUp(uri, index, definitionsAt);
  }

  references(uri: string, index: number, includeDeclaration: boolean): Location[] {
    return this.lookUp(uri, index, (_analysis, reference) => referencesOf(reference.symbol, includeDeclaration));
  }

  hover(uri: string, index: number): string | undefined {
    const file = ResolvedFile.fromFileURL(uri);
    for (const { analysis } of this.projectsOf(uri)) {
      const reference = referenceAt(analysis, file, index);
      const markdown = reference && hoverMarkdown(analysis, reference);
      if (markdown !== undefined) {
        return markdown;
      }
    }
    return undefined;
  }

  // The caller finds the call, so that it can still give a builtin's help when this throws.
  signatureHelp(uri: string, index: number, call: CallContext): SignatureHelp | undefined {
    return signatureHelpFor(this.analyses(uri), ResolvedFile.fromFileURL(uri), index, call);
  }

  analyses(uri: string): Analysis[] {
    return this.projectsOf(uri).map(project => project.analysis);
  }

  // The warnings of the file's own project when it is a root, as its outline comes from there; otherwise only the
  // warnings every project containing uri gives: in a file that several carts include, a warning that one cart's code
  // proves wrong is not shown. A project whose analysis failed gives an empty list; intersecting with it would remove
  // all warnings from other projects, so failed projects are skipped, as the outline of such a file skips them.
  warnings(uri: string): Warning[] {
    const containing = this.projectsOf(uri);
    const own = containing.filter(project => project.root === uri);
    const [ first, ...others ] = (own.length > 0 ? own : containing).filter(project => !project.failed)
      .map(project => project.warnings.filter(warning => inThisFile(uri, warning)));
    if (!first) {
      return [];
    }
    const othersKeys = others.map(warnings => new Set(warnings.map(keyOf)));
    return first.filter(warning => othersKeys.every(keys => keys.has(keyOf(warning))));
  }

  diagnostics(uris: string[], maxPerFile: number): FileDiagnostics[] {
    return unique(uris).flatMap(uri => mergeDiagnostics([ uri ], new Map([[ uri, this.errors(uri) ]]), this.warnings(uri), maxPerFile));
  }

  // PICO-8 reads a file that a root includes only pasted into the root, so such a file has the errors that the parses
  // of the roots containing it find in it, each once, in order of place: a block it leaves for the root to close is
  // none. A root, or a file in no project, has those of its own parse.
  private errors(uri: string): ParseError[] {
    const containing = this.projectsOf(uri);
    const parses = containing.length === 0 || containing[0].root === uri ? [ uri ] : containing.map(project => project.root);
    const errors: ParseError[] = [];
    const seen = new Set<string>();
    for (const parse of parses) {
      for (const error of errorsInFile(uri, this.documents.get(parse)?.errors ?? [])) {
        if (!seen.has(keyOf(error))) {
          seen.add(keyOf(error));
          errors.push(error);
        }
      }
    }
    return errors.sort((a, b) => a.bounds.start.index - b.bounds.start.index);
  }

  workspaceSymbols(query: string, options: OutlineOptions = NO_OUTLINE_OPTIONS): SymbolInformation[] {
    return searchSymbols(this.symbolItemsOfEachFile(options), query).map(toSymbolInformation);
  }

  // The project whose root the file is comes first: its outline, hover and signature help come from there.
  private projectsOf(uri: string): IndexedProject[] {
    const containing = this.projects.filter(project => project.files.includes(uri));
    return [ ...containing.filter(project => project.root === uri), ...containing.filter(project => project.root !== uri) ];
  }

  // Also under another spelling in case, which an #include takes from the disk before the scan or the editor gives the
  // file its name: parsed again, the includer takes that name.
  private projectsHolding(uris: string[]): IndexedProject[] {
    const names = new Set(uris.map(caseless));
    return this.projects.filter(project => project.files.some(uri => names.has(caseless(uri))));
  }

  private joinNew(uri: string, stopped: { dropped: string[] }): string[] {
    // A new file can be one that an #include could not find, and no project links them, since the parser leaves such an
    // #include out of chunk.includes: the files whose last parse had one are parsed again.
    const waiting = [ ...this.documents.keys() ]
      .filter(other => other !== uri && (this.documents.get(other)!.chunk.unresolvedIncludes?.length ?? 0) > 0);
    const { dropped } = this.reparse(waiting);
    this.buildProjects();
    // An includer can have read the file before the editor had it, from a folder the scan and the file watcher leave
    // out: the roots that contain it are parsed again, so that they take its current text.
    const roots = this.projectsHolding([ uri ]).map(project => project.root).filter(root => root !== uri && !waiting.includes(root));
    if (roots.length > 0) {
      dropped.push(...this.reparse(roots).dropped);
      this.buildProjects();
    }
    const { left } = this.settle();
    this.analyseChanged();
    return unique([ ...this.documents.keys(), ...stopped.dropped, ...dropped, ...left ]);
  }

  private updateKnown(uri: string, before: ProjectDocument | undefined, document: ProjectDocument, stopped: { dropped: string[] }): string[] {
    let rebuilt = !sameSet(includedUris(before), includedUris(document)) || this.projectsOf(uri).length === 0;
    if (rebuilt) {
      this.buildProjects();
    }
    const containing = this.projectsOf(uri);
    const roots = this.reparse(containing.map(project => project.root).filter(root => root !== uri));
    if (roots.changed) {
      this.buildProjects();
      rebuilt = true;
    }
    // An edit to a member that still includes what it included before, as most keystrokes are, moves no file in or out;
    // a file that has become a member since the index last settled, as one just opened, can.
    let left: string[] = [];
    if (rebuilt || !this.isMember(uri) || !this.settledMembers.has(uri)) {
      const settled = this.settle();
      left = settled.left;
      rebuilt ||= left.length > 0 || settled.joined || settled.regrouped;
    }
    this.analyseChanged();
    const dropped = [ ...stopped.dropped, ...roots.dropped, ...left ];
    return rebuilt ? unique([ ...this.documents.keys(), ...dropped ]) : unique([ uri, ...containing.flatMap(project => project.files) ]);
  }

  // A failed analysis is empty, so a file that is no root takes its outline and Go to Symbol in Workspace entries
  // from the next project.
  private sourceProject(uri: string): IndexedProject | undefined {
    const containing = this.projectsOf(uri);
    return containing[0]?.root === uri ? containing[0] : containing.find(({ failed }) => !failed);
  }

  // Each file once: a file of the index from the project its outline comes from, even where that project gives it none,
  // and any other file from the first project whose analysis has it.
  private symbolItemsOfEachFile(options: OutlineOptions): SymbolItem[] {
    const taken = new Set<string>();
    const lists: SymbolItem[][] = [];
    const sources = new Map<string, IndexedProject | undefined>();
    const sourceOf = (uri: string) => sources.has(uri) ? sources.get(uri) : sources.set(uri, this.sourceProject(uri)).get(uri);
    for (const project of this.projects) {
      for (const [ uri, items ] of symbolItems(project.analysis, options)) {
        if (taken.has(uri) || (this.documents.has(uri) && sourceOf(uri) !== project)) {
          continue;
        }
        taken.add(uri);
        lists.push(items);
      }
    }
    return lists.flat();
  }

  // A project keeps its analysis while its root's parse is the same: analyseChanged skips it.
  private buildProjects(): void {
    const previous = new Map(this.projects.map(project => [ project.root, project ]));
    this.projects = this.findRoots()
      .map(root => {
        const files = unique([ root, ...[ ...includedUris(this.documents.get(root)) ].filter(uri => this.documents.has(uri)) ]);
        const { analysis, warnings, analysed, failed } = previous.get(root) ?? { analysis: emptyAnalysis(), warnings: [], failed: false };
        return { root, files, analysis, warnings, analysed, failed };
      })
      .sort((a, b) => compareStrings(a.root, b.root));
    this.awaited = undefined;
  }

  // The roots of the projects: every member .p8 file, which PICO-8 runs on its own, and every other member that no root
  // #includes, as PICO-8 follows no #include in an included file. Members that #include one another in a cycle that no
  // root #includes are roots each, and the members they #include are then placed as below any other root.
  private findRoots(): string[] {
    const members = [ ...this.documents.keys() ].filter(uri => this.isMember(uri));
    const includers = new Map<string, string[]>(members.map(uri => [ uri, []]));
    for (const uri of members) {
      for (const included of includedUris(this.documents.get(uri))) {
        if (included !== uri) {
          includers.get(included)?.push(uri);
        }
      }
    }
    const roots = new Set(members.filter(hasP8Extension));
    const included = new Set<string>();
    const undecided = () => members.filter(member => !roots.has(member) && !included.has(member));
    const place = () => {
      for (let changed = true; changed;) {
        changed = false;
        for (const uri of undecided()) {
          if (includers.get(uri)!.some(other => roots.has(other))) {
            included.add(uri);
            changed = true;
          } else if (includers.get(uri)!.every(other => included.has(other))) {
            roots.add(uri);
            changed = true;
          }
        }
      }
    };
    place();
    // Each member left has a member left among its includers, so following them leads into a cycle.
    const left = new Set(undecided());
    const inCycle = (start: string) => {
      const seen = new Set<string>();
      const stack = [ ...includers.get(start)! ];
      for (let uri = stack.pop(); uri !== undefined; uri = stack.pop()) {
        if (uri === start) {
          return true;
        }
        if (left.has(uri) && !seen.has(uri)) {
          seen.add(uri);
          stack.push(...includers.get(uri)!);
        }
      }
      return false;
    };
    for (const uri of [ ...left ].filter(inCycle)) {
      roots.add(uri);
    }
    place();
    return members.filter(uri => !included.has(uri));
  }

  // A file that cannot be parsed now is dropped, as update drops it, so that nothing is analysed from its old text. The
  // files that a new parse no longer includes, or that a dropped file included, are parsed again too: one that is gone
  // is dropped, and so counts as new when it comes back.
  private reparse(uris: string[]): { dropped: string[], changed: boolean } {
    const dropped: string[] = [];
    let changed = false;
    const queue = [ ...uris ];
    const done = new Set<string>();
    for (let uri = queue.shift(); uri !== undefined; uri = queue.shift()) {
      if (done.has(uri)) {
        continue;
      }
      done.add(uri);
      const before = this.documents.get(uri);
      const document = this.parseFile(uri);
      if (document) {
        this.store(uri, document);
        changed ||= !sameSet(includedUris(before), includedUris(document));
      } else {
        this.drop(uri);
        dropped.push(uri);
        changed = true;
      }
      queue.push(...stoppedIncluding(before, document, this.documents));
    }
    return { dropped, changed };
  }

  private settle(): { left: string[], joined: boolean, regrouped: boolean } {
    const rootsBefore = new Set(this.projects.map(project => project.root));
    let joined = false;
    const tried = new Set<string>();
    for (;;) {
      this.buildProjects();
      const missing = unique(this.projects.flatMap(({ root }) => [ ...includedUris(this.documents.get(root)) ]))
        .filter(uri => !this.documents.has(uri) && !tried.has(uri));
      if (missing.length === 0) {
        break;
      }
      for (const uri of missing) {
        tried.add(uri);
        const document = this.parseFile(uri);
        if (document) {
          joined = this.store(uri, document) || joined;
        }
      }
    }
    const members = [ ...this.documents.keys() ].filter(uri => this.isMember(uri));
    const kept = new Set([ ...members, ...this.projects.flatMap(project => project.files) ]);
    const left = [ ...this.documents.keys() ].filter(uri => !kept.has(uri));
    for (const uri of left) {
      this.drop(uri);
    }
    this.settledMembers = new Set(members);
    const roots = new Set(this.projects.map(project => project.root));
    const regrouped = roots.size !== [ ...rootsBefore ].filter(root => this.documents.has(root)).length
      || [ ...roots ].some(root => !rootsBefore.has(root));
    return { left, joined, regrouped };
  }

  private store(uri: string, document: ProjectDocument): boolean {
    const isNew = !this.documents.has(uri);
    if (isNew) {
      this.arrived.add(uri);
    }
    this.documents.set(uri, document);
    this.awaited = undefined;
    return isNew;
  }

  private drop(uri: string): void {
    this.documents.delete(uri);
    this.arrived.delete(uri);
    this.awaited = undefined;
  }

  private awaitedFiles(): Set<string> {
    return this.awaited ??= new Set(this.projects.flatMap(({ root }) => (this.documents.get(root)?.chunk.unresolvedIncludes ?? []).map(file => file.fileURL)));
  }

  // A project's analysis comes from its root's parse alone, so it holds until the root is parsed again.
  private analyseChanged(): void {
    for (const project of this.projects) {
      if (project.analysed !== this.documents.get(project.root)) {
        this.analyse(project);
      }
    }
  }

  // A statement with an error is not in the analysis, nor are the names it defines, so while the root's parse has an
  // error no file of the project is told that a name is undefined.
  private analyse(project: IndexedProject): void {
    project.analysed = this.documents.get(project.root);
    try {
      const { chunk } = this.documents.get(project.root)!;
      project.analysis = analyze(chunk);
      project.warnings = chunk.errors.length > 0 ? [] : warningsOf(project.analysis);
      project.failed = false;
    } catch (e) {
      console.error(`Failed to analyse the project of ${project.root}`, e);
      project.analysis = emptyAnalysis();
      project.warnings = [];
      project.failed = true;
    }
  }

  private lookUp(uri: string, index: number, query: (analysis: Analysis, reference: Reference) => Bounds[]): Location[] {
    const file = ResolvedFile.fromFileURL(uri);
    const places = new Map<string, Bounds>();
    for (const { analysis } of this.projectsOf(uri)) {
      const reference = referenceAt(analysis, file, index);
      for (const bounds of reference ? query(analysis, reference) : []) {
        places.set(`${bounds.start.filename.path}:${bounds.start.index}:${bounds.end.index}`, bounds);
      }
    }
    return [ ...places.values() ].sort(byPlace).map(toLocation);
  }
}

function includedUris(document: ProjectDocument | undefined): Set<string> {
  return new Set(document?.chunk.includes?.map(include => include.resolvedFile.fileURL));
}

// The callers parse these again, as they can be gone too; one that nothing includes any more and that is not a member
// leaves the index when it settles.
function stoppedIncluding(before: ProjectDocument | undefined, after: ProjectDocument | undefined, documents: ParsedDocumentsMap): string[] {
  const now = includedUris(after);
  return [ ...includedUris(before) ].filter(uri => !now.has(uri) && uri !== after?.textDocument.uri && documents.has(uri));
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [ ...a ].every(item => b.has(item));
}

function unique(uris: string[]): string[] {
  return [ ...new Set(uris) ];
}

// On a disk that tells case apart, this only makes a file be parsed again for nothing.
function caseless(uri: string): string {
  return url.fileURLToPath(uri).toLowerCase();
}

function keyOf(problem: ParseError | Warning): string {
  return `${problem.bounds.start.index}:${problem.bounds.end.index}:${problem.message}`;
}

function byPlace(a: Bounds, b: Bounds): number {
  return compareStrings(a.start.filename.path, b.start.filename.path) || a.start.index - b.start.index;
}

function toLocation(bounds: Bounds): Location {
  return {
    uri: bounds.start.filename.fileURL,
    range: rangeOf(bounds),
  };
}
