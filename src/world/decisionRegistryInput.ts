import { Buffer } from "node:buffer";
import { copySafeUint8Array, isDecisionRegistryBinding, isDecisionRegistryTick, readDataObject } from "./decisionRegistrySnapshot.js";
import type { DecisionAdmissionRequest, DecisionMintRequest, DecisionRegistryConfig } from "./decisionRegistry.js";

const TOKEN_BYTES = 32;
export const parseDecisionRegistryConfig = (input: unknown): DecisionRegistryConfig | undefined => {
  const value = readDataObject(input, ["runId", "worldInstanceId", "tokenDigestKey"]); const key = value?.tokenDigestKey; const copy = copySafeUint8Array(key);
  return value === undefined || !isDecisionRegistryBinding(value.runId) || !isDecisionRegistryBinding(value.worldInstanceId) || copy === undefined || copy.byteLength < TOKEN_BYTES
    ? undefined : { runId: value.runId, worldInstanceId: value.worldInstanceId, tokenDigestKey: copy };
};
export const parseDecisionMintRequest = (input: unknown): DecisionMintRequest | undefined => {
  const value = readDataObject(input, ["principal", "issuedTick", "validThroughTick"]);
  return value === undefined || !isDecisionRegistryBinding(value.principal) || !isDecisionRegistryTick(value.issuedTick) || !isDecisionRegistryTick(value.validThroughTick) || value.validThroughTick < value.issuedTick
    ? undefined : { principal: value.principal, issuedTick: value.issuedTick, validThroughTick: value.validThroughTick };
};
export const parseDecisionAdmissionRequest = (input: unknown): DecisionAdmissionRequest | undefined => {
  const value = readDataObject(input, ["principal", "runId", "worldInstanceId", "token", "atTick"]);
  return value === undefined || !isDecisionRegistryBinding(value.principal) || !isDecisionRegistryBinding(value.runId) || !isDecisionRegistryBinding(value.worldInstanceId) || !isCanonicalDecisionToken(value.token) || !isDecisionRegistryTick(value.atTick)
    ? undefined : { principal: value.principal, runId: value.runId, worldInstanceId: value.worldInstanceId, token: value.token, atTick: value.atTick };
};
export const isCanonicalDecisionToken = (input: unknown): input is string => typeof input === "string" && /^[A-Za-z0-9_-]{43}$/.test(input) && Buffer.from(input, "base64url").byteLength === TOKEN_BYTES && Buffer.from(input, "base64url").toString("base64url") === input;
