// The TypeScript code mode Worker in local workerd: type gate, then a
// Dynamic Worker run with the demo tools.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { unstable_startWorker } from "wrangler";

type Worker = Awaited<ReturnType<typeof unstable_startWorker>>;

let worker: Worker;

before(async () => {
  worker = await unstable_startWorker({ config: "wrangler.jsonc", dev: { server: { port: 0 }, inspector: false } });
  await worker.ready;
});

after(async () => {
  await worker?.dispose();
});

async function run(code: string) {
  const response = await worker.fetch("http://example.com/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  return { status: response.status, json: (await response.json()) as any };
}

// Each test uses its own keys, because the store lives for the whole isolate.
const uniqueKey = (name: string) => `${name}-${Math.random().toString(36).slice(2)}`;

describe("GET /", () => {
  test("returns the model-facing tool with the generated types", async () => {
    const response = await worker.fetch("http://example.com/");
    const json = (await response.json()) as any;
    assert.equal(response.status, 200);
    assert.equal(json.name, "codemode");
    assert.deepEqual(json.inputSchema.required, ["code"]);
    assert.match(json.types, /declare const codemode: \{/);
    assert.match(json.types, /kvGet: \(input: KvGetInput\) => Promise<KvGetOutput>;/);
    assert.match(json.types, /op: "add" \| "subtract" \| "multiply" \| "divide";/);
    assert.match(json.types, /declare const console/);
    assert.ok(json.description.includes(json.types), "description embeds the types");
    assert.match(json.description, /Execute TypeScript/);
  });
});

describe("POST /: valid code runs", () => {
  test("a script that calls tools returns the result and logs", async () => {
    const key = uniqueKey("valid");
    const { status, json } = await run(
      [
        `const country = await codemode.lookupCountry({ code: "jp" });`,
        `await codemode.kvSet({ key: "${key}", value: country.capital });`,
        `const stored = await codemode.kvGet({ key: "${key}" });`,
        `const doubled = await codemode.calculate({ op: "multiply", a: country.population, b: 2 });`,
        `console.log("capital", stored.value);`,
        `return { capital: stored.value, doubled: doubled.result };`,
      ].join("\n"),
    );
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.phase, "run");
    assert.deepEqual(json.result, { capital: "Tokyo", doubled: 248_000_000 });
    assert.deepEqual(json.logs, ["capital Tokyo"]);
    assert.equal(json.diagnostics, undefined);
    assert.equal(typeof json.timings.checkMs, "number");
    assert.equal(typeof json.timings.runMs, "number");
    assert.ok(json.memory.linearMiB < 32, `linear memory ${json.memory.linearMiB} MiB`);
  });

  test("TypeScript-only syntax type-checks and runs", async () => {
    const { json } = await run(
      [
        `interface Summary { label: string; total: number }`,
        `type Op = CalculateInput["op"];`,
        `enum Scale { One = 1, Ten = 10 }`,
        `function first<T>(items: readonly T[]): T { return items[0]!; }`,
        `const op: Op = "add";`,
        `const r = (await codemode.calculate({ op, a: first([2, 3]), b: Scale.Ten })) satisfies CalculateOutput;`,
        `const label = "sum" as const;`,
        `return { label, total: r.result } satisfies Summary;`,
      ].join("\n"),
    );
    assert.equal(json.ok, true, json.error);
    assert.deepEqual(json.result, { label: "sum", total: 12 });
  });

  test("an async arrow function, as Cloudflare's prompt asks for, also runs", async () => {
    const { json } = await run(`async () => { const r = await codemode.calculate({ op: "subtract", a: 9, b: 4 }); return r.result; }`);
    assert.equal(json.ok, true, json.error);
    assert.equal(json.result, 5);
  });

  test("the last expression is the result", async () => {
    const { json } = await run(`const n: number = 6;\ncodemode.calculate({ op: "multiply", a: n, b: 7 })`);
    assert.equal(json.ok, true, json.error);
    assert.deepEqual(json.result, { result: 42 });
  });
});

describe("POST /: type errors block the run", () => {
  test("wrong argument type and unknown method give diagnostics at the model's lines, and nothing runs", async () => {
    const key = uniqueKey("blocked");
    const { status, json } = await run(
      [
        `await codemode.kvSet({ key: "${key}", value: "written" });`,
        `const r = await codemode.calculate({ op: "add", a: "2", b: 3 });`,
        `await codemode.deleteEverything();`,
        `return r.result;`,
      ].join("\n"),
    );
    assert.equal(status, 200);
    assert.equal(json.ok, false);
    assert.equal(json.phase, "typecheck");
    assert.equal(json.result, undefined);
    assert.equal(json.logs, undefined);
    assert.deepEqual(
      json.diagnostics.map((d: any) => [d.file, d.line, d.column, d.code]),
      [
        ["main.ts", 2, 49, 2322], // tsc marks the property name a in a: "2"
        ["main.ts", 3, 16, 2339], // deleteEverything
      ],
    );
    assert.match(json.diagnostics[1].message, /Property 'deleteEverything' does not exist/);
    assert.equal(json.diagnostics[0].related[0].file, "tools.d.ts");
    assert.match(json.error, /^main\.ts:2:49 - error TS2322: Type 'string' is not assignable to type 'number'\./);

    // Line 1 of the blocked script would have written the key. It must not exist.
    const probe = await run(`return await codemode.kvGet({ key: "${key}" });`);
    assert.equal(probe.json.ok, true, probe.json.error);
    assert.deepEqual(probe.json.result, { key, found: false, value: null });
  });

  test("a type error inside a markdown fence keeps its line number", async () => {
    const { json } = await run("```ts\nconst n: number = 1;\nconst s: string = n;\nreturn s;\n```");
    assert.equal(json.phase, "typecheck");
    assert.deepEqual(
      json.diagnostics.map((d: any) => [d.line, d.column, d.code]),
      [[3, 7, 2322]],
    );
  });

  test("names outside the declarations, such as fetch, are errors", async () => {
    const { json } = await run(`const r = await fetch("https://example.com");\nreturn r.status;`);
    assert.equal(json.phase, "typecheck");
    assert.equal(json.diagnostics[0].line, 1);
    assert.equal(json.diagnostics[0].code, 2304); // Cannot find name 'fetch'
  });
});

describe("POST /: run-time errors", () => {
  test("a script that throws returns the error after the check passes", async () => {
    const { status, json } = await run(`const n: number = 1;\nif (n > 0) throw new Error("boom");\nreturn n;`);
    assert.equal(status, 200);
    assert.equal(json.ok, false);
    assert.equal(json.phase, "run");
    assert.equal(json.error, "boom");
  });

  test("a tool that throws returns its message", async () => {
    const { json } = await run(`return await codemode.calculate({ op: "divide", a: 1, b: 0 });`);
    assert.equal(json.ok, false);
    assert.equal(json.phase, "run");
    assert.equal(json.error, "division by zero");
  });
});

describe("POST /: bad requests", () => {
  test("a body without code gives 400", async () => {
    const response = await worker.fetch("http://example.com/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "return 1" }),
    });
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as any).error, /expected \{ code: string \}/);
  });
});
