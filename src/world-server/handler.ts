import { types } from "node:util";

import { encodeWorldActEnvelope } from "../world/actEnvelope.js";
import { parseWorldActionResultPageRequest, WORLD_ACTION_RESULT_PAGE_REQUEST_VERSION } from "../world/actionResultLedger.js";
import { readWorldBoundaryObserver } from "../world/boundaryObserver.js";
import { WorldRuntimeError } from "../world/ledger.js";
import type { AuthenticatedWorldContext, WorldRuntime } from "../world/runtime.js";
import { claimWorldDecision, WORLD_DECISION_CLAIM_CAPABILITY } from "../world/decisionClaim.js";
import { parseWorldJson, WorldJsonCodecError } from "./jsonCodec.js";

export const WORLD_REQUEST_OPERATIONS = Object.freeze([
  "status",
  "capabilities",
  "observe",
  "affordances",
  "act",
  "ledger",
] as const);
export const WORLD_OPTIONAL_REQUEST_OPERATIONS = Object.freeze(["claim"] as const);
export const WORLD_HANDLER_LIMITS = Object.freeze({
  bearer_code_units: 1_024,
  response_bytes: 1_048_576,
});

export type WorldRequestOperation = typeof WORLD_REQUEST_OPERATIONS[number]
  | typeof WORLD_OPTIONAL_REQUEST_OPERATIONS[number];
export type WorldHandlerErrorCode =
  | "invalid_request"
  | "request_too_large"
  | "unauthorized"
  | "world_denied"
  | "unknown_operation"
  | "internal_error";

export interface WorldHandlerRequest {
  readonly operation: string;
  readonly bearer: unknown;
  readonly body: unknown;
}
export interface WorldHandlerResponse {
  readonly status: 200 | 400 | 401 | 403 | 404 | 413 | 500;
  readonly body: Uint8Array;
}
export type WorldBearerAuthentication = Readonly<{
  readonly kind: "authorized" | "unauthorized" | "internal_error";
}>;
export type WorldBearerResolver = (bearer: string) => string | undefined;
export interface CreateWorldRequestHandlerInput {
  readonly runtime: WorldRuntime;
  readonly resolveBearer: WorldBearerResolver;
  readonly capabilities?: readonly string[];
  readonly maxResponseBytes?: number;
}
export interface WorldRequestHandler {
  readonly operations?: readonly WorldRequestOperation[];
  handle(request: WorldHandlerRequest): WorldHandlerResponse;
}
export interface WorldAuthenticatingRequestHandler extends WorldRequestHandler {
  authenticate(bearer: unknown): WorldBearerAuthentication;
}

type ResponseStatus = WorldHandlerResponse["status"];
type JsonObject = Record<string, unknown>;
class InvalidWorldRequestError extends Error {}
const UTF8 = new TextEncoder();
const CLAIM_OBSERVER_RESPONSE = UTF8.encode('{"claimed":true}');
const ERROR_STATUS: Readonly<Record<WorldHandlerErrorCode, ResponseStatus>> = Object.freeze({
  invalid_request: 400,
  request_too_large: 413,
  unauthorized: 401,
  world_denied: 403,
  unknown_operation: 404,
  internal_error: 500,
});
const operation = (value: string): value is WorldRequestOperation =>
  [...WORLD_REQUEST_OPERATIONS, ...WORLD_OPTIONAL_REQUEST_OPERATIONS].includes(value as never);
const binding = (value: unknown, maximum = 256): value is string => typeof value === "string"
  && value.length > 0 && value.length <= maximum && value === value.trim();
const bearer = (value: unknown): value is string => binding(value, WORLD_HANDLER_LIMITS.bearer_code_units)
  && !/[\u0000-\u0020\u007f]/u.test(value);
type ResolvedBearer = Readonly<{ kind: "authorized"; principal: string }>
  | Readonly<{ kind: "unauthorized" }>
  | Readonly<{ kind: "internal_error" }>;
const object = (value: unknown, allowed: readonly string[], required: readonly string[]): JsonObject | undefined => {
  try {
    if (value === null || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const keys = Object.keys(value);
    if (Reflect.ownKeys(value).length !== keys.length || keys.some((key) => !allowed.includes(key))
      || required.some((key) => !Object.hasOwn(value, key))) return undefined;
    const output: JsonObject = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
      output[key] = descriptor.value;
    }
    return output;
  } catch { return undefined; }
};
const tokenContext = (source: JsonObject, principal: string): AuthenticatedWorldContext | undefined =>
  binding(source.decision_token, 512)
    ? Object.freeze({ principal, decisionToken: source.decision_token })
    : undefined;
const invalidRequest = (): never => { throw new InvalidWorldRequestError(); };

const errorBody = (code: WorldHandlerErrorCode): Uint8Array => UTF8.encode(JSON.stringify({ error: { code } }));
const failure = (code: WorldHandlerErrorCode): WorldHandlerResponse => Object.freeze({
  status: ERROR_STATUS[code],
  body: errorBody(code),
});
const success = (value: unknown, maximum: number): WorldHandlerResponse => {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return failure("internal_error");
    const body = UTF8.encode(json);
    return body.byteLength <= maximum ? Object.freeze({ status: 200, body }) : failure("internal_error");
  } catch { return failure("internal_error"); }
};
const observerRequest = (value: unknown): Uint8Array => {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return UTF8.encode("{}");
    const safe = Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== "decision_token"));
    return UTF8.encode(JSON.stringify(safe));
  } catch { return UTF8.encode("{}"); }
};

