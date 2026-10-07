// Demo tools on the host. They are deterministic and each one has an input and an
// output JSON Schema, so the generated declarations are typed in both directions.
import type { JsonSchemaToolDescriptor } from "@cloudflare/codemode";

export type DemoTool = JsonSchemaToolDescriptor & {
  execute: (input: any) => Promise<unknown>;
};

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

// The type gate checks the model's code, but code can still pass `as any` values.
// These checks keep the tools honest at run time.
function str(input: any, field: string): string {
  const value = input?.[field];
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function num(input: any, field: string): number {
  const value = input?.[field];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} must be a finite number`);
  return value;
}

export const demoTools: Record<string, DemoTool> = {
  kvGet: {
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
    execute: async (input) => {
      const key = str(input, "key");
      const value = store.get(key);
      return { key, found: value !== undefined, value: value ?? null };
    },
  },
  kvSet: {
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
    execute: async (input) => {
      const key = str(input, "key");
      const value = str(input, "value");
      const previous = store.get(key) ?? null;
      store.set(key, value);
      return { key, previous };
    },
  },
  kvList: {
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
    execute: async (input) => {
      const prefix = typeof input?.prefix === "string" ? input.prefix : "";
      return { keys: [...store.keys()].filter((key) => key.startsWith(prefix)).sort() };
    },
  },
  calculate: {
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
    execute: async (input) => {
      const a = num(input, "a");
      const b = num(input, "b");
      switch (input.op) {
        case "add":
          return { result: a + b };
        case "subtract":
          return { result: a - b };
        case "multiply":
          return { result: a * b };
        case "divide":
          if (b === 0) throw new Error("division by zero");
          return { result: a / b };
        default:
          throw new Error(`unknown op ${JSON.stringify(input.op)}`);
      }
    },
  },
  lookupCountry: {
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
      const code = str(input, "code").toUpperCase();
      const country = COUNTRIES[code];
      if (!country) throw new Error(`unknown country code ${code}`);
      return { code, ...country };
    },
  },
};
