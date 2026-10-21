import { z } from "zod";
import { Household, SetupHouseholdInput } from "./household";

/** Topics a change notice can name; clients refetch the matching tools. */
export const ChangeTopic = z.enum(["household"]);
export type ChangeTopic = z.infer<typeof ChangeTopic>;

type ToolDefinition = {
  input: z.ZodType;
  output: z.ZodType;
  /** The topic a successful call changes; absent for read-only tools. */
  changes?: ChangeTopic;
};

function defineTool<const T extends ToolDefinition>(definition: T): T {
  return definition;
}

/** Every tool Mise exposes. The PWA, the agent and any coordinator call these and nothing else. */
export const tools = {
  setup_household: defineTool({
    input: SetupHouseholdInput,
    output: Household,
    changes: "household",
  }),
  get_household: defineTool({
    input: z.object({}).strict(),
    output: Household.nullable(),
  }),
};

export type Tools = typeof tools;
export type ToolName = keyof Tools;
/** What a caller passes: defaulted fields may be omitted. */
export type ToolInput<N extends ToolName> = z.input<Tools[N]["input"]>;
/** What a handler receives once the input is validated and defaulted. */
export type ParsedToolInput<N extends ToolName> = z.output<Tools[N]["input"]>;
export type ToolOutput<N extends ToolName> = z.output<Tools[N]["output"]>;

export type ToolErrorCode = "unknown_tool" | "invalid_input" | "already_set_up";

export type ToolError = {
  code: ToolErrorCode;
  message: string;
  issues?: { path: string; message: string }[];
};

export type ToolResult<T> = { ok: true; value: T } | { ok: false; error: ToolError };

/** The topic a successful call to this tool changes, if it changes anything. */
export function changeTopicOf(name: ToolName): ChangeTopic | undefined {
  const definition: ToolDefinition = tools[name];
  return definition.changes;
}

export function isToolName(name: unknown): name is ToolName {
  return typeof name === "string" && Object.hasOwn(tools, name);
}

export function parseToolInput<N extends ToolName>(name: N, input: unknown): ToolResult<ParsedToolInput<N>>;
export function parseToolInput(name: string, input: unknown): ToolResult<unknown>;
export function parseToolInput(name: string, input: unknown): ToolResult<unknown> {
  if (!isToolName(name)) {
    return { ok: false, error: { code: "unknown_tool", message: `Unknown tool: ${name}` } };
  }
  const parsed = tools[name].input.safeParse(input ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: `Invalid input for ${name}`,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    };
  }
  return { ok: true, value: parsed.data };
}

/** Broadcast to every connected client after a mutation; clients refetch through tools. */
export const ChangeNotice = z.object({
  type: z.literal("mise:change"),
  topic: ChangeTopic,
  revision: z.number().int().nonnegative(),
});
export type ChangeNotice = z.infer<typeof ChangeNotice>;
