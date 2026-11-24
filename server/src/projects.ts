import { Location } from 'vscode-languageserver/node';
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
import { rangeOf } from './ranges';

export type ProjectDocument = { textDocument: TextDocument, chunk: Chunk, errors: ParseError[] };

// A file is tracked when it has a .p8/.lua extension and none of its directory components below the
// matching root starts with a dot, matching the recursive scan's behaviour of not descending into
// hidden directories. With no matching root, only the extension is checked.
export function isTrackedPath(filePath: string, roots: string[]): boolean {
  if (!(/\.(p8|lua)$/i.test(filePath))) {
    return false;
  }
  const normalizedFile = path.normalize(filePath);
  const matchingRoot = roots.map(r => path.normalize(r))
    .find(r => normalizedFile.startsWith(r + path.sep) || normalizedFile === r);
  if (matchingRoot === undefined) {
    return true;
  }
  const relative = normalizedFile.slice(matchingRoot.length + path.sep.length);
  return relative.split(path.sep).slice(0, -1).every(part => !part.startsWith('.'));
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

// Reads a file through the URI form VS Code uses (ResolvedFile.fromPath(p).fileURL): open documents and cached
// workspace text first, then disk.
export function makeFileResolver(openText: (uri: string) => string | undefined, disk: FileResolver = new RealFileResolver()): FileResolver {
  const textAt = (filepath: string) => openText(ResolvedFile.fromPath(filepath).fileURL);
  return {
    doesFileExist: filepath => textAt(filepath) !== undefined || disk.doesFileExist(filepath),
    isFile: filepath => textAt(filepath) !== undefined || disk.isFile(filepath),
    loadFileContents: filepath => textAt(filepath) ?? disk.loadFileContents(filepath),
  };
}

// The file's current text, parsed; undefined when it cannot be read.
export type ParseFile = (uri: string) => ProjectDocument | undefined;

type IndexedProject = { root: string, files: string[], analysis: Analysis, warnings: Warning[] };

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
    const dropped = this.reparse(uris);
    this.buildProjects();
    this.projects.forEach(project => this.analyse(project));
    return [ ...this.documents.keys(), ...dropped ];
  }

  // Returns the URIs whose diagnostics to send again. After the projects are rebuilt, that is every known one, so that a
  // file that left a project loses that project's warnings, and every dropped one.
  update(uri: string): string[] {
    const isNew = !this.documents.has(uri);
    const document = this.parseFile(uri);
    if (!document) {
      return this.remove(uri);
    }
    const includedBefore = includedUris(this.documents.get(uri));
    this.documents.set(uri, document);
    // A new file may resolve #includes that previously failed: the parser does not add a failed include
    // to chunk.includes, so the includer is never re-parsed until every known document is refreshed.
    if (isNew) {
      return this.scan([ ...this.documents.keys() ]);
    }
    let rebuilt = !sameSet(includedBefore, includedUris(document)) || this.projectsOf(uri).length === 0;
    if (rebuilt) {
      this.buildProjects();
    }
    const containing = this.projectsOf(uri);
    const dropped = this.reparse(containing.map(project => project.root).filter(root => root !== uri));
    if (dropped.length > 0) {
      this.buildProjects();
      rebuilt = true;
    }
    (rebuilt ? this.projects : containing).forEach(project => this.analyse(project));
    return rebuilt ? [ ...this.documents.keys(), ...dropped ] : unique([ uri, ...containing.flatMap(project => project.files) ]);
  }

  remove(uri: string): string[] {
    const roots = this.projectsOf(uri).map(project => project.root).filter(root => root !== uri);
    this.documents.delete(uri);
    const dropped = this.reparse(roots);
    this.buildProjects();
    this.projects.forEach(project => this.analyse(project));
    return [ ...this.documents.keys(), uri, ...dropped ];
  }

  outline(uri: string): CodeSymbol[] {
    const [ first ] = this.projectsOf(uri);
    return first ? outlineFor(first.analysis, ResolvedFile.fromFileURL(uri)) : [];
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

  private projectsOf(uri: string): IndexedProject[] {
    return this.projects.filter(project => project.files.includes(uri));
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
    this.projects = trees
      .map(project => ({
        root: project.root.document.textDocument.uri, files: getProjectFiles(project), analysis: emptyAnalysis(), warnings: [],
      }))
      .sort((a, b) => compare(a.root, b.root));
  }

  // A file that cannot be parsed now is dropped, as update drops it, so that nothing is analysed from its old text.
  // Returns the dropped ones.
  private reparse(uris: string[]): string[] {
    const dropped: string[] = [];
    for (const uri of uris) {
      const document = this.parseFile(uri);
      if (document) {
        this.documents.set(uri, document);
      } else {
        this.documents.delete(uri);
        dropped.push(uri);
      }
    }
    return dropped;
  }

  // Never keeps an earlier result: one that failed gives way to an empty analysis.
  private analyse(project: IndexedProject): void {
    try {
      project.analysis = analyze(this.documents.get(project.root)!.chunk);
      project.warnings = warningsOf(project.analysis);
    } catch (e) {
      console.error(`Failed to analyse the project of ${project.root}`, e);
      project.analysis = emptyAnalysis();
      project.warnings = [];
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
