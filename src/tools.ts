// Demo tools on the host. They are deterministic and each one has an input and an
// output JSON Schema, so the generated declarations are typed in both directions.
//
// The type gate runs code only when tsc proves that every call matches the input
// schema, and every use of a result matches the output schema. run.ts also checks
// each input against its schema at run time (validate.ts), so execute can trust
// its typed input. The host types below mirror the schemas, so
// `bun run typecheck` checks the outputs on this side.
import type { JsonSchemaToolDescriptor } from "@cloudflare/codemode";

type Tool<Input, Output> = JsonSchemaToolDescriptor & {
  execute: (input: Input) => Promise<Output>;
};

export type DemoTool = Tool<any, unknown>;

// One key-value store for each isolate. Tests use it to prove that a script with
// type errors never runs: its kvSet call must leave no value behind.
const store = new Map<string, string>();

const COUNTRIES: Record<string, { name: string; capital: string; population: number }> = {
  GB: { name: "United Kingdom", capital: "London", population: 68_300_000 },
  FR: { name: "France", capital: "Paris", population: 68_400_000 },
  JP: { name: "Japan", capital: "Tokyo", population: 124_000_000 },
  BR: { name: "Brazil", capital: "Brasília", population: 212_600_000 },
  KE: { name: "Kenya", capital: "Nairobi", population: 56_400_000 },
};

type Op = "add" | "subtract" | "multiply" | "divide";

const kvGet: Tool<{ key: string }, { key: string; found: boolean; value: string | null }> = {
  description: "Read one value from the key-value store.",
  inputSchema: {
    type: "object",
    properties: { key: { type: "string", description: "The key to read" } },
    required: ["key"],
  },
  outputSchema: {
    type: "object",
    properties: {
      key: { type: "string" },
      found: { type: "boolean" },
      value: { type: ["string", "null"], description: "null when the key is not set" },
    },
    required: ["key", "found", "value"],
  },
  execute: async ({ key }) => {
    const value = store.get(key);
    return { key, found: value !== undefined, value: value ?? null };
  },
};

const kvSet: Tool<{ key: string; value: string }, { key: string; previous: string | null }> = {
  description: "Write one string value to the key-value store.",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string", description: "The key to write" },
      value: { type: "string", description: "The new value" },
    },
    required: ["key", "value"],
  },
  outputSchema: {
    type: "object",
    properties: {
      key: { type: "string" },
      previous: { type: ["string", "null"], description: "The old value, or null" },
    },
    required: ["key", "previous"],
  },
  execute: async ({ key, value }) => {
    const previous = store.get(key) ?? null;
    store.set(key, value);
    return { key, previous };
  },
};

const kvList: Tool<{ prefix?: string }, { keys: string[] }> = {
  description: "List the keys in the key-value store, sorted.",
  inputSchema: {
    type: "object",
    properties: { prefix: { type: "string", description: "Only keys that start with this text" } },
  },
  outputSchema: {
    type: "object",
    properties: { keys: { type: "array", items: { type: "string" } } },
    required: ["keys"],
  },
  execute: async ({ prefix = "" }) => ({
    keys: [...store.keys()].filter((key) => key.startsWith(prefix)).sort(),
  }),
};

const calculate: Tool<{ op: Op; a: number; b: number }, { result: number }> = {
  description: "Do one arithmetic operation on two numbers.",
  inputSchema: {
    type: "object",
    properties: {
      op: { enum: ["add", "subtract", "multiply", "divide"], description: "The operation" },
      a: { type: "number", description: "The left operand" },
      b: { type: "number", description: "The right operand" },
    },
    required: ["op", "a", "b"],
  },
  outputSchema: {
    type: "object",
    properties: { result: { type: "number" } },
    required: ["result"],
  },
  execute: async ({ op, a, b }) => {
    switch (op) {
      case "add":
        return { result: a + b };
      case "subtract":
        return { result: a - b };
      case "multiply":
        return { result: a * b };
      case "divide":
        // A domain rule, not a type check: the schema cannot say "b is not 0".
        if (b === 0) throw new Error("division by zero");
        return { result: a / b };
    }
  },
};

const lookupCountry: Tool<{ code: string }, { code: string; name: string; capital: string; population: number }> = {
  description: "Look up a country by its ISO 3166-1 alpha-2 code. Knows GB, FR, JP, BR and KE.",
  inputSchema: {
    type: "object",
    properties: { code: { type: "string", description: "Two-letter country code, for example GB" } },
    required: ["code"],
  },
  outputSchema: {
    type: "object",
    properties: {
      code: { type: "string" },
      name: { type: "string" },
      capital: { type: "string" },
      population: { type: "number" },
    },
    required: ["code", "name", "capital", "population"],
  },
  execute: async (input) => {
    const code = input.code.toUpperCase();
    const country = COUNTRIES[code];
    // A domain rule: the schema allows any string, but only five codes are known.
    if (!country) throw new Error(`unknown country code ${code}`);
    return { code, ...country };
  },
};

export const demoTools: Record<string, DemoTool> = { kvGet, kvSet, kvList, calculate, lookupCountry };
