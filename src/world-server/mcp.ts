import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import type { WorldRequestHandler } from "./handler.js";
import { parseWorldJson } from "./jsonCodec.js";
import { worldMcpRequestBody, worldMcpTool, worldMcpTools } from "./mcpSchemas.js";

export interface CreateWorldMcpProtocolServerInput {
  readonly handler: WorldRequestHandler;
  readonly bearer: string;
}

const UTF8 = new TextEncoder();
const fixedError = (code: string) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ error: { code } }) }],
  isError: true,
});

const encode = (value: unknown): Uint8Array | undefined => {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? undefined : UTF8.encode(text);
  } catch { return undefined; }
};

const claimAuthority = (body: Uint8Array): string | undefined => {
  try {
    const value = parseWorldJson(body);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const token = (value as Record<string, unknown>).decision_token;
    return typeof token === "string" && token.length > 0 && token.length <= 512
      ? token
      : undefined;
  } catch { return undefined; }
};

const CLAIMED = JSON.stringify({ claimed: true });

/** Creates one protocol server for one bearer-bound Streamable HTTP session. */
export const createWorldMcpProtocolServer = (input: CreateWorldMcpProtocolServerInput): Server => {
  if (input.handler === null || typeof input.handler !== "object" || typeof input.handler.handle !== "function"
    || typeof input.bearer !== "string" || input.bearer.length === 0) {
    throw new TypeError("invalid world MCP protocol server configuration");
  }
  const server = new Server({ name: "simfile-world", version: "0.0.1" }, { capabilities: { tools: {} } });
  const tools = worldMcpTools(input.handler.operations);
  let privateAuthority: string | undefined;
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const tool = worldMcpTool(request.params.name);
    if (tool === undefined || !tools.includes(tool)) return fixedError("unknown_operation");
    const requestBody = worldMcpRequestBody(tool, request.params.arguments ?? {}, privateAuthority);
    if (requestBody === undefined) return fixedError("world_denied");
    const body = encode(requestBody);
    if (body === undefined) return fixedError("invalid_request");
    const response = input.handler.handle({ operation: tool.operation, bearer: input.bearer, body });
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(response.body); }
    catch { return fixedError("internal_error"); }
    if (tool.operation === "claim" && response.status === 200) {
      const claimedAuthority = claimAuthority(response.body);
      if (claimedAuthority === undefined) return fixedError("internal_error");
      privateAuthority = claimedAuthority;
      text = CLAIMED;
    }
    return {
      content: [{ type: "text" as const, text }],
      ...(response.status === 200 ? {} : { isError: true }),
    };
  });
  return server;
};
