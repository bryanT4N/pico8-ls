import { Location, SignatureHelp, SymbolInformation } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Chunk } from './parser/statements';
import * as url from 'url';
import * as path from 'path';
import { ParseError, Warning } from './parser/errors';
import ResolvedFile, { FileResolver, RealFileResolver } from './parser/file-resolver';
import { analyze, emptyAnalysis } from './parser/analysis/binder';
import { Analysis, Reference } from './parser/analysis/model';
import { definitionsAt, referenceAt, referencesOf, warningsOf } from './parser/analysis/queries';
import { CodeSymbol, outlineFor } from './parser/symbols';
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
  return holding.length === 0 || holding.some(root =>
    path.relative(root, normalizedFile).split(path.sep).slice(0, -1).every(part => !part.startsWith('.')));
}

// The files under one of the removed folders and under none of the remaining ones; paths, not URIs, for the folders.
export function leftWorkspace(uris: string[], removed: string[], remaining: string[]): string[] {
  return uris.filter(uri => {
    const filePath = url.fileURLToPath(uri);
    return removed.some(folder => isUnder(filePath, folder)) && !remaining.some(folder => isUnder(filePath, folder));
  });
}

// A drive or share root, such as c:\ or \\server\share\, already ends in a separator.
function isUnder(filePath: string, folder: string): boolean {
  const dir = path.normalize(folder);
  return path.normalize(filePath).startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
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
// exists is asked of the disk, whatever the cache holds, and one found missing leaves the cache: deleting or renaming a
// folder is reported for the folder alone, which the file watcher does not pass on. The parser asks that before reading
// an #include, and so does the server before reading a file, so a read takes the cached text as it is.
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
export class ProjectIndex {
  // Each file's own parse, by URI.
  private readonly documents: ParsedDocumentsMap = new Map();
  // Sorted by root URI.
  private projects: IndexedProject[] = [];

  constructor(private readonly parseFile: ParseFile) {}

  document(uri: string): ProjectDocument | undefined {
    return this.documents.get(uri);
  }

  // Returns every known URI, and those it dropped, so that their old diagnostics are cleared.
  scan(uris: string[]): string[] {
    const { dropped } = this.reparse(uris);
    this.buildProjects();
    // An includer can have read one of these files before its folder was in the workspace, when no file watcher reported
    // its changes: the other roots that contain one are parsed again, so that they take its current text.
    const scanned = new Set(uris);
    const roots = this.projects.filter(project => !scanned.has(project.root) && project.files.some(uri => scanned.has(uri)))
      .map(project => project.root);
    if (roots.length > 0) {
      dropped.push(...this.reparse(roots).dropped);
      this.buildProjects();
    }
    this.analyseChanged();
    return [ ...this.documents.keys(), ...dropped ];
  }

  // Returns the URIs whose diagnostics to send again. After the projects are rebuilt, that is every known one, so that a
  // file that left a project loses that project's warnings, and every dropped one.
  update(uri: string): string[] {
    const isNew = !this.documents.has(uri);
    const before = this.documents.get(uri);
    const document = this.parseFile(uri);
    if (!document) {
      return this.remove(uri);
    }
    this.documents.set(uri, document);
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
      this.analyseChanged();
      return [ ...this.documents.keys(), ...stopped.dropped, ...dropped ];
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
    this.analyseChanged();
    const dropped = [ ...stopped.dropped, ...roots.dropped ];
    return rebuilt ? [ ...this.documents.keys(), ...dropped ] : unique([ uri, ...containing.flatMap(project => project.files) ]);
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
    this.analyseChanged();
    return unique([ ...this.documents.keys(), ...uris, ...dropped ]);
  }

  uris(): string[] {
    return [ ...this.documents.keys() ];
  }

  // A failed analysis is empty, so the outline comes from the next project, as the file's Ctrl+T symbols do.
  outline(uri: string): CodeSymbol[] {
    const project = this.projectsOf(uri).find(({ failed }) => !failed);
    return project ? outlineFor(project.analysis, ResolvedFile.fromFileURL(uri)) : [];
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
  // cart's code proves wrong is not shown.
  warnings(uri: string): Warning[] {
    const [ first, ...others ] = this.projectsOf(uri).map(project => project.warnings.filter(warning => inThisFile(uri, warning)));
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

  workspaceSymbols(query: string): SymbolInformation[] {
    return searchSymbols(this.symbolItemsOfEachFile(), query).map(toSymbolInformation);
  }

  private projectsOf(uri: string): IndexedProject[] {
    return this.projects.filter(project => project.files.includes(uri));
  }

  // Each file once: an indexed file from the first project that contains it, as its outline comes; a file that only an
  // #include reads, like one in a dot-folder, from the first project whose analysis has it.
  private symbolItemsOfEachFile(): SymbolItem[] {
    const taken = new Set<string>();
    const lists: SymbolItem[][] = [];
    for (const project of this.projects) {
      const files = new Set(project.files);
      for (const [ uri, items ] of symbolItems(project.analysis)) {
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
        this.documents.set(uri, document);
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
// undefined when the file is gone. Parsing one the index never had, like a file in a dot-folder, would add it as a
// project of its own, with false warnings.
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
