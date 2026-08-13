import {
  WORLD_ACTION_RESULT_CURSOR_VERSION,
  WORLD_ACTION_RESULT_PAGE_REQUEST_VERSION,
} from "../world/actionResultLedger.js";
import type { WorldRequestOperation } from "./handler.js";

export const WORLD_MCP_TOOL_NAMES = Object.freeze([
  "world_status",
  "world_capabilities",
  "world_observe",
  "world_affordances",
  "world_act",
  "world_ledger",
] as const);
export const WORLD_OPTIONAL_MCP_TOOL_NAMES = Object.freeze(["world_claim"] as const);

export type WorldMcpToolName = typeof WORLD_MCP_TOOL_NAMES[number]
  | typeof WORLD_OPTIONAL_MCP_TOOL_NAMES[number];
export interface WorldMcpToolDescriptor {
  readonly name: WorldMcpToolName;
  readonly operation: WorldRequestOperation;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

const binding = (description: string): Readonly<Record<string, unknown>> => Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 256,
  description,
});
const schema = (
  properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  required: readonly string[],
): Readonly<Record<string, unknown>> => Object.freeze({
  type: "object",
  properties: Object.freeze({ ...properties }),
  required: Object.freeze([...required]),
  additionalProperties: false,
});

const noArguments = schema({}, []);
const cursor = schema({
  version: Object.freeze({ const: WORLD_ACTION_RESULT_CURSOR_VERSION }),
  issuer: Object.freeze({ type: "string", pattern: "^[a-f0-9]{32}$" }),
  principal: binding("Bearer-derived world principal."),
  run_id: binding("World run identity."),
  world_id: binding("World identity."),
  world_instance_id: binding("World instance identity."),
  manifest_digest: Object.freeze({ type: "string", pattern: "^sha256:[a-f0-9]{64}$" }),
  after: Object.freeze({ type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  proof: Object.freeze({ type: "string", pattern: "^[a-f0-9]{64}$" }),
}, ["version", "issuer", "principal", "run_id", "world_id", "world_instance_id", "manifest_digest", "after", "proof"]);
const descriptors: readonly WorldMcpToolDescriptor[] = [
  {
    name: "world_claim",
    operation: "claim",
    description: "Claim turn-local world decision authority for the authenticated principal.",
    inputSchema: schema({
      request_id: binding("Unique claim request identity."),
      wake_id: binding("Organization-owned wake identity."),
    }, ["request_id", "wake_id"]),
  },
  {
    name: "world_status",
    operation: "status",
    description: "Read authenticated world orientation and decision status.",
    inputSchema: noArguments,
  },
  {
    name: "world_capabilities",
    operation: "capabilities",
    description: "Read the authenticated caller's world capability manifest.",
    inputSchema: noArguments,
  },
  {
    name: "world_observe",
    operation: "observe",
    description: "Invoke one granted world sense against current state.",
    inputSchema: schema({
      sense: binding("Granted world sense address."),
    }, ["sense"]),
  },
  {
    name: "world_affordances",
    operation: "affordances",
    description: "List currently available granted world actions.",
    inputSchema: noArguments,
  },
  {
    name: "world_act",
    operation: "act",
    description: "Attempt one world affordance with a stable request id.",
    inputSchema: schema({
      request_id: binding("Stable caller-generated id reused only for an exact retry."),
      affordance: binding("Granted world affordance address."),
      target: binding("World target entity address."),
      input: Object.freeze({ description: "Typed input declared by the selected affordance." }),
    }, ["request_id", "affordance", "target", "input"]),
  },
  {
    name: "world_ledger",
    operation: "ledger",
    description: "Read authenticated terminal action results.",
    inputSchema: schema({
      limit: Object.freeze({ type: "integer", minimum: 1, maximum: 100 }),
      result_after: cursor,
    }, []),
  },
];

const allTools = Object.freeze(descriptors.map((item) => Object.freeze(item)));
export const WORLD_MCP_TOOLS = Object.freeze(allTools.filter((item) => item.operation !== "claim"));

export const worldMcpTools = (
  operations: readonly WorldRequestOperation[] | undefined,
): readonly WorldMcpToolDescriptor[] => operations?.includes("claim")
  ? allTools
  : WORLD_MCP_TOOLS;

export const worldMcpTool = (name: string): WorldMcpToolDescriptor | undefined =>
  allTools.find((item) => item.name === name);

export const worldMcpRequestBody = (
  tool: WorldMcpToolDescriptor,
  value: unknown,
  privateAuthority: string | undefined,
): unknown | undefined => {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    if (Object.hasOwn(value, "decision_token") || Object.hasOwn(value, "version")) return undefined;
    if (tool.operation === "claim") return value;
    if (privateAuthority === undefined) return undefined;
    return {
      ...value,
      decision_token: privateAuthority,
      ...(tool.operation === "ledger" ? { version: WORLD_ACTION_RESULT_PAGE_REQUEST_VERSION } : {}),
    };
  } catch { return undefined; }
};
