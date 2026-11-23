import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import { ParseError, Warning } from './parser/errors';

export function toDiagnostic(err: ParseError | Warning): Diagnostic {
  return {
    message: err.message,
    range: {
      start: { line: err.bounds.start.line - 1, character: err.bounds.start.column },
      end: { line: err.bounds.end.line - 1, character: err.bounds.end.column },
    },
    severity: err.type === 'ParseError' ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
    source: 'PICO-8-LS',
  };
}

export function inThisFile(documentUri: string, err: ParseError | Warning): boolean {
  return documentUri === err.bounds.start.filename.fileURL;
}

export function errorsInFile(uri: string, errors: ParseError[]): ParseError[] {
  return errors.filter(e => inThisFile(uri, e));
}

export type FileDiagnostics = { uri: string, diagnostics: Diagnostic[] };

// Returns one entry per unique URI: first the URIs from uris (deduplicated, in
// order of first appearance), then any additional URIs that appear only in
// warnings. Each entry lists the file's parse errors first, then its warnings,
// up to maxPerFile in all.
export function mergeDiagnostics(
  uris: string[],
  parseErrors: ReadonlyMap<string, ParseError[]>,
  warnings: Warning[],
  maxPerFile?: number,
): FileDiagnostics[] {
  const seen = new Set<string>();
  const orderedUris: string[] = [];

  for (const uri of uris) {
    if (!seen.has(uri)) {
      seen.add(uri);
      orderedUris.push(uri);
    }
  }

  for (const w of warnings) {
    const uri = w.bounds.start.filename.fileURL;
    if (!seen.has(uri)) {
      seen.add(uri);
      orderedUris.push(uri);
    }
  }

  return orderedUris.map(uri => {
    const errors = parseErrors.get(uri) ?? [];
    const fileWarnings = warnings.filter(w => w.bounds.start.filename.fileURL === uri);
    return {
      uri,
      diagnostics: [
        ...errors.map(toDiagnostic),
        ...fileWarnings.map(toDiagnostic),
      ].slice(0, maxPerFile),
    };
  });
}
