import { Location, SignatureHelp, SymbolInformation } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Chunk } from './parser/statements';
import * as url from 'url';
import * as fs from 'fs';
import * as path from 'path';
import { ParseError, Warning } from './parser/errors';
import ResolvedFile, { FileResolver, RealFileResolver } from './parser/file-resolver';
import { analyze, emptyAnalysis } from './parser/analysis/binder';
import { Analysis, Reference } from './parser/analysis/model';
import { definitionsAt, referenceAt, referencesOf, warningsOf } from './parser/analysis/queries';
import { CodeSymbol, outlineFor } from './parser/symbols';
import { NO_OUTLINE_OPTIONS, OutlineOptions } from './parser/outline/model';
import { Bounds, containsIndex } from './parser/types';
import { errorsInFile, FileDiagnostics, inThisFile, mergeDiagnostics } from './diagnostics';
import { hoverMarkdown } from './hover';
import { rangeOf } from './ranges';
import { CallContext, signatureHelpFor } from './signature-help';
import { searchSymbols, SymbolItem, symbolItems, toSymbolInformation } from './workspace-symbols';

export type ProjectDocument = { textDocument: TextDocument, chunk: Chunk, errors: ParseError[] };

// A file is tracked when it has a .p8/.lua extension and the scan of some workspace folder holding it reaches it: the
// scan does not descend into folders whose names start with a dot, so with C:\ and C:\.proj\game both open, the second
// one's scan reaches its files although the first one's does not. With no folder holding it, only the extension counts.
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

// Whether the scan of the workspace folders lists the file: a .p8 or .lua file under one of them, with no folder whose
// name starts with a dot between it and one of the folders that hold it.
export function isScanned(filePath: string, roots: string[]): boolean {
  return roots.some(root => isUnder(filePath, root)) && isTrackedPath(filePath, roots);
}

// Design 5.4 (a): a cart in the file's folder or a folder above it, up to the outermost workspace folder that scans the
// file. A file in a dot-folder of every workspace folder that holds it is near none; a file under no workspace folder
// looks in its own folder alone. hasCart gets folders as path.dirname gives them.
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

// The .p8 and .lua files under folder, outside folders whose names start with a dot. Links, junctions among them, are
// followed, as VS Code's search does, but not a link back to a folder the listing came through from the workspace
// folder `from`, which would never end.
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

// Represents a whole "project" tree. Starts at one root .p8 file, and includes
// all the files that may be included by it.
export type Project = { root: ProjectDocumentNode };

// Returns a human readable string listing all the files included in the project.
export function projectToString(project: Project): string {
  return getProjectFiles(project).map(f => path.basename(url.fileURLToPath(f))).join(', ');
}

export function getProjectFiles(project: Project) {
  const allFiles: string[] = [];

  iterateProject(project, node => allFiles.push(node.document.textDocument.uri));

  return allFiles;
}

export function iterateProject(project: Project, fun: (arg0: ProjectDocumentNode) => void) {
  // A file can be included twice, and files that include each other make a cycle.
  const visited = new Set<ProjectDocumentNode>();
  const iterate = (node: ProjectDocumentNode) => {
    if (visited.has(node)) {
      return;
    }
    visited.add(node);
    fun(node);
    for (const child of node.included) {
      iterate(child);
    }
  };
  iterate(project.root);
}

// A single node of the project tree, representing a single document and any
// files it directly includes.
export type ProjectDocumentNode = {
	document: ProjectDocument,
	included: ProjectDocumentNode[],
  // Whether this node is a child of any projects.
  isChild: boolean,
};

export function findProjects(parsedDocuments: ParsedDocumentsMap): Project[] {
  const visited = new Map<string, ProjectDocumentNode>();

  // Group all the files into projects
  for (const documentUrl of parsedDocuments.keys()) {
    findProjectsRecursive(documentUrl, visited, parsedDocuments);
  }

  // Now return all the non-child nodes as project roots
  return Array.from(visited.values())
    .filter(node => !node.isChild)
    .map(node => {
      return { root: node };
    });
}

