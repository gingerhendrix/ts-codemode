// A TypeScript code mode Worker.
// GET  returns the model-facing tool definition with the generated types.
// POST { code } type-checks the TypeScript and, only when it has no errors, runs it:
//   { ok, phase: "typecheck" | "run", diagnostics?, result?, error?, logs?, timings, memory? }
// POST /?gate=off { code } is the baseline for comparison: it runs the code as
// JavaScript with no type check, and the tools check their inputs at run time.
import { withInputValidation } from "./baseline";
import { describeCodeTool, TOOLS_DTS } from "./declarations";
import { formatDiagnostics } from "./diagnostics";
import { runInDynamicWorker } from "./run";
import { demoTools } from "./tools";
import { typecheckAndEmit } from "./typegate";

export type CodemodeEnv = { LOADER: WorkerLoader };

let requestsInIsolate = 0;

const baselineTools = withInputValidation(demoTools);

function mib(bytes: number) {
  return +(bytes / 2 ** 20).toFixed(1);
}

async function readCode(request: Request): Promise<string> {
  const body = (await request.json()) as { code?: unknown };
  if (typeof body?.code !== "string") throw new Error("expected { code: string }");
  return body.code;
}

async function handleCodemode(request: Request, env: CodemodeEnv): Promise<Response> {
  if (request.method !== "POST") return Response.json(describeCodeTool());

  let code: string;
  try {
    code = await readCode(request);
  } catch (error) {
    return Response.json({ ok: false, error: String(error) }, { status: 400 });
  }

  const cold = requestsInIsolate++ === 0;
  const start = performance.now();
  const timings = (extra: Record<string, number>) => ({
    ...extra,
    totalMs: performance.now() - start,
    cold,
    requestsInIsolate,
  });

  if (new URL(request.url).searchParams.get("gate") === "off") {
    const run = await runInDynamicWorker(code, env.LOADER, baselineTools);
    return Response.json({
      ok: run.error === undefined,
      phase: "run",
      gate: "off",
      result: run.result,
      ...(run.error !== undefined ? { error: run.error } : {}),
      logs: run.logs ?? [],
      timings: timings({ runMs: performance.now() - start }),
    });
  }

  let gate;
  try {
    gate = typecheckAndEmit(code, TOOLS_DTS);
  } catch (error: any) {
    // tsc itself crashed, for example on a stack overflow. Nothing runs.
    return Response.json({
      ok: false,
      phase: "typecheck",
      error: `type checker crashed: ${error?.name}: ${error?.message}`,
      timings: timings({ checkMs: performance.now() - start }),
    });
  }
  const checkMs = performance.now() - start;
  const memory = { linearMiB: mib(gate.memoryBytes) };

  if (!gate.ok || gate.js === undefined) {
    const error = gate.diagnostics.length
      ? formatDiagnostics(gate.diagnostics)
      : `type check produced no JavaScript (exit ${gate.exitCode}) ${gate.stderr}`.trim();
    return Response.json({
      ok: false,
      phase: "typecheck",
      diagnostics: gate.diagnostics,
      error,
      timings: timings({ checkMs }),
      memory,
    });
  }

  const runStart = performance.now();
  const run = await runInDynamicWorker(gate.js, env.LOADER);
  const runMs = performance.now() - runStart;
  return Response.json({
    ok: run.error === undefined,
    phase: "run",
    // Warnings and suggestions do not block a run, but the model may want them.
    ...(gate.diagnostics.length ? { diagnostics: gate.diagnostics } : {}),
    result: run.result,
    ...(run.error !== undefined ? { error: run.error } : {}),
    logs: run.logs ?? [],
    timings: timings({ checkMs, runMs }),
    memory,
  });
}

export default {
  fetch: handleCodemode,
} satisfies ExportedHandler<CodemodeEnv>;
