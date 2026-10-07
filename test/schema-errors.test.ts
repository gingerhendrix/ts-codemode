// The main win of the TypeScript code mode, side by side with the baseline.
// Each script is plain JavaScript, so the same text runs in both modes:
//   POST /            the type gate: tsc checks the calls and the use of each result
//   POST /?gate=off   stock-style code mode: no check, tools validate inputs at run time
// The gate must report input and output schema mistakes before anything runs.
// The baseline finds input mistakes only when the bad call runs, and never finds output mistakes.
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

async function post(path: string, code: string) {
  const response = await worker.fetch(`http://example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  return (await response.json()) as any;
}

const uniqueKey = (name: string) => `${name}-${Math.random().toString(36).slice(2)}`;

async function wasWritten(key: string): Promise<boolean> {
  const probe = await post("/", `return await codemode.kvGet({ key: "${key}" });`);
  assert.equal(probe.ok, true, probe.error);
  return probe.result.found;
}

type Scenario = {
  name: string;
  code: (key: string) => string;
  /** The gate: [line, column, TS code] for each diagnostic, and a part of the first message. */
  gate: { diagnostics: [number, number, number][]; message: RegExp };
  /** The baseline: an error at run time, or a run that "succeeds" with this result. */
  baseline: { error: RegExp } | { result: unknown };
  /** True when the baseline run wrote its key before it failed. */
  baselineWrites?: boolean;
};

const inputScenarios: Scenario[] = [
  {
    name: "wrong input type",
    code: (key) =>
      `await codemode.kvSet({ key: "${key}", value: "started" });\n` +
      `const r = await codemode.calculate({ op: "add", a: "2", b: 3 });\n` +
      `return r.result;`,
    gate: { diagnostics: [[2, 49, 2322]], message: /Type 'string' is not assignable to type 'number'/ },
    baseline: { error: /Invalid input for calculate: input\.a must be number, got string/ },
    baselineWrites: true,
  },
  {
    name: "missing required input",
    code: (key) => `await codemode.kvSet({ key: "${key}" });\nreturn "done";`,
    gate: { diagnostics: [[1, 22, 2741]], message: /Property 'value' is missing .* 'KvSetInput'/ },
    baseline: { error: /input\.value is required/ },
  },
  {
    name: "value outside an enum",
    code: () => `const r = await codemode.calculate({ op: "sum", a: 2, b: 3 });\nreturn r.result;`,
    gate: { diagnostics: [[1, 38, 2322]], message: /Type '"sum"' is not assignable/ },
    baseline: { error: /input\.op must be one of/ },
  },
  {
    name: "misspelled input property",
    code: () => `const c = await codemode.lookupCountry({ countryCode: "JP" });\nreturn c.name;`,
    gate: { diagnostics: [[1, 42, 2353]], message: /'countryCode' does not exist in type 'LookupCountryInput'/ },
    baseline: { error: /input\.code is required/ },
  },
];

const outputScenarios: Scenario[] = [
  {
    name: "misspelled output property",
    code: () => `const c = await codemode.lookupCountry({ code: "FR" });\nreturn "Capital: " + c.captial;`,
    gate: { diagnostics: [[2, 24, 2551]], message: /Did you mean 'capital'\?/ },
    baseline: { result: "Capital: undefined" },
  },
  {
    name: "result object used as a number",
    code: () => `const r = await codemode.calculate({ op: "multiply", a: 6, b: 7 });\nreturn r + 1;`,
    gate: { diagnostics: [[2, 8, 2365]], message: /Operator '\+' cannot be applied to types 'CalculateOutput' and 'number'/ },
    baseline: { result: "[object Object]1" },
  },
  {
    name: "wrapper object used as an array",
    code: () => `const keys = await codemode.kvList({});\nreturn keys.length;`,
    gate: { diagnostics: [[2, 13, 2339]], message: /Property 'length' does not exist on type 'KvListOutput'/ },
    baseline: { result: undefined },
  },
  {
    name: "nullable output used without a check",
    code: (key) => `const v = await codemode.kvGet({ key: "${key}" });\nreturn v.value.toUpperCase();`,
    gate: { diagnostics: [[2, 8, 18047]], message: /'v\.value' is possibly 'null'/ },
    baseline: { error: /Cannot read properties of null/ },
  },
];

const mixedScenarios: Scenario[] = [
  {
    name: "output of one tool passed to another with the wrong type",
    code: (key) =>
      `const c = await codemode.lookupCountry({ code: "KE" });\n` +
      `await codemode.kvSet({ value: c.population, key: "${key}" });\n` +
      `return "saved";`,
    gate: { diagnostics: [[2, 24, 2322]], message: /Type 'number' is not assignable to type 'string'/ },
    baseline: { error: /input\.value must be string, got number/ },
  },
  {
    // The baseline stops at the first bad call, after the write, and its message
    // points at the wrong thing: the typo makes `a` undefined, so `a` looks missing.
    name: "two mistakes in one script",
    code: (key) =>
      `await codemode.kvSet({ key: "${key}", value: "started" });\n` +
      `const c = await codemode.lookupCountry({ code: "BR" });\n` +
      `const r = await codemode.calculate({ op: "divide", a: c.populaton, b: "1000" });\n` +
      `return r.result.toFixed(1);`,
    gate: {
      diagnostics: [
        [3, 57, 2551],
        [3, 68, 2322],
      ],
      message: /Did you mean 'population'\?/,
    },
    baseline: { error: /Invalid input for calculate: input\.a is required/ },
    baselineWrites: true,
  },
];

function describeScenarios(title: string, scenarios: Scenario[]) {
  describe(title, () => {
    for (const scenario of scenarios) {
      test(`${scenario.name}: the gate reports it before the run`, async () => {
        const key = uniqueKey("gate");
        const json = await post("/", scenario.code(key));
        assert.equal(json.ok, false);
        assert.equal(json.phase, "typecheck");
        assert.deepEqual(
          json.diagnostics.map((d: any) => [d.line, d.column, d.code]),
          scenario.gate.diagnostics,
        );
        assert.match(json.diagnostics[0].message, scenario.gate.message);
        assert.equal(await wasWritten(key), false, "nothing ran");
      });

      test(`${scenario.name}: the baseline finds it late or not at all`, async () => {
        const key = uniqueKey("baseline");
        const json = await post("/?gate=off", scenario.code(key));
        assert.equal(json.phase, "run");
        assert.equal(json.gate, "off");
        if ("error" in scenario.baseline) {
          assert.equal(json.ok, false);
          assert.match(json.error, scenario.baseline.error);
        } else {
          assert.equal(json.ok, true, "the baseline reports success");
          assert.deepEqual(json.result, scenario.baseline.result);
        }
        assert.equal(await wasWritten(key), scenario.baselineWrites ?? false);
      });
    }
  });
}

describeScenarios("input schema mistakes", inputScenarios);
describeScenarios("output schema mistakes", outputScenarios);
describeScenarios("mistakes across tools", mixedScenarios);

describe("the run-time schema check still guards inputs that get past the types", () => {
  test("an `as any` input passes the gate, and the schema check stops the call", async () => {
    const key = uniqueKey("any");
    const json = await post(
      "/",
      [
        `await codemode.kvSet({ key: "${key}", value: "started" });`,
        `return await codemode.calculate({ op: "add", a: "2" as any, b: 3 });`,
      ].join("\n"),
    );
    assert.equal(json.phase, "run");
    assert.equal(json.ok, false);
    assert.match(json.error, /Invalid input for calculate: input\.a must be number, got string/);
    assert.equal(await wasWritten(key), true);
  });

  test("a JSON.parse value passes the gate, and the schema check stops the call", async () => {
    const json = await post("/", `const n = JSON.parse('"2"');\nreturn await codemode.calculate({ op: "add", a: n, b: 3 });`);
    assert.equal(json.phase, "run");
    assert.equal(json.ok, false);
    assert.match(json.error, /Invalid input for calculate: input\.a must be number, got string/);
  });
});