const invoke = (runtime: WorldRuntime, operationName: WorldRequestOperation, principal: string, value: unknown): unknown => {
  if (operationName === "claim") {
    const source = object(value, ["request_id", "wake_id"], ["request_id", "wake_id"]);
    if (source === undefined || !binding(source.request_id) || !binding(source.wake_id)) return invalidRequest();
    return claimWorldDecision(runtime, principal, source);
  }
  if (operationName === "status" || operationName === "capabilities" || operationName === "affordances") {
    const source = object(value, ["decision_token"], ["decision_token"]);
    const context = source === undefined ? undefined : tokenContext(source, principal);
    if (context === undefined) return invalidRequest();
    if (operationName === "status") return runtime.status(context);
    if (operationName === "capabilities") return runtime.capabilities(context);
    return runtime.affordances(context);
  }
  if (operationName === "observe") {
    const source = object(value, ["decision_token", "sense"], ["decision_token", "sense"]);
    const context = source === undefined ? undefined : tokenContext(source, principal);
    if (source === undefined || context === undefined || !binding(source.sense)) return invalidRequest();
    return runtime.observe(context, Object.freeze({ sense: source.sense }));
  }
  if (operationName === "act") {
    const fields = ["decision_token", "request_id", "affordance", "target", "input"] as const;
    const source = object(value, fields, fields);
    const context = source === undefined ? undefined : tokenContext(source, principal);
    if (source === undefined || context === undefined) return invalidRequest();
    let envelope: Uint8Array;
    try {
      envelope = encodeWorldActEnvelope({
        request_id: source.request_id,
        affordance: source.affordance,
        target: source.target,
        input: source.input,
      });
    } catch { return invalidRequest(); }
    return runtime.act(context, envelope);
  }
  const fields = ["decision_token", "version", "limit", "result_after"] as const;
  const source = object(value, fields, ["decision_token", "version"]);
  const context = source === undefined ? undefined : tokenContext(source, principal);
  if (source === undefined || context === undefined || source.version !== WORLD_ACTION_RESULT_PAGE_REQUEST_VERSION) return invalidRequest();
  const request = parseWorldActionResultPageRequest({
    version: WORLD_ACTION_RESULT_PAGE_REQUEST_VERSION,
    ...(source.limit === undefined ? {} : { limit: source.limit }),
    ...(source.result_after === undefined ? {} : { result_after: source.result_after }),
  });
  if (request === undefined) return invalidRequest();
  return runtime.ledger(context, request);
};

export const createWorldRequestHandler = (input: CreateWorldRequestHandlerInput): WorldAuthenticatingRequestHandler => {
  const maximum = input.maxResponseBytes ?? WORLD_HANDLER_LIMITS.response_bytes;
  if (input.runtime === null || typeof input.runtime !== "object" || typeof input.resolveBearer !== "function"
    || !Number.isSafeInteger(maximum) || maximum < 128 || maximum > WORLD_HANDLER_LIMITS.response_bytes) {
    throw new TypeError("invalid world request handler configuration");
  }
  const runtime = input.runtime;
  const resolveBearer = input.resolveBearer;
  const claimEnabled = input.capabilities?.includes(WORLD_DECISION_CLAIM_CAPABILITY) ?? false;
  const operations = Object.freeze([
    ...WORLD_REQUEST_OPERATIONS,
    ...(claimEnabled ? WORLD_OPTIONAL_REQUEST_OPERATIONS : []),
  ]);
  const authenticate = (value: unknown): ResolvedBearer => {
    if (!bearer(value)) return Object.freeze({ kind: "unauthorized" });
    try {
      const principal = resolveBearer(value);
      return binding(principal)
        ? Object.freeze({ kind: "authorized", principal })
        : Object.freeze({ kind: "unauthorized" });
    } catch { return Object.freeze({ kind: "internal_error" }); }
  };
  return Object.freeze({
    operations,
    authenticate: (value: unknown): WorldBearerAuthentication => {
      const result = authenticate(value);
      return Object.freeze({ kind: result.kind });
    },
    handle: (request: WorldHandlerRequest): WorldHandlerResponse => {
      const source = object(request, ["operation", "bearer", "body"], ["operation", "bearer", "body"]);
      if (source === undefined) return failure("invalid_request");
      if (typeof source.operation !== "string" || !operation(source.operation)) return failure("unknown_operation");
      if (!operations.includes(source.operation)) return failure("unknown_operation");
      const authentication = authenticate(source.bearer);
      if (authentication.kind === "internal_error") return failure("internal_error");
      if (authentication.kind === "unauthorized") return failure("unauthorized");
      let value: unknown;
      try { value = parseWorldJson(source.body); } catch (error) {
        if (error instanceof WorldJsonCodecError && error.code === "world_json_too_large") return failure("request_too_large");
        return failure("invalid_request");
      }
      let reservation;
      try {
        reservation = readWorldBoundaryObserver(runtime)?.begin({
          operation: source.operation,
          principal: authentication.principal,
          request: observerRequest(value),
        });
      } catch { return failure("internal_error"); }
      let response: WorldHandlerResponse;
      try { response = success(invoke(runtime, source.operation, authentication.principal, value), maximum); } catch (error) {
        if (error instanceof WorldRuntimeError && error.code === "world_runtime_denied") response = failure("world_denied");
        else if (error instanceof InvalidWorldRequestError) response = failure("invalid_request");
        else response = failure("internal_error");
      }
      try { reservation?.complete({ status: response.status,
        response: source.operation === "claim" && response.status === 200
          ? CLAIM_OBSERVER_RESPONSE : response.body }); }
      catch { return failure("internal_error"); }
      return response;
    },
  });
};