function findProjectsRecursive(current: string, visited: Map<string, ProjectDocumentNode>, parsedDocuments: ParsedDocumentsMap): ProjectDocumentNode | undefined {
  if (visited.has(current)) {
    return;
  }

  const doc = parsedDocuments.get(current);
  if (!doc) {
    return;
  }

  const node: ProjectDocumentNode = {
    document: doc,
    included: [],
    isChild: false,
  };
  visited.set(current, node);

  // Loop through all files included by this file and add them as child nodes to this one
  const includes = doc.chunk.includes!;
  for (const include of includes) {
    const includedFileUrl = include.resolvedFile.fileURL;

    // Get project node corresponding to the included file. First check if the
    // node object already exists.
    let childNode = visited.get(includedFileUrl);
    if (!childNode) {
      // It doesn't exist yet, so let's recurse into it.
      childNode = findProjectsRecursive(includedFileUrl, visited, parsedDocuments);
    }

    if (childNode) {
      // Mark as child and insert into this node's children
      childNode.isChild = true;
      node.included.push(childNode);
    }
  }
  return node;
}

// Reads a file through the URI form VS Code uses (ResolvedFile.fromPath(p).fileURL). Whether a file that is not open
// exists is asked of the disk, whatever the cache holds, and one found missing leaves the cache: the file watcher's
// events come in batches after the change, and a parse in between would read a file that is gone. The parser asks that
// before reading an #include, and so does the server before reading a file, so a read takes the cached text as it is.
export function makeFileResolver(editorText: (uri: string) => string | undefined, cache: Map<string, string>,
  disk: FileResolver = new RealFileResolver()): FileResolver {
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
      return editorText(uri) !== undefined || cache.has(uri) || disk.isFile(filepath);
    },
    loadFileContents: filepath => {
      const uri = ResolvedFile.fromPath(filepath).fileURL;
      return editorText(uri) ?? cache.get(uri) ?? disk.loadFileContents(filepath);
    },
    // A name the editor or the scan gave is already the disk's spelling, so only an #include they do not know asks the
    // disk, which costs a system call.
    onDiskName: filepath => {
      const uri = ResolvedFile.fromPath(filepath).fileURL;
      return editorText(uri) !== undefined || cache.has(uri) ? filepath : disk.onDiskName?.(filepath);
    },
  };
}

// The file's current text, parsed; undefined when it cannot be read.
export type ParseFile = (uri: string) => ProjectDocument | undefined;

// analysed: the parse of the root that analysis comes from. failed: that analysis threw, and an empty one stands in.
type IndexedProject = { root: string, files: string[], analysis: Analysis, warnings: Warning[], analysed?: ProjectDocument, failed: boolean };

// One analysis per project, of its root's syntax tree, into which the parser has pasted every #include. Each file takes
// its outline, lookups and warnings from the projects that contain it. Every change is analysed before the call
// returns, so a request that comes after it sees the new text.
//
// The index holds the members, which the server names, and the files they #include, directly or through other files,
// wherever those are, as PICO-8 reads them. A file that is neither leaves the index, and its diagnostics are cleared.
export class ProjectIndex {
  // Each file's own parse, by URI.
  private readonly documents: ParsedDocumentsMap = new Map();
  // Sorted by root URI.
  private projects: IndexedProject[] = [];
  private joined = 0;

  constructor(private readonly parseFile: ParseFile, private readonly isMember: (uri: string) => boolean = () => true) {}

  document(uri: string): ProjectDocument | undefined {
    return this.documents.get(uri);
  }

