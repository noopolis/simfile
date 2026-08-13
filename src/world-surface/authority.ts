import type { ReadonlyDynamicsJsonValue } from "../dynamics/types.js";
import type { BoundedJsonSchemaNode } from "./types.js";

const WORLD_HOST_AUTHORITY_FIELDS = new Set([
  "act_id",
  "action",
  "action_id",
  "actor",
  "application_sequence",
  "application_tick",
  "apply_tick",
  "at_tick",
  "authorization",
  "bearer",
  "decision_id",
  "decision_token",
  "event_sequence",
  "grants",
  "holder",
  "manifest_digest",
  "observation_id",
  "observed_tick",
  "observer",
  "origin",
  "organization_principal",
  "principal",
  "principal_id",
  "provenance",
  "receipt_sequence",
  "receipt_tick",
  "request_id",
  "run_id",
  "sequence",
  "state_version",
  "target",
  "tick",
  "token",
  "world",
  "world_entity",
  "world_id",
  "world_instance_id"
]);

const WORLD_ACTION_AUTHORITY_FIELDS = new Set([
  ...WORLD_HOST_AUTHORITY_FIELDS,
  "entity"
]);

const assertPublicFieldName = (
  key: string,
  path: string,
  reservedFields: ReadonlySet<string> = WORLD_HOST_AUTHORITY_FIELDS
): void => {
  if (reservedFields.has(key)) {
    throw new TypeError(`${path}.${key} is reserved for host authority`);
  }
};

export const assertNoWorldAuthorityFields = (
  value: ReadonlyDynamicsJsonValue,
  path: string
): void => {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoWorldAuthorityFields(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    assertPublicFieldName(key, path);
    assertNoWorldAuthorityFields(child, `${path}.${key}`);
  }
};

export const assertNoWorldAuthoritySchemaFields = (
  schema: BoundedJsonSchemaNode,
  path: string
): void => {
  assertNoWorldAuthoritySchemaFieldsWithReservedFields(
    schema,
    path,
    WORLD_HOST_AUTHORITY_FIELDS
  );
};

const assertNoWorldAuthoritySchemaFieldsWithReservedFields = (
  schema: BoundedJsonSchemaNode,
  path: string,
  reservedFields: ReadonlySet<string>
): void => {
  if (schema.type === "array") {
    assertNoWorldAuthoritySchemaFieldsWithReservedFields(
      schema.items,
      `${path}.items`,
      reservedFields
    );
    return;
  }
  if (schema.type !== "object") return;
  for (const [key, child] of Object.entries(schema.properties)) {
    assertPublicFieldName(key, `${path}.properties`, reservedFields);
    assertNoWorldAuthoritySchemaFieldsWithReservedFields(
      child,
      `${path}.properties.${key}`,
      reservedFields
    );
  }
};

export const assertNoWorldActionSchemaAuthorityFields = (
  schema: BoundedJsonSchemaNode,
  path: string
): void => {
  assertNoWorldAuthoritySchemaFieldsWithReservedFields(
    schema,
    path,
    WORLD_ACTION_AUTHORITY_FIELDS
  );
};
