// The type gate. One tsc run in a fresh ts-rust instance both checks the model's
// TypeScript against the tool declarations and emits the JavaScript to run.
// `noEmitOnError` means that a script with errors produces no JavaScript at all.
import tsRust from "./ts-rust/ts_rust.wasm";
import { memoryFileSystem, runTsc } from "./ts-rust/core.js";
import { mapDiagnostic, type GateDiagnostic, type SourceLayout } from "./diagnostics";
import { findEscapes } from "./escapes";

const MAIN_PATH = "/app/main.ts";
const EMIT_PATH = "/app/main.js";

// The model writes the body of an async function. Wrapping it keeps `return` and
// top-level `await` legal, and `export {}` makes the file a module, so its names
// do not collide with the global declarations. The head is one line, so model
// line N is tsc line N (zero-based) and columns do not move.
const WRAP_HEAD = "async function __codemode_main() {\n";
const WRAP_TAIL = "\n}\nexport {};\n";
const EMIT_TAIL = /\n?\}\nexport \{\};\s*$/;

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    target: "es2022",
    module: "esnext",
    lib: ["es2022"],
    types: [],
    noEmitOnError: true,
    // The declarations are generated, so skip checking them and the lib files.
    skipLibCheck: true,
    newLine: "lf",
  },
  files: ["tools.d.ts", "main.ts"],
});

// One checker: on one WASM thread, more checkers cost memory and time.
const TSC_ARGS = ["-p", "/app", "--checkers", "1"];

export type GateResult = {
  ok: boolean;
  /** The emitted JavaScript, without the wrapper. Only when `ok`. */
  js?: string;
  diagnostics: GateDiagnostic[];
  exitCode: number;
  memoryBytes: number;
  stderr: string;
};

// Replace one surrounding markdown fence with empty lines, so line numbers stay the same.
const FENCE_OPEN = /^\s*```[\w-]*[ \t]*\n/;
const FENCE_CLOSE = /\n[ \t]*```\s*$/;

export function blankFences(code: string): string {
  if (!FENCE_OPEN.test(code) || !FENCE_CLOSE.test(code)) return code;
  return code.replace(FENCE_OPEN, (fence) => fence.replace(/[^\n]/g, "")).replace(FENCE_CLOSE, "\n");
}

function unwrapEmit(js: string): string | undefined {
  if (!js.startsWith(WRAP_HEAD) || !EMIT_TAIL.test(js)) return undefined;
  return js.slice(WRAP_HEAD.length).replace(EMIT_TAIL, "\n");
}

/**
 * Checks `code` against `toolsDts` and, when it has no errors, returns the
 * JavaScript to run. A crash inside tsc (for example a stack overflow) throws.
 */
export function typecheckAndEmit(code: string, toolsDts: string): GateResult {
  const source = blankFences(code);
  const layout: SourceLayout = {
    mainPath: MAIN_PATH,
    lineOffset: 1,
    modelLines: source.split("\n").length,
  };
  const fs = memoryFileSystem({
    "/app/tsconfig.json": TSCONFIG,
    "/app/tools.d.ts": toolsDts,
    [MAIN_PATH]: `${WRAP_HEAD}${source}${WRAP_TAIL}`,
  });

  let stderr = "";
  const decoder = new TextDecoder();
  const result = runTsc(tsRust, {
    args: TSC_ARGS,
    cwd: "/app",
    fs,
    diagnosticsJson: true,
    env: { NO_COLOR: "1" },
    stderr: (chunk: Uint8Array) => (stderr += decoder.decode(chunk)),
  });

  // tsc accepts `any` and @ts-ignore, so a separate scan rejects them. Both lists
  // go back together, in source order, so the model can fix everything at once.
  const diagnostics = [...(result.diagnostics ?? []).map((d) => mapDiagnostic(d, layout)), ...findEscapes(source)].sort(
    (a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0),
  );
  const hasErrors = diagnostics.some((d) => d.category === "error");
  const emitted = fs.files.get(EMIT_PATH);
  const js = hasErrors || emitted === undefined ? undefined : unwrapEmit(emitted);
  return {
    ok: js !== undefined,
    js,
    diagnostics,
    exitCode: result.exitCode,
    memoryBytes: result.memoryBytes,
    stderr,
  };
}
