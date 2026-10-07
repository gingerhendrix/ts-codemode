// Runs checked JavaScript with Cloudflare codemode's DynamicWorkerExecutor.
// Each run is a fresh Dynamic Worker with no network. Tool calls come back to
// the host over Workers RPC, where the demo tools run.
import { DynamicWorkerExecutor, normalizeCode, resolveProvider, type ExecuteResult } from "@cloudflare/codemode";
import { demoTools } from "./tools";
import { withInputValidation } from "./validate";

// The executor's timeout is a Promise.race in the sandbox. It ends slow awaits,
// but it cannot stop a synchronous CPU loop.
const RUN_TIMEOUT_MS = 10_000;

// Each tool checks its input against its schema before execute runs.
const tools = withInputValidation(demoTools);

/**
 * tsc ends every statement with `;`. codemode's normalizeCode passes a lone arrow
 * function through unchanged, and the executor then calls `(<code>)()`, so
 * `async () => {...};` would be a syntax error. Normalize here and drop that `;`.
 */
export function toExecutorCode(js: string): string {
  return normalizeCode(js).replace(/;\s*$/, "");
}

export async function runInDynamicWorker(js: string, loader: WorkerLoader): Promise<ExecuteResult> {
  const executor = new DynamicWorkerExecutor({ loader, globalOutbound: null, timeout: RUN_TIMEOUT_MS });
  try {
    return await executor.execute(toExecutorCode(js), [resolveProvider({ name: "codemode", tools })]);
  } catch (error: any) {
    // The contract says execute never throws, but a module that fails to load
    // (a syntax error, for example) rejects from loader.load().
    return { result: undefined, error: `${error?.name ?? "Error"}: ${error?.message ?? error}` };
  }
}