  // Returns every known URI, and those it dropped or that left, so that their old diagnostics are cleared.
  scan(uris: string[]): string[] {
    const { dropped } = this.reparse(uris);
    this.buildProjects();
    // An includer can have read one of these files before its folder was in the workspace, when no file watcher reported
    // its changes, or before a folder was renamed to the name its #include writes: the other roots that contain one,
    // and the files that wait for one, are parsed again.
    const scanned = new Set(uris);
    const again = unique([
      ...this.projects.filter(project => project.files.some(uri => scanned.has(uri))).map(project => project.root),
      ...[ ...this.documents ].filter(([ , document ]) => (document.chunk.unresolvedIncludes ?? []).some(file => scanned.has(file.fileURL)))
        .map(([ uri ]) => uri),
    ]).filter(uri => !scanned.has(uri));
    if (again.length > 0) {
      dropped.push(...this.reparse(again).dropped);
      this.buildProjects();
    }
    const left = this.settle();
    this.analyseChanged();
    return unique([ ...this.documents.keys(), ...dropped, ...left ]);
  }

  // Returns the URIs whose diagnostics to send again. After the projects are rebuilt, that is every known one, so that a
  // file that left a project loses that project's warnings, and every dropped one and every one that left the index.
  update(uri: string): string[] {
    const isNew = !this.documents.has(uri);
    const before = this.documents.get(uri);
    const document = this.parseFile(uri);
    if (!document) {
      return this.remove(uri);
    }
    this.store(uri, document);
    const stopped = this.reparse(stoppedIncluding(before, document, this.documents));
    if (isNew) {
      // A new file can be one that an #include could not find, and no project links them, since the parser leaves such an
      // #include out of chunk.includes: the files whose last parse had one are parsed again.
      const waiting = [ ...this.documents.keys() ]
        .filter(other => other !== uri && (this.documents.get(other)!.chunk.unresolvedIncludes?.length ?? 0) > 0);
      const { dropped } = this.reparse(waiting);
      this.buildProjects();
      // An includer can have read the file before the editor had it, from a folder the scan and the file watcher leave
      // out: the roots that contain it are parsed again, so that they take its current text.
      const roots = this.projectsOf(uri).map(project => project.root).filter(root => root !== uri && !waiting.includes(root));
      if (roots.length > 0) {
        dropped.push(...this.reparse(roots).dropped);
        this.buildProjects();
      }
      const left = this.settle();
      this.analyseChanged();
      return unique([ ...this.documents.keys(), ...stopped.dropped, ...dropped, ...left ]);
    }
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
    // An edit to a member that still includes what it included before, as most keystrokes are, moves no file in or out.
    let left: string[] = [];
    if (rebuilt || !this.isMember(uri)) {
      const joinedBefore = this.joined;
      left = this.settle();
      rebuilt ||= left.length > 0 || this.joined !== joinedBefore;
    }
    this.analyseChanged();
    const dropped = [ ...stopped.dropped, ...roots.dropped, ...left ];
    return rebuilt ? unique([ ...this.documents.keys(), ...dropped ]) : unique([ uri, ...containing.flatMap(project => project.files) ]);
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
      this.documents.delete(uri);
    }
    const stopped = before.flatMap(document => stoppedIncluding(document, undefined, this.documents));
    const { dropped } = this.reparse([ ...roots, ...stopped ]);
    this.buildProjects();
    const left = this.settle();
    this.analyseChanged();
    return unique([ ...this.documents.keys(), ...uris, ...dropped, ...left ]);
  }

  // The files that left, after what the server counts as a member changed. When some did, every file's diagnostics are
  // to be sent again: a file that one of them included can now be the root of its own project.
  prune(): string[] {
    const left = this.settle();
    this.analyseChanged();
    return left;
  }

  // How many times a file has joined the index. A file that joins can be one that the client should now open as PICO-8
  // Lua, so the server compares the count before and after a change.
  joins(): number {
    return this.joined;
  }

  // Whether a file of the index #includes uri.
  isIncluded(uri: string): boolean {
    return [ ...this.documents ].some(([ other, document ]) =>
      other !== uri && (document.chunk.includes ?? []).some(include => include.resolvedFile.fileURL === uri));
  }

  // Whether a file of the index has an #include of uri that it could not find, so that the file joins when it appears
  // although it is not a member.
  isAwaited(uri: string): boolean {
    return [ ...this.documents.values() ].some(document => (document.chunk.unresolvedIncludes ?? []).some(file => file.fileURL === uri));
  }

  uris(): string[] {
    return [ ...this.documents.keys() ];
  }

  // A failed analysis is empty, so the outline comes from the next project, as the file's Ctrl+T symbols do.
  outline(uri: string, options: OutlineOptions = NO_OUTLINE_OPTIONS): CodeSymbol[] {
    const project = this.projectsOf(uri).find(({ failed }) => !failed);
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

  // From the first project by root URI that has one.
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

  // From the first project by root URI that finds the function, or else from the builtins. The caller finds the call, so
  // that it can still give a builtin's help when this throws.
  signatureHelp(uri: string, index: number, call: CallContext): SignatureHelp | undefined {
    return signatureHelpFor(this.analyses(uri), ResolvedFile.fromFileURL(uri), index, call);
  }

  // One per project containing uri, by root URI.
  analyses(uri: string): Analysis[] {
    return this.projectsOf(uri).map(project => project.analysis);
  }

  // Only the warnings every project containing uri gives: in a file that several carts include, a warning that one
  // cart's code proves wrong is not shown. A project whose analysis failed gives an empty list; intersecting with it
  // removes all warnings from other projects, so failed projects are skipped, as outline and workspace symbols do.
  warnings(uri: string): Warning[] {
    const [ first, ...others ] = this.projectsOf(uri).filter(project => !project.failed).map(project => project.warnings.filter(warning => inThisFile(uri, warning)));
    if (!first) {
      return [];
    }
    const othersKeys = others.map(warnings => new Set(warnings.map(keyOf)));
    return first.filter(warning => othersKeys.every(keys => keys.has(keyOf(warning))));
  }

  diagnostics(uris: string[], maxPerFile: number): FileDiagnostics[] {
    return unique(uris).flatMap(uri => mergeDiagnostics([ uri ],
      new Map([[ uri, errorsInFile(uri, this.documents.get(uri)?.errors ?? []) ]]), this.warnings(uri), maxPerFile));
  }

  workspaceSymbols(query: string, options: OutlineOptions = NO_OUTLINE_OPTIONS): SymbolInformation[] {
    return searchSymbols(this.symbolItemsOfEachFile(options), query).map(toSymbolInformation);
  }

  private projectsOf(uri: string): IndexedProject[] {
    return this.projects.filter(project => project.files.includes(uri));
  }

  // Each file once: an indexed file from the first project that contains it, as its outline comes; a file that only an
  // #include reads, like one in a dot-folder, from the first project whose analysis has it.
  private symbolItemsOfEachFile(options: OutlineOptions): SymbolItem[] {
    const taken = new Set<string>();
    const lists: SymbolItem[][] = [];
    for (const project of this.projects) {
      const files = new Set(project.files);
      for (const [ uri, items ] of symbolItems(project.analysis, options)) {
        if (taken.has(uri) || (this.documents.has(uri) && !files.has(uri))) {
          continue;
        }
        taken.add(uri);
        lists.push(items);
      }
    }
    return lists.flat();
  }

  private buildProjects(): void {
    const trees = findProjects(this.documents);
    const covered = new Set(trees.flatMap(project => getProjectFiles(project)));
    // A file in no project, like one in a cycle of #includes that nothing else includes, is the root of its own.
    for (const uri of this.documents.keys()) {
      if (!covered.has(uri)) {
        trees.push({ root: findProjectsRecursive(uri, new Map(), this.documents)! });
      }
    }
    // A project keeps its analysis while its root's parse is the same: analyseChanged skips it.
    const previous = new Map(this.projects.map(project => [ project.root, project ]));
    this.projects = trees
      .map(project => {
        const root = project.root.document.textDocument.uri;
        const { analysis, warnings, analysed, failed } = previous.get(root) ?? { analysis: emptyAnalysis(), warnings: [], failed: false };
        return { root, files: getProjectFiles(project), analysis, warnings, analysed, failed };
      })
      .sort((a, b) => compare(a.root, b.root));
  }

  // A file that cannot be parsed now is dropped, as update drops it, so that nothing is analysed from its old text. The
  // files that a new parse no longer includes, or that a dropped file included, are parsed again too: one that is gone
  // is dropped, and so counts as new when it comes back. changed: whether some file was dropped or now includes other
  // files than before.
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
        this.documents.delete(uri);
        dropped.push(uri);
        changed = true;
      }
      queue.push(...stoppedIncluding(before, document, this.documents));
    }
    return { dropped, changed };
  }

  // Adds the files that the index's files #include and it does not have yet, then lets go of the files that no member
  // reaches through #includes, and builds the projects again when a file joined or left. Returns the files that left.
  // A file that leaves can have been the only includer of a member, which is then the root of its own project.
  private settle(): string[] {
    const joinedBefore = this.joined;
    const tried = new Set<string>();
    for (;;) {
      const missing = unique([ ...this.documents.values() ].flatMap(document => [ ...includedUris(document) ]))
        .filter(uri => !this.documents.has(uri) && !tried.has(uri));
      if (missing.length === 0) {
        break;
      }
      for (const uri of missing) {
        tried.add(uri);
        const document = this.parseFile(uri);
        if (document) {
          this.store(uri, document);
        }
      }
    }
    const reached = new Set<string>();
    const stack = [ ...this.documents.keys() ].filter(uri => this.isMember(uri));
    for (let uri = stack.pop(); uri !== undefined; uri = stack.pop()) {
      if (!reached.has(uri)) {
        reached.add(uri);
        stack.push(...[ ...includedUris(this.documents.get(uri)) ].filter(included => this.documents.has(included)));
      }
    }
    const left = [ ...this.documents.keys() ].filter(uri => !reached.has(uri));
    for (const uri of left) {
      this.documents.delete(uri);
    }
    if (left.length > 0 || this.joined !== joinedBefore) {
      this.buildProjects();
    }
    return left;
  }

  private store(uri: string, document: ProjectDocument): void {
    if (!this.documents.has(uri)) {
      this.joined++;
    }
    this.documents.set(uri, document);
  }

  // A project's analysis comes from its root's parse alone, so it holds until the root is parsed again.
  private analyseChanged(): void {
    for (const project of this.projects) {
      if (project.analysed !== this.documents.get(project.root)) {
        this.analyse(project);
      }
    }
  }

  // Never keeps an earlier result: one that failed gives way to an empty analysis.
  private analyse(project: IndexedProject): void {
    project.analysed = this.documents.get(project.root);
    try {
      project.analysis = analyze(this.documents.get(project.root)!.chunk);
      project.warnings = warningsOf(project.analysis);
      project.failed = false;
    } catch (e) {
      console.error(`Failed to analyse the project of ${project.root}`, e);
      project.analysis = emptyAnalysis();
      project.warnings = [];
      project.failed = true;
    }
  }

  // The union of the results in the projects containing uri, each place once, by file path and then by start.
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

// The files the index has that the earlier parse included and the new one does not, the file itself left out; after is
// undefined when the file is gone. They are parsed again, as they can be gone too; one that nothing includes any more
// and that is not a member leaves the index when it settles.
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

function keyOf(warning: Warning): string {
  return `${warning.bounds.start.index}:${warning.bounds.end.index}:${warning.message}`;
}

function byPlace(a: Bounds, b: Bounds): number {
  return compare(a.start.filename.path, b.start.filename.path) || a.start.index - b.start.index;
}

function compare(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function toLocation(bounds: Bounds): Location {
  return {
    uri: bounds.start.filename.fileURL,
    range: rangeOf(bounds),
  };
}
