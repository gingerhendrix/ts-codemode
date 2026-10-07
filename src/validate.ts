// Run-time input checks from each tool's JSON Schema, as stock codemode does
// (the AI SDK path wraps execute in schema.validate). Both modes use them. The
// type gate finds input and output mistakes before anything runs. This check is
// the second line for inputs that reach a tool in spite of the types, for example
// through `as any` or a value from JSON.parse.
import type { DemoTool } from "./tools";

type Schema = {
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
};

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** The first schema violation in `value`, or undefined. Covers the keywords that the demo tools use. */
export function firstIssue(schema: Schema, value: unknown, path = "input"): string | undefined {
  if (schema.enum && !schema.enum.includes(value)) {
    return `${path} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.includes(typeOf(value))) return `${path} must be ${types.join(" or ")}, got ${typeOf(value)}`;
  }
  if (schema.properties && typeOf(value) === "object") {
    const object = value as Record<string, unknown>;
    for (const name of schema.required ?? []) {
      if (!(name in object)) return `${path}.${name} is required`;
    }
    for (const [name, child] of Object.entries(schema.properties)) {
      if (!(name in object)) continue;
      const issue = firstIssue(child, object[name], `${path}.${name}`);
      if (issue) return issue;
    }
  }
  if (schema.items && Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const issue = firstIssue(schema.items, item, `${path}[${index}]`);
      if (issue) return issue;
    }
  }
  return undefined;
}

/** The same tools, each with a run-time input check in front of execute. */
export function withInputValidation(tools: Record<string, DemoTool>): Record<string, DemoTool> {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [
      name,
      {
        ...tool,
        execute: async (input: unknown) => {
          const issue = firstIssue(tool.inputSchema as Schema, input);
          if (issue) throw new Error(`Invalid input for ${name}: ${issue}`);
          return tool.execute(input);
        },
      },
    ]),
  );
}
