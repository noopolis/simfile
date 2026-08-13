import { z } from "zod";

import { assertSecretFreeComposedJson, digestComposedJson } from "./json.js";

export const composedDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const composedRunIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
export const composedHandleSchema = z.string().regex(/^opaque_[a-z0-9]{16,64}$/u);
export const composedIdentifierSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);

export const sealComposedContract = <Value extends Record<string, unknown>>(
  version: string,
  body: Value,
): Value & { receipt_digest: `sha256:${string}` } => ({
  ...body,
  receipt_digest: digestComposedJson(version, body),
});

export const parseComposedDigestedContract = <Value extends { receipt_digest: string }>(
  raw: unknown,
  schema: z.ZodType<Value>,
  version: string,
  label: string,
): Value => {
  assertSecretFreeComposedJson(raw);
  const value = schema.parse(raw);
  const { receipt_digest: _receiptDigest, ...body } = value;
  if (value.receipt_digest !== digestComposedJson(version, body)) {
    throw new TypeError(`${label} digest is invalid`);
  }
  return Object.freeze(value);
};
