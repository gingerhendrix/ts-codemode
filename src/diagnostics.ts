// Turns ts-rust JSON diagnostics into diagnostics on the model's own source:
// 1-based lines and columns in the code the model sent, not in the wrapped file.
import type { Diagnostic } from "./ts-rust/core.js";

export type GateDiagnostic = {
  /** "main.ts" is the model's code. Other names are the declarations or a lib file. */
  file?: string;
  /** 1-based. */
  line?: number;
  /** 1-based, in UTF-16 code units. */
  column?: number;
  endLine?: number;
  endColumn?: number;
  code: number;
  category: "warning" | "error" | "suggestion" | "message";
  message: string;
  related?: GateDiagnostic[];
};

/** Where the model's code sits inside the checked file. */
export type SourceLayout = {
  /** Absolute path of the wrapped file in the memory file system. */
  mainPath: string;
  /** Lines that the wrapper puts before the model's first line. */
  lineOffset: number;
  /** Number of lines in the model's code. */
  modelLines: number;
};

const CATEGORY = ["warning", "error", "suggestion", "message"] as const;

function flattenMessage(diagnostic: Diagnostic, depth = 0): string {
  const own = `${"  ".repeat(depth)}${diagnostic.text}`;
  const chain = (diagnostic.messageChain ?? []).map((next) => flattenMessage(next, depth + 1));
  return [own, ...chain].join("\n");
}

function shortName(fileName: string, layout: SourceLayout): string {
  if (fileName === layout.mainPath) return "main.ts";
  return fileName.startsWith("/app/") ? fileName.slice("/app/".length) : fileName;
}

/** Zero-based tsc position to a 1-based position in the model's source. */
function toModelPosition(position: { line: number; character: number }, layout: SourceLayout) {
  const line = position.line - layout.lineOffset + 1;
  // Positions on the wrapper's own lines (an unclosed brace, for example) are
  // clamped to the first or last line of the model's code.
  if (line < 1) return { line: 1, column: 1 };
  if (line > layout.modelLines) return { line: layout.modelLines, column: 1 };
  return { line, column: position.character + 1 };
}

export function mapDiagnostic(diagnostic: Diagnostic, layout: SourceLayout): GateDiagnostic {
  const mapped: GateDiagnostic = {
    code: diagnostic.code,
    category: CATEGORY[diagnostic.category] ?? "error",
    message: flattenMessage(diagnostic),
  };
  if (diagnostic.fileName) {
    mapped.file = shortName(diagnostic.fileName, layout);
    const inMain = diagnostic.fileName === layout.mainPath;
    const place = (position: { line: number; character: number }) =>
      inMain ? toModelPosition(position, layout) : { line: position.line + 1, column: position.character + 1 };
    if (diagnostic.startPosition) {
      const start = place(diagnostic.startPosition);
      mapped.line = start.line;
      mapped.column = start.column;
    }
    if (diagnostic.endPosition) {
      const end = place(diagnostic.endPosition);
      mapped.endLine = end.line;
      mapped.endColumn = end.column;
    }
  }
  if (diagnostic.relatedInformation?.length) {
    mapped.related = diagnostic.relatedInformation.map((related) => mapDiagnostic(related, layout));
  }
  return mapped;
}

/** One text block in the familiar tsc style, for a model to read. */
export function formatDiagnostics(diagnostics: GateDiagnostic[]): string {
  const formatOne = (d: GateDiagnostic, indent: string): string => {
    const where = d.file ? `${d.file}${d.line ? `:${d.line}:${d.column}` : ""} - ` : "";
    const head = `${indent}${where}${d.category} TS${d.code}: ${d.message.replace(/\n/g, `\n${indent}`)}`;
    const related = (d.related ?? []).map((r) => formatOne(r, `${indent}    `));
    return [head, ...related].join("\n");
  };
  return diagnostics.map((d) => formatOne(d, "")).join("\n");
}
