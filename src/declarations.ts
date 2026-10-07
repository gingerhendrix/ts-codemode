// The declarations that the model sees and that the type gate checks against.
// Cloudflare codemode generates the tool types. We add the few sandbox globals
// that lib es2022 does not have.
import { generateTypesFromJsonSchema } from "@cloudflare/codemode";
import { demoTools } from "./tools";

// The Dynamic Worker captures console output into `logs`. Lib es2022 has no
// `console`, so declare the part that the sandbox supports.
const SANDBOX_GLOBALS = `declare const console: {
  log(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
};`;

export const TOOL_TYPES = generateTypesFromJsonSchema(demoTools);

/** The contents of `tools.d.ts` in the type gate. */
export const TOOLS_DTS = `${TOOL_TYPES}\n\n${SANDBOX_GLOBALS}\n`;

const DESCRIPTION = `Execute TypeScript to achieve a goal.

The code is type-checked against the declarations below before it runs. If the check finds errors, the code does not run and you get the errors with line and column numbers in your code.

Available:
{{types}}

Write the body of an async function in TypeScript. Use await at the top level and return the result.
Type annotations, interfaces, type aliases, generics, enums and satisfies are allowed.
Do not use import or export. There is no network access, so fetch is not available.

Example:
interface Total { label: string; value: number }
const r = await codemode.calculate({ op: "add", a: 1, b: 2 });
return { label: "sum", value: r.result } satisfies Total;`;

/** A model-facing tool definition: name, description with the types, and input schema. */
export function describeCodeTool() {
  return {
    name: "codemode",
    description: DESCRIPTION.replace("{{types}}", TOOLS_DTS),
    inputSchema: {
      type: "object",
      properties: { code: { type: "string", description: "TypeScript: the body of an async function" } },
      required: ["code"],
    },
    types: TOOLS_DTS,
  };
}
