// Finds the ways that model code can turn the type checker off. The tools do not
// validate their inputs, so the type gate must not let these through:
//   explicit `any`, a double cast through `unknown`, and @ts-ignore style comments.
// This is a lexical scan, not a parse. It catches honest mistakes and shortcuts.
// It is not a security boundary: the sandbox is.
import type { GateDiagnostic } from "./diagnostics";

export const ESCAPE_ANY = 90001;
export const ESCAPE_DOUBLE_CAST = 90002;
export const ESCAPE_DIRECTIVE = 90003;

const MESSAGES: Record<number, string> = {
  [ESCAPE_ANY]:
    "Explicit 'any' is not allowed. The tools trust the types, so the code must type-check without 'any'. Use the declared types, or 'unknown' and narrow it.",
  [ESCAPE_DOUBLE_CAST]:
    "A cast through 'unknown' ('as unknown as T') is not allowed. Build a value of the declared type, or narrow it with a check.",
  [ESCAPE_DIRECTIVE]:
    "Comments that turn type checking off (@ts-ignore, @ts-expect-error, @ts-nocheck) are not allowed. Fix the type error.",
};

// Words after which a "/" starts a regular expression, not a division.
const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "do", "else", "in", "of", "void", "await", "yield", "delete", "new"]);

type Scan = {
  /** The code with strings, template text, regex literals and comments replaced by spaces. Newlines stay. */
  code: string;
  comments: { start: number; text: string }[];
};

/** Replaces everything that is not code with spaces, so a search of the result finds only code. */
export function scanCode(source: string): Scan {
  const out = source.split("");
  const comments: Scan["comments"] = [];
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (out[i] !== "\n") out[i] = " ";
  };
  // Each open template literal pushes the brace depth at its `${`.
  const templates: number[] = [];
  let braces = 0;
  let i = 0;

  const previousSignificant = (at: number) => {
    let j = at - 1;
    while (j >= 0 && /\s/.test(out[j]!)) j--;
    if (j < 0) return { char: "", word: "" };
    let k = j;
    while (k >= 0 && /[\w$]/.test(out[k]!)) k--;
    return { char: out[j]!, word: out.slice(k + 1, j + 1).join("") };
  };

  // Skips template text from `i` (just after a backtick or a closing `}`) to the
  // closing backtick or the next `${`.
  const templateText = () => {
    const start = i;
    while (i < source.length) {
      if (source[i] === "\\") i += 2;
      else if (source[i] === "`") {
        blank(start, i);
        i++;
        return;
      } else if (source[i] === "$" && source[i + 1] === "{") {
        blank(start, i);
        i += 2;
        templates.push(braces);
        braces++;
        return;
      } else i++;
    }
    blank(start, i);
  };

  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i) === -1 ? source.length : source.indexOf("\n", i);
      comments.push({ start: i, text: source.slice(i, end) });
      blank(i, end);
      i = end;
    } else if (c === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      const end = close === -1 ? source.length : close + 2;
      comments.push({ start: i, text: source.slice(i, end) });
      blank(i, end);
      i = end;
    } else if (c === '"' || c === "'") {
      const start = i++;
      while (i < source.length && source[i] !== c && source[i] !== "\n") i += source[i] === "\\" ? 2 : 1;
      blank(start, ++i);
    } else if (c === "`") {
      out[i++] = " ";
      templateText();
    } else if (c === "{") {
      braces++;
      i++;
    } else if (c === "}") {
      braces--;
      i++;
      if (templates.length && templates[templates.length - 1] === braces) {
        templates.pop();
        templateText();
      }
    } else if (c === "/") {
      const previous = previousSignificant(i);
      const isRegex = !/[\w$)\]]/.test(previous.char) || REGEX_AFTER_WORD.has(previous.word);
      if (!isRegex) {
        i++;
        continue;
      }
      const start = i++;
      let inClass = false;
      while (i < source.length && source[i] !== "\n") {
        if (source[i] === "\\") i++;
        else if (source[i] === "[") inClass = true;
        else if (source[i] === "]") inClass = false;
        else if (source[i] === "/" && !inClass) break;
        i++;
      }
      blank(start, ++i);
    } else i++;
  }
  return { code: out.join(""), comments };
}

function position(source: string, offset: number) {
  const before = source.slice(0, offset).split("\n");
  return { line: before.length, column: before[before.length - 1]!.length + 1 };
}

/** Diagnostics for each escape hatch in the model's code, at 1-based lines and columns. */
export function findEscapes(source: string): GateDiagnostic[] {
  const { code, comments } = scanCode(source);
  const found: { offset: number; code: number }[] = [];
  // `any` as a word, but not as a property name (`x.any`, `{ any: 1 }`).
  for (const match of code.matchAll(/(?<![.\w$])any\b(?!\s*:)/g)) found.push({ offset: match.index, code: ESCAPE_ANY });
  for (const match of code.matchAll(/\bas\s+unknown\s+as\b/g)) found.push({ offset: match.index, code: ESCAPE_DOUBLE_CAST });
  for (const comment of comments) {
    const match = /@ts-(ignore|expect-error|nocheck)\b/.exec(comment.text);
    if (match) found.push({ offset: comment.start + match.index, code: ESCAPE_DIRECTIVE });
  }
  return found
    .sort((a, b) => a.offset - b.offset)
    .map(({ offset, code: diagnosticCode }) => ({
      file: "main.ts",
      ...position(source, offset),
      code: diagnosticCode,
      category: "error" as const,
      message: MESSAGES[diagnosticCode]!,
    }));
}
