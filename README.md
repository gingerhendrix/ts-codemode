# ts-codemode

> **Status: proof of concept.** It has no authentication, no input limits and no production hardening. Do not leave it deployed on a public URL.

A Cloudflare Worker for a code mode in which the model writes **TypeScript**. [ts-rust](https://github.com/pingdotgg/ts-rust) (WASM) checks the code against the generated tool declarations. Only code with no type errors runs. It runs in a Dynamic Worker through [`@cloudflare/codemode`](https://www.npmjs.com/package/@cloudflare/codemode) 0.5.3.

The ts-rust WASM module and its JavaScript host layer come from [`cf-ts-rust`](https://github.com/gingerhendrix/cf-ts-rust). This repo has a copy. See [`src/ts-rust/VENDORED.md`](src/ts-rust/VENDORED.md).

## What the type gate gives you

The model gets tsc errors for every input and output schema mistake before any code runs. The tools need no run-time validation step: the gate is the check.

`POST /?gate=off` runs the same code as Cloudflare's JavaScript code mode would. There is no type check, and each tool checks its input when it is called. `test/schema-errors.test.ts` sends the same scripts to both modes:

| Mistake | `POST /` (type gate) | `POST /?gate=off` (baseline) |
|---|---|---|
| Wrong input type, after a write | TS2322 at the line and column. Nothing runs. | Run-time error. The write before it already happened. |
| Missing or misspelled input property, enum value | TS2741, TS2353, TS2322 | Run-time error when that call runs |
| Misspelled output property (`c.captial`) | TS2551: "Did you mean 'capital'?" | `ok: true`, result `"Capital: undefined"` |
| Result object used as a value (`r + 1`) | TS2365 | `ok: true`, result `"[object Object]1"` |
| Wrapper object used as an array (`keys.length`) | TS2339 | `ok: true`, result `undefined` |
| Nullable output used without a check | TS18047 | Run-time `TypeError`, only when the value is null |
| Two mistakes on one line | Both errors in one reply | The first only, with a misleading message |

The gate also rejects the ways to switch the checker off: explicit `any`, `as unknown as`, and `@ts-ignore`, `@ts-expect-error` or `@ts-nocheck` comments (`src/escapes.ts`, codes TS90001 to TS90003). `JSON.parse` returns `unknown`, so its value must be narrowed before a tool call. The escape scan is lexical. It stops mistakes and shortcuts, but it is not a security boundary. The sandbox is.

## How it works

```text
POST / { code }
  1. typegate.ts   blank one markdown fence, wrap the code in an async function,
                   run tsc once in a fresh ts-rust instance (noEmitOnError),
                   and scan for any, "as unknown as" and @ts-ignore (escapes.ts):
                   errors    -> diagnostics at the model's lines, nothing runs
                   no errors -> the emitted JavaScript
  2. run.ts        codemode normalizeCode -> DynamicWorkerExecutor
                   (one new Dynamic Worker for each run, no network)
                   codemode.* calls -> RPC -> tools.ts on the host
  3. index.ts      { ok, phase, diagnostics?, result?, error?, logs?, timings, memory }
```

| File | Job |
|---|---|
| `src/index.ts` | The Worker. `GET /` gives the tool definition. `POST /` checks and runs. |
| `src/tools.ts` | Demo tools on the host: a key-value store (`kvGet`, `kvSet`, `kvList`), `calculate` and `lookupCountry`. Each has input and output JSON Schemas. They trust their inputs, because the gate checked them. |
| `src/declarations.ts` | `tools.d.ts` from codemode's `generateTypesFromJsonSchema`, a `console` declaration, and the model-facing description. |
| `src/typegate.ts` | Check and emit in one `tsc` run. |
| `src/diagnostics.ts` | Maps ts-rust diagnostics back to the model's lines and columns. |
| `src/escapes.ts` | Finds explicit `any`, `as unknown as` and type-checking directive comments in the model's code. |
| `src/baseline.ts` | The `?gate=off` comparison mode: a run-time JSON Schema input check in front of each tool. |
| `src/run.ts` | Runs the JavaScript with `DynamicWorkerExecutor`. |
| `src/ts-rust/` | Vendored `ts_rust.wasm`, `core.js` and `core.d.ts`. |

## Run it

You need Bun, and Node 23.6 or later for the tests (they use Node type stripping).

```bash
bun install
bun run dev        # wrangler dev on http://127.0.0.1:8800
curl -s http://127.0.0.1:8800/      # the tool for a model: name, description, inputSchema, types
curl -s -X POST http://127.0.0.1:8800/ -d '{"code":"const r = await codemode.calculate({ op: \"add\", a: 1, b: 2 });\nreturn r.result;"}'
```

On a type error, `phase` is `"typecheck"`, and `error` holds the diagnostics in tsc text form. The code can be a function body with `return`, a single async arrow function, or statements that end in an expression. One surrounding markdown fence is allowed.

The Dynamic Workers need the `worker_loaders` binding in `wrangler.jsonc`. Local `wrangler dev` supports it. Hosted Dynamic Workers need the Workers Paid plan.

## Test it

```bash
bun run test        # node --test: starts the Worker in local workerd and sends real requests
bun run typecheck
bun run size        # wrangler deploy --dry-run: bundle size
```

`bun test` does not work here, because it stops the workerd child process after each test.

## Licenses

The code in this repository is under the [WTFPL](https://www.wtfpl.net/), version 2. See [`LICENSE`](LICENSE).

The WTFPL does not apply to the files in `src/ts-rust/`. They come from ts-rust (MIT, T3 Tools Inc.), and the WASM module holds TypeScript (Apache 2.0) and Go (BSD 3-Clause) code. The license and notice files are in [`third_party/ts-rust/`](third_party/ts-rust/). `@cloudflare/codemode` is MIT.
